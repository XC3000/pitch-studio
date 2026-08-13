/**
 * Whole-deck generation (create-with-a-brief flow):
 *
 *   mark-generating → extract (OCR/parse every uploaded doc, cache text)
 *   → draft (one large LLM call: motive + N scenes) → write-scenes → finish.
 *
 * Grounding is the full extracted document text (truncated to a token budget),
 * NOT RAG retrieval — higher fidelity for a first draft and no wait on embeddings.
 * RAG ingestion (chunk+embed) runs independently from each doc's ragEnabled toggle.
 *
 * Progress is polled by the Scene Builder via presentations.settings.generation.
 */

import { NonRetriableError } from "inngest";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { estimateTokens } from "@/lib/chunking";
import { chatComplete, llmConfigured, QA_MODEL } from "@/lib/llm";
import { parseDocument } from "@/lib/parse-doc";
import { getDocBytes } from "@/lib/r2";
import { CUE_SCHEMAS } from "@/viewer/cue-schemas";
import { DEFAULT_CUE_POS, DEFAULT_METRICS_POS, type ScenePos } from "@/viewer/types";
import { presentationGenerateEvent, inngest } from "../client";

/** Cap the corpus we hand the model so a big upload can't blow the context. */
const MAX_CORPUS_TOKENS = 50_000;
const MIN_SCENES = 5;
const MAX_SCENES = 9;
/** Focus metric cards per scene — enough to fill the stage, few enough to read. */
const MAX_METRICS_PER_SCENE = 3;
/** Extra visual templates beyond the primary one — keep the stage readable. */
const MAX_EXTRA_VISUALS_PER_SCENE = 2;
const MAX_SUGGESTED_QUESTIONS = 5;

/** The 1440×810 stage; elements are anchored top-center. The presenter occupies
 *  the bottom-center, so generated placements should stay in the upper band. */
const STAGE_W = 1440;
const STAGE_H = 810;
const SCALE_MIN = 0.4;
const SCALE_MAX = 2.5;

type GenPos = { x?: unknown; y?: unknown; scale?: unknown } | null | undefined;

type GenMetric = {
  label?: string;
  sublabel?: string;
  value?: number | null;
  style?: "number" | "percent" | "rating" | "duration" | "literal";
  suffix?: string;
  decimals?: number;
  unit?: string;
  prefix?: string;
  outOf?: number;
  text?: string;
};

/** A visual template placed on a scene beyond the primary one. */
type GenExtraVisual = {
  template?: string;
  cue?: Record<string, unknown>;
  pos?: GenPos;
};

/** Optional per-scene free placement the model may emit; omitted → clean default. */
type GenLayout = {
  cue?: GenPos;
  metrics?: GenPos;
  /** per-metric override, indexing into this scene's `metrics` array. */
  metricPlacements?: { index?: unknown; pos?: GenPos }[];
};

type GenScene = {
  name?: string;
  intent?: string;
  /** primary visual template key (built-in or an org generated template). */
  template?: string;
  /** legacy alias for `template` — tolerated if a model still emits it. */
  templateKey?: string;
  title?: string;
  subtitle?: string;
  script?: string;
  cue?: Record<string, unknown>;
  metrics?: GenMetric[];
  layout?: GenLayout;
  extraVisuals?: GenExtraVisual[];
};

type BuiltMetric = {
  key: string;
  label: string;
  sublabel: string | null;
  rawValue: string | null;
  format: Record<string, unknown>;
};

const clampInt = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined;
const clampFloat = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/**
 * Turn a model-proposed position into a safe on-stage ScenePos, clamped to the
 * 1440×810 canvas (with margins) and a sane scale range. Missing x/y fall back
 * to `dflt`; returns null only when the model gave nothing at all.
 */
function sanitizePos(p: GenPos, dflt: ScenePos): ScenePos | null {
  if (!p || typeof p !== "object") return null;
  const x = clampInt((p as { x?: unknown }).x, 60, STAGE_W - 60);
  const y = clampInt((p as { y?: unknown }).y, 0, STAGE_H - 90);
  const scale = clampFloat((p as { scale?: unknown }).scale, SCALE_MIN, SCALE_MAX);
  if (x === undefined && y === undefined && scale === undefined) return null;
  const pos: ScenePos = { x: x ?? dflt.x, y: y ?? dflt.y };
  if (scale !== undefined) pos.scale = scale;
  return pos;
}

/**
 * Turn a model-proposed metric into a metricLibraryItems row (grounded + placeholder
 * policy). A numeric `value` → a real, count-up metric in the chosen style; a null/
 * missing value → a literal "—" placeholder card the user fills in later. Returns null
 * for un-usable input (no label). `format` omits undefined fields so it stays clean JSON.
 */
function buildMetric(m: GenMetric): BuiltMetric | null {
  const label = (m.label ?? "").toString().trim().slice(0, 40);
  if (!label) return null;
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!key) return null;
  const sublabel = str(m.sublabel, 60) ?? null;
  const hasValue = typeof m.value === "number" && Number.isFinite(m.value);

  let format: Record<string, unknown>;
  let rawValue: string | null = null;
  if (!hasValue) {
    // placeholder → literal dash, user fills in a real figure during refinement
    format = { style: "literal", text: str(m.text, 12) ?? "—" };
  } else {
    rawValue = String(m.value);
    switch (m.style) {
      case "percent":
        format = { style: "percent", decimals: clampInt(m.decimals, 0, 3) };
        break;
      case "rating":
        format = { style: "rating", outOf: clampInt(m.outOf, 1, 10) ?? 5, decimals: clampInt(m.decimals, 0, 2) };
        break;
      case "duration":
        format = { style: "duration", prefix: str(m.prefix, 8), unit: str(m.unit, 12) };
        break;
      case "literal":
        format = { style: "literal", text: str(m.text, 16) ?? String(m.value) };
        break;
      default:
        format = { style: "number", suffix: str(m.suffix, 8), decimals: clampInt(m.decimals, 0, 3) };
    }
  }
  // drop undefined so the stored JSON stays tidy
  for (const k of Object.keys(format)) if (format[k] === undefined) delete format[k];
  return { key, label, sublabel, rawValue, format };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

function slugKey(name: string, i: number): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || `scene-${i + 1}`;
}

function estimate(script: string): { words: number; seconds: number } {
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  return { words, seconds: Math.max(6, Math.round(words * 0.4)) };
}

/** Merge a patch into presentations.settings (read-modify-write; neon-http has no tx). */
async function patchSettings(presentationId: string, patch: Record<string, unknown>) {
  const db = systemDb();
  const [row] = await db
    .select({ settings: schema.presentations.settings })
    .from(schema.presentations)
    .where(eq(schema.presentations.id, presentationId));
  const settings = { ...((row?.settings as Record<string, unknown>) ?? {}), ...patch };
  await db
    .update(schema.presentations)
    .set({ settings })
    .where(eq(schema.presentations.id, presentationId));
}

export const generatePresentation = inngest.createFunction(
  {
    id: "generate-presentation",
    retries: 1,
    triggers: [presentationGenerateEvent],
    onFailure: async ({ event }) => {
      const { presentationId } = event.data.event.data;
      const message = event.data.error.message ?? "generation failed";
      await patchSettings(presentationId, {
        generation: { status: "failed", error: message.slice(0, 500), at: new Date().toISOString() },
      });
    },
  },
  async ({ event, step }) => {
    const { orgId, presentationId, brief, documentIds } = event.data;
    const db = systemDb();

    await step.run("mark-generating", async () => {
      const [pres] = await db
        .select({ id: schema.presentations.id, orgId: schema.presentations.orgId })
        .from(schema.presentations)
        .where(eq(schema.presentations.id, presentationId));
      if (!pres || pres.orgId !== orgId) throw new NonRetriableError("presentation not found in org");
      if (!llmConfigured()) throw new NonRetriableError("LLM not configured — cannot generate deck");
      await patchSettings(presentationId, {
        generation: { status: "generating", at: new Date().toISOString() },
      });
    });

    // Extract every uploaded doc's text (reuse cache; OCR scanned PDFs via parseDocument).
    const corpus = await step.run("extract", async () => {
      const parts: string[] = [];
      let tokens = 0;
      for (const docId of documentIds) {
        if (tokens >= MAX_CORPUS_TOKENS) break;
        const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
        if (!doc || doc.orgId !== orgId) continue;

        let text = doc.extractedText ?? "";
        if (!text.trim()) {
          try {
            const bytes = await getDocBytes(doc.r2Key);
            const parsed = await parseDocument(bytes, doc.mime, doc.filename);
            text = parsed.blocks.map((b) => b.text).join("\n\n");
            if (text.trim()) {
              await db
                .update(schema.documents)
                .set({ extractedText: text })
                .where(eq(schema.documents.id, docId));
            }
          } catch {
            // a single unreadable doc shouldn't sink the whole draft
            continue;
          }
        }
        if (!text.trim()) continue;
        const budget = (MAX_CORPUS_TOKENS - tokens) * 4; // ~4 chars/token
        const slice = text.slice(0, budget);
        parts.push(`### ${doc.filename}\n${slice}`);
        tokens += estimateTokens(slice);
      }
      return parts.join("\n\n---\n\n");
    });

    // The visuals the model may choose from: built-ins + this org's own
    // generated (custom) templates. Feeds both the prompt and key→id resolution.
    const catalog = await step.run("load-templates", async () => {
      const rows = await db
        .select({
          id: schema.visualTemplates.id,
          key: schema.visualTemplates.key,
          name: schema.visualTemplates.name,
          source: schema.visualTemplates.source,
          spec: schema.visualTemplates.spec,
        })
        .from(schema.visualTemplates)
        .where(
          or(
            isNull(schema.visualTemplates.orgId),
            and(eq(schema.visualTemplates.orgId, orgId), eq(schema.visualTemplates.source, "generated")),
          ),
        )
        .orderBy(asc(schema.visualTemplates.key));
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        source: r.source,
        params:
          r.source === "generated"
            ? (((r.spec ?? {}) as { paramSchema?: { name: string; type: string; label?: string }[] }).paramSchema ?? [])
                .map((p) => ({ name: p.name, type: p.type, label: p.label ?? "" }))
            : null,
      }));
    });

    const draft = await step.run("draft", async () => {
      const builtinCatalog = catalog
        .filter((t) => t.source !== "generated" && CUE_SCHEMAS[t.key])
        .map((t) => {
          const s = CUE_SCHEMAS[t.key];
          const fields = s.fields.map((f) => `${f.name} (${f.type})`).join(", ");
          return `- "${t.key}" — ${s.summary}\n    params: ${fields}\n    example cue: ${JSON.stringify(s.example)}`;
        })
        .join("\n");
      const generatedCatalog = catalog
        .filter((t) => t.source === "generated")
        .map((t) => {
          const fields = (t.params ?? [])
            .map((p) => `${p.name} (${p.type})${p.label ? ` — ${p.label}` : ""}`)
            .join(", ");
          return `- "${t.key}" — ${t.name} (custom). params: ${fields || "none"}`;
        })
        .join("\n");

      const system = [
        "You are a senior scriptwriter and pitch strategist building a B2B sales presentation delivered by an on-screen avatar presenter.",
        "Design a coherent narrative arc, then write each scene for the spoken word: warm, confident, concrete, no marketing fluff, no bullet lists in the script.",
        `Produce ${MIN_SCENES}-${MAX_SCENES} scenes. Each scene's script runs ~12-18 seconds (roughly 30-55 spoken words).`,
        "Never invent specific statistics. Use figures ONLY if they appear in the brief or the supporting documents; otherwise speak qualitatively.",
        "── VISUAL TEMPLATES ──",
        'Choose the primary visual per scene with "template" (the exact key below, or null for a plain scene). The "cue" object MUST match that template\'s params — copy the shape from its example.',
        `BUILT-IN VISUALS:\n${builtinCatalog}`,
        generatedCatalog
          ? `CUSTOM VISUALS already made for this org (prefer these when they fit — they were designed for this material):\n${generatedCatalog}`
          : "",
        "── METRICS ──",
        `Give EACH scene a "metrics" array of 1-${MAX_METRICS_PER_SCENE} focus figures — these render as animated number cards and keep the deck from feeling bland, so every scene should have at least one.`,
        'Ground every number in the brief or documents. NEVER invent a statistic. If a scene should show a figure but you have no real number for it, STILL include the metric with "value": null — a placeholder the user will fill in — and make its "label"/"sublabel" clearly describe what number belongs there.',
        'Each metric: { "label": "≤22 chars, ALL-CAPS-ish headline", "sublabel": "short context or null", "value": number-or-null, "style": "number|percent|rating|duration|literal", plus style fields: number→{suffix?,decimals?}, percent→{decimals?}, rating→{outOf?,decimals?}, duration→{prefix?,unit?}, literal→{text}. Use "value" as the plain number (e.g. 96 for 96%, 4.7 for a rating); style formats it.',
        "── PLACEMENT (optional) ──",
        `The clean centered default looks great — OMIT "layout" and "extraVisuals" for most scenes. Only use them when a scene genuinely benefits (e.g. a stat card beside a flow).`,
        `The stage is ${STAGE_W}×${STAGE_H}px. Every element is anchored by its TOP-CENTER: "x" is its horizontal center, "y" its top edge; "scale" (${SCALE_MIN}-${SCALE_MAX}, default 1) resizes it. The presenter stands at the BOTTOM-CENTER — keep visuals in the upper band (y ≈ 60-360) and out of the dead-center-bottom.`,
        `Defaults: primary visual {x:${DEFAULT_CUE_POS.x}, y:${DEFAULT_CUE_POS.y}}, metric row {x:${DEFAULT_METRICS_POS.x}, y:${DEFAULT_METRICS_POS.y}}. To show TWO visuals side by side, place one left (x≈420) and one right (x≈1020), both y≈150, scale≈0.8, so they don't overlap.`,
        `A scene may carry up to ${MAX_EXTRA_VISUALS_PER_SCENE} "extraVisuals" (each its own template + cue + pos), on top of the primary. When you add any, position ALL visuals via "layout"/"pos" so nothing overlaps.`,
        "── DECK-LEVEL ──",
        `Also write: "suggestedQuestions" (3-${MAX_SUGGESTED_QUESTIONS} questions a real prospect would ask, answerable from the material), "endingCaption" (one warm closing line), and "appendix" {headline, intro} for the evidence view.`,
        "Return ONLY a JSON object, no prose, with this shape:",
        `{
  "motive": "one-paragraph narrative arc for the whole deck",
  "suggestedQuestions": ["…", "…"],
  "endingCaption": "…",
  "appendix": { "headline": "…", "intro": "…" },
  "scenes": [ {
    "name": "short label", "intent": "what this scene lands",
    "template": "pillars|journey|…|<custom key>|null",
    "title": "≤6 words", "subtitle": "one line", "script": "the spoken words",
    "cue": { },
    "metrics": [ { "label": "HOSPITALS", "sublabel": "across the UAE", "value": 340, "style": "number" } ],
    "layout": { "cue": {"x":720,"y":132,"scale":1}, "metrics": {"x":720,"y":346}, "metricPlacements": [ {"index":0,"pos":{"x":400,"y":150}} ] },
    "extraVisuals": [ { "template": "rating", "cue": { }, "pos": {"x":1020,"y":150,"scale":0.8} } ]
  } ]
}`,
      ]
        .filter(Boolean)
        .join("\n");

      const user = [
        `Presentation brief:\n${brief.trim() || "(no brief provided)"}`,
        corpus.trim()
          ? `\nSupporting documents (source material — ground the deck in these):\n${corpus}`
          : "\n(No supporting documents were provided — draft from the brief alone.)",
        "\nWrite the full deck now as a single JSON object.",
      ].join("\n");

      const res = await chatComplete({ model: QA_MODEL, system, userContent: user, maxTokens: 6000 });
      const parsed = extractJson(res.text) as {
        motive?: string;
        suggestedQuestions?: unknown;
        endingCaption?: unknown;
        appendix?: { headline?: unknown; intro?: unknown };
        scenes?: GenScene[];
      };
      const suggestedQuestions = Array.isArray(parsed.suggestedQuestions)
        ? parsed.suggestedQuestions
            .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
            .map((q) => q.trim().slice(0, 160))
            .slice(0, MAX_SUGGESTED_QUESTIONS)
        : [];
      return {
        motive: (parsed.motive ?? "").toString(),
        suggestedQuestions,
        endingCaption: str(parsed.endingCaption, 200) ?? "",
        appendixHeadline: str(parsed.appendix?.headline, 160) ?? "",
        appendixIntro: str(parsed.appendix?.intro, 400) ?? "",
        scenes: Array.isArray(parsed.scenes) ? parsed.scenes.slice(0, MAX_SCENES) : [],
        costUsd: res.usage.costUsd,
        tokens: res.usage.inputTokens + res.usage.outputTokens,
        model: res.model,
      };
    });

    const written = await step.run("write-scenes", async () => {
      if (draft.scenes.length === 0) throw new NonRetriableError("model returned no scenes");

      // key → visual-template id (built-ins + this org's generated templates).
      const templateIdByKey = new Map(catalog.map((t) => [t.key, t.id]));

      // Build each scene's metrics, deduped by key across the whole deck, and
      // resolve to metricLibraryItems ids (reusing existing org metrics on key clash).
      // `metricKeyByIndex` keeps each scene's metric key per original array index,
      // so per-metric placements ("metricPlacements") can resolve to the right card.
      const builtByKey = new Map<string, BuiltMetric>();
      const sceneKeys: string[][] = [];
      const metricKeyByIndex: (string | null)[][] = [];
      for (const s of draft.scenes) {
        const keys: string[] = [];
        const byIndex: (string | null)[] = [];
        for (const m of Array.isArray(s.metrics) ? s.metrics.slice(0, MAX_METRICS_PER_SCENE) : []) {
          const built = buildMetric(m);
          if (!built) {
            byIndex.push(null);
            continue;
          }
          if (!builtByKey.has(built.key)) builtByKey.set(built.key, built);
          if (!keys.includes(built.key)) keys.push(built.key);
          byIndex.push(built.key);
        }
        sceneKeys.push(keys);
        metricKeyByIndex.push(byIndex);
      }

      const allKeys = [...builtByKey.keys()];
      const idByKey = new Map<string, string>();
      if (allKeys.length > 0) {
        const existing = await db
          .select({ id: schema.metricLibraryItems.id, key: schema.metricLibraryItems.key })
          .from(schema.metricLibraryItems)
          .where(and(eq(schema.metricLibraryItems.orgId, orgId), inArray(schema.metricLibraryItems.key, allKeys)));
        for (const e of existing) idByKey.set(e.key, e.id);

        const toInsert = allKeys
          .filter((k) => !idByKey.has(k))
          .map((k) => {
            const b = builtByKey.get(k)!;
            return { orgId, key: b.key, label: b.label, sublabel: b.sublabel, rawValue: b.rawValue, format: b.format };
          });
        if (toInsert.length > 0) {
          const inserted = await db
            .insert(schema.metricLibraryItems)
            .values(toInsert)
            .returning({ id: schema.metricLibraryItems.id, key: schema.metricLibraryItems.key });
          for (const r of inserted) idByKey.set(r.key, r.id);
        }
      }

      // Fresh deck: clear any scenes a retry may have left, then insert.
      await db.delete(schema.scenes).where(eq(schema.scenes.presentationId, presentationId));

      const rows = draft.scenes.map((s, i) => {
        const name = (s.name ?? `Scene ${i + 1}`).toString().slice(0, 80);
        const script = (s.script ?? "").toString();
        const { words, seconds } = estimate(script);
        const primaryKey = s.template ?? s.templateKey ?? null;
        const templateId = primaryKey ? templateIdByKey.get(primaryKey) ?? null : null;
        const cue = s.cue && typeof s.cue === "object" ? s.cue : {};
        const metricIds = sceneKeys[i].map((k) => idByKey.get(k)).filter((v): v is string => Boolean(v));

        // ── optional free-placement layout (all keys omitted → clean default) ──
        const layout: Record<string, unknown> = {};
        const cuePos = sanitizePos(s.layout?.cue, DEFAULT_CUE_POS);
        if (cuePos) layout.cue = cuePos;
        const metricsPos = sanitizePos(s.layout?.metrics, DEFAULT_METRICS_POS);
        if (metricsPos) layout.metrics = metricsPos;

        // per-metric placement → metricItems keyed by metric id
        const metricItems: Record<string, ScenePos> = {};
        for (const pl of Array.isArray(s.layout?.metricPlacements) ? s.layout!.metricPlacements! : []) {
          const idx = clampInt(pl?.index, 0, 99);
          if (idx === undefined) continue;
          const mkey = metricKeyByIndex[i][idx];
          if (!mkey) continue;
          const mid = idByKey.get(mkey);
          if (!mid) continue;
          const pos = sanitizePos(pl?.pos, DEFAULT_METRICS_POS);
          if (pos) metricItems[mid] = pos;
        }
        if (Object.keys(metricItems).length) layout.metricItems = metricItems;

        // extra visuals → extraCues (resolve template key → id; drop unknowns)
        const extraCues = (Array.isArray(s.extraVisuals) ? s.extraVisuals.slice(0, MAX_EXTRA_VISUALS_PER_SCENE) : [])
          .map((ev, j) => {
            const tid = ev?.template ? templateIdByKey.get(ev.template) : undefined;
            if (!tid) return null;
            const pos = sanitizePos(ev?.pos, { x: 1020, y: 150, scale: 0.8 }) ?? { x: 1020, y: 150, scale: 0.8 };
            return {
              id: `gx-${i}-${j}`,
              templateId: tid,
              params: ev?.cue && typeof ev.cue === "object" ? ev.cue : {},
              pos,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);
        if (extraCues.length) layout.extraCues = extraCues;

        const templateParams: Record<string, unknown> = { sceneKey: slugKey(name, i), cue };
        if (Object.keys(layout).length) templateParams.layout = layout;

        return {
          orgId,
          presentationId,
          position: i,
          name,
          intent: (s.intent ?? "").toString().slice(0, 500),
          templateId,
          templateParams,
          title: (s.title ?? "").toString().slice(0, 120) || null,
          subtitle: (s.subtitle ?? "").toString().slice(0, 200) || null,
          script: script || null,
          scriptWordCount: words,
          estSeconds: seconds,
          metricIds,
          documentIds: documentIds, // all uploaded docs available as evidence; refine per-scene later
          readiness: "needs_review" as const,
          generationMeta: { model: draft.model, costUsd: draft.costUsd, at: new Date().toISOString() },
        };
      });
      await db.insert(schema.scenes).values(rows);
      return { count: rows.length, metricCount: allKeys.length };
    });

    await step.run("finish", async () => {
      await patchSettings(presentationId, {
        motive: draft.motive,
        ...(draft.suggestedQuestions.length ? { suggestedQuestions: draft.suggestedQuestions } : {}),
        ...(draft.endingCaption ? { endingCaption: draft.endingCaption } : {}),
        ...(draft.appendixHeadline ? { appendixHeadline: draft.appendixHeadline } : {}),
        ...(draft.appendixIntro ? { appendixIntro: draft.appendixIntro } : {}),
        generation: { status: "ready", sceneCount: written.count, at: new Date().toISOString() },
      });
      await db.insert(schema.usageRecords).values({
        orgId,
        kind: "llm_generation",
        quantity: String(draft.tokens),
        unit: "tokens",
        costUsd: draft.costUsd.toFixed(6),
        ref: presentationId,
      });
    });

    return { presentationId, sceneCount: written.count };
  },
);
