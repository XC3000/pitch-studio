/**
 * Public viewer resolution — `/p/{presSlug}-{lang}` (default link) or
 * `/p/{presSlug}-{lang}-{code}` (per-recipient). Resolves the share link,
 * checks status/expiry, and assembles the DeckData the player consumes.
 *
 * This is a public entry point: the org is derived FROM the resolved link,
 * never from the caller, and every subsequent read is filtered to that org.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { schema, systemDb } from "@/db/system";
import { cookieNameFor, verifyUnlockToken } from "@/lib/passcode";
import { mediaUrl } from "@/lib/r2";
import type { LayoutNode } from "@/lib/template-dsl";
import type {
  DeckBranding,
  DeckData,
  DeckExtraCue,
  DeckMetric,
  DeckScene,
  DeckVideoKind,
  DeckWordTiming,
  SceneCueRef,
  SceneLayout,
  ScenePos,
} from "@/viewer/types";

export type ResolvedViewer =
  | { ok: true; deck: DeckData; linkId: string }
  | { ok: false; reason: "not_found" | "unavailable" | "unpublished" }
  | { ok: false; reason: "locked"; linkId: string; recipientName: string | null };

type ParsedSlug = { presSlug: string; lang: string; code: string | null };

export function parseViewerSlug(slug: string): ParsedSlug | null {
  const parts = slug.split("-");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (/^[a-z]{2}$/.test(last)) {
    return { presSlug: parts.slice(0, -1).join("-"), lang: last, code: null };
  }
  const langPart = parts[parts.length - 2];
  if (parts.length >= 3 && /^[a-z]{2}$/.test(langPart) && /^[a-z0-9]{4,10}$/i.test(last)) {
    return { presSlug: parts.slice(0, -2).join("-"), lang: langPart, code: last };
  }
  return null;
}

/**
 * Resolve the Q&A context for a share link — org, fallback text, and the
 * presenter's ElevenLabs voice for the link's language. Used by /api/qa; the
 * org is derived FROM the link, never from the caller.
 */
export async function resolveQaContext(linkId: string) {
  const db = systemDb();
  const [row] = await db
    .select({ link: schema.shareLinks, presentation: schema.presentations, org: schema.organizations })
    .from(schema.shareLinks)
    .innerJoin(schema.presentations, eq(schema.shareLinks.presentationId, schema.presentations.id))
    .innerJoin(schema.organizations, eq(schema.presentations.orgId, schema.organizations.id))
    .where(eq(schema.shareLinks.id, linkId))
    .limit(1);
  if (!row || row.link.status !== "live") return null;
  if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) return null;

  const lang = row.link.langOverride ?? row.presentation.defaultLang;
  const presenterId = row.link.presenterOverrideId ?? row.presentation.defaultPresenterId;
  let elevenVoiceId: string | null = null;
  if (presenterId) {
    const [presenter] = await db
      .select({ voices: schema.presenters.voices })
      .from(schema.presenters)
      .where(and(eq(schema.presenters.orgId, row.org.id), eq(schema.presenters.id, presenterId)));
    const voices = (presenter?.voices ?? {}) as Record<string, { elevenVoiceId?: string }>;
    elevenVoiceId = voices[lang]?.elevenVoiceId ?? null;
  }

  return {
    orgId: row.org.id,
    linkId: row.link.id,
    presentationId: row.presentation.id,
    fallbackText: row.org.qaFallbackText,
    elevenVoiceId,
  };
}

export async function resolveViewer(slug: string): Promise<ResolvedViewer> {
  const parsed = parseViewerSlug(slug);
  if (!parsed) return { ok: false, reason: "not_found" };
  const db = systemDb();

  let link: typeof schema.shareLinks.$inferSelect | undefined;
  let presentation: typeof schema.presentations.$inferSelect | undefined;

  if (parsed.code) {
    const rows = await db
      .select({ link: schema.shareLinks, presentation: schema.presentations })
      .from(schema.shareLinks)
      .innerJoin(schema.presentations, eq(schema.shareLinks.presentationId, schema.presentations.id))
      .where(eq(schema.shareLinks.code, parsed.code))
      .limit(1);
    if (rows.length === 0 || rows[0].presentation.slug !== parsed.presSlug) {
      return { ok: false, reason: "not_found" };
    }
    ({ link, presentation } = rows[0]);
  } else {
    const rows = await db
      .select({ link: schema.shareLinks, presentation: schema.presentations })
      .from(schema.presentations)
      .innerJoin(
        schema.shareLinks,
        and(
          eq(schema.shareLinks.presentationId, schema.presentations.id),
          eq(schema.shareLinks.isDefault, true),
        ),
      )
      .where(eq(schema.presentations.slug, parsed.presSlug))
      .limit(1);
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    ({ link, presentation } = rows[0]);
  }

  if (link.status !== "live") return { ok: false, reason: "unavailable" };
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "unavailable" };
  }
  if (presentation.status !== "live") return { ok: false, reason: "unpublished" };

  // Passcode gate: a protected link needs a valid unlock cookie for this link.
  if (link.passcodeHash) {
    const token = (await cookies()).get(cookieNameFor(link.id))?.value;
    if (!verifyUnlockToken(link.id, token, Date.now())) {
      return { ok: false, reason: "locked", linkId: link.id, recipientName: link.recipientName };
    }
  }

  const orgId = presentation.orgId;
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));

  const sceneRows = await db
    .select()
    .from(schema.scenes)
    .where(
      and(eq(schema.scenes.orgId, orgId), eq(schema.scenes.presentationId, presentation.id)),
    )
    .orderBy(asc(schema.scenes.position));

  const metricRows = await db
    .select()
    .from(schema.metricLibraryItems)
    .where(eq(schema.metricLibraryItems.orgId, orgId));
  const metricKeyById = new Map(metricRows.map((m) => [m.id, m.key]));

  const allDocIds = [...new Set(sceneRows.flatMap((s) => (s.documentIds as string[]) ?? []))];
  const docRows = allDocIds.length
    ? await db
        .select({ id: schema.documents.id, filename: schema.documents.filename })
        .from(schema.documents)
        .where(and(eq(schema.documents.orgId, orgId), inArray(schema.documents.id, allDocIds)))
    : [];
  const docById = new Map(docRows.map((d) => [d.id, d.filename]));

  const templateRows = await db
    .select({
      id: schema.visualTemplates.id,
      key: schema.visualTemplates.key,
      source: schema.visualTemplates.source,
      spec: schema.visualTemplates.spec,
    })
    .from(schema.visualTemplates);
  const templateKeyById = new Map(templateRows.map((t) => [t.id, t.key]));
  // Generated templates carry a DSL layout the viewer renders directly.
  const generatedLayoutById = new Map(
    templateRows
      .filter((t) => t.source === "generated")
      .map((t) => [t.id, ((t.spec ?? {}) as { layout?: LayoutNode }).layout ?? null]),
  );

  // ── M2: rendered avatar videos + caption timings ──────────────────────────
  const lang = link.langOverride ?? parsed.lang;
  const presenterId = link.presenterOverrideId ?? presentation.defaultPresenterId;
  // Video URLs need the public media CDN; without it (early local dev) the
  // viewer falls back to the illustrated placeholder.
  const mediaReady = !!process.env.R2_MEDIA_PUBLIC_URL;

  type SceneVideo = { url: string; kind: DeckVideoKind; durationSec: number | null; captions: DeckWordTiming[] | null };
  const videoBySceneId = new Map<string, SceneVideo>();
  let idleVideoUrl: string | null = null;
  let idleVideoKind: DeckVideoKind | null = null;

  if (presenterId && mediaReady && sceneRows.length > 0) {
    const jobs = await db
      .select()
      .from(schema.renderJobs)
      .where(
        and(
          eq(schema.renderJobs.orgId, orgId),
          eq(schema.renderJobs.lang, lang),
          eq(schema.renderJobs.presenterId, presenterId),
          eq(schema.renderJobs.status, "done"),
          inArray(
            schema.renderJobs.sceneId,
            sceneRows.map((s) => s.id),
          ),
        ),
      )
      .orderBy(desc(schema.renderJobs.createdAt));

    const latestJobs = new Map<string, typeof jobs[number]>();
    for (const job of jobs) {
      if (job.r2Key && !latestJobs.has(job.sceneId)) latestJobs.set(job.sceneId, job);
    }

    const jobIds = [...latestJobs.values()].map((j) => j.id);
    const audioRows = jobIds.length
      ? await db
          .select()
          .from(schema.sceneAudios)
          .where(
            and(eq(schema.sceneAudios.orgId, orgId), inArray(schema.sceneAudios.renderJobId, jobIds)),
          )
      : [];
    const captionsByJobId = new Map(audioRows.map((a) => [a.renderJobId, a.captions as DeckWordTiming[]]));

    for (const [sceneId, job] of latestJobs) {
      const captions = captionsByJobId.get(job.id);
      videoBySceneId.set(sceneId, {
        url: mediaUrl(job.r2Key!),
        kind: job.r2Key!.endsWith(".webm") ? "webm-alpha" : "chroma",
        durationSec: job.durationSec,
        captions: captions && captions.length > 0 ? captions : null,
      });
    }

    const [presenter] = await db
      .select({ idleVideoR2Key: schema.presenters.idleVideoR2Key })
      .from(schema.presenters)
      .where(and(eq(schema.presenters.orgId, orgId), eq(schema.presenters.id, presenterId)));
    if (presenter?.idleVideoR2Key) {
      idleVideoUrl = mediaUrl(presenter.idleVideoR2Key);
      idleVideoKind = presenter.idleVideoR2Key.endsWith(".webm") ? "webm-alpha" : "chroma";
    }
  }

  const metrics: DeckMetric[] = metricRows.map((m) => ({
    key: m.key,
    label: m.label,
    sublabel: m.sublabel,
    value: m.rawValue == null ? null : Number(m.rawValue),
    format: m.format as DeckMetric["format"],
  }));

  const scenes: DeckScene[] = sceneRows.map((s) => {
    const params = (s.templateParams ?? {}) as Record<string, unknown>;
    const video = videoBySceneId.get(s.id) ?? null;
    const layoutRaw = (params.layout ?? {}) as SceneLayout;

    // additional visual templates → render-ready (resolve template key + spec)
    const extraCues: DeckExtraCue[] = (layoutRaw.extraCues ?? [])
      .filter((ec: SceneCueRef) => ec?.templateId && templateKeyById.has(ec.templateId))
      .map((ec: SceneCueRef) => ({
        id: ec.id,
        cueTemplate: templateKeyById.get(ec.templateId) ?? "pillars",
        cueParams: ec.params ?? {},
        cueSpec: generatedLayoutById.get(ec.templateId) ?? null,
        pos: ec.pos,
      }));

    // per-metric placement is stored by metric id; the player keys by metric key
    const metricLayout: Record<string, ScenePos> = {};
    for (const [mid, pos] of Object.entries(layoutRaw.metricItems ?? {})) {
      const k = metricKeyById.get(mid);
      if (k) metricLayout[k] = pos as ScenePos;
    }
    return {
      id: s.id,
      key: (params.sceneKey as string) ?? s.name.toLowerCase(),
      title: s.title ?? s.name,
      subtitle: s.subtitle ?? "",
      script: s.script ?? "",
      // a real render pins the beat to the spoken audio (+ a short breath)
      duration: video?.durationSec
        ? video.durationSec + 0.6
        : s.estSeconds || Math.max(6, (s.scriptWordCount || 20) * 0.35),
      focus: ((s.metricIds as string[]) ?? [])
        .map((id) => metricKeyById.get(id))
        .filter((k): k is string => !!k),
      cueTemplate: (s.templateId && templateKeyById.get(s.templateId)) || "pillars",
      cueParams: (params.cue as Record<string, unknown>) ?? {},
      // generated templates render via the DSL layout instead of a built-in key;
      // the DSL resolves its bindings against the same `cueParams` object.
      cueSpec: s.templateId ? generatedLayoutById.get(s.templateId) ?? null : null,
      tilt: (params.tilt as number) ?? 0,
      evidenceLabel: (params.evidenceLabel as string) ?? "Supporting documents",
      docs: ((s.documentIds as string[]) ?? [])
        .map((id) => ({ id, name: docById.get(id) ?? "" }))
        .filter((d) => d.name),
      videoUrl: video?.url ?? null,
      videoKind: video?.kind ?? null,
      captions: video?.captions ?? null,
      layout: layoutRaw,
      extraCues,
      metricLayout,
      media: layoutRaw.media ?? [],
    };
  });

  const settings = (presentation.settings ?? {}) as {
    branding?: DeckBranding;
    suggestedQuestions?: string[];
    endingCaption?: string;
    appendixHeadline?: string;
    appendixIntro?: string;
  };

  const deck: DeckData = {
    presentationId: presentation.id,
    recipientName: link.recipientName,
    branding: settings.branding ?? { brandName: org?.name ?? "" },
    idleVideoUrl,
    idleVideoKind,
    metrics,
    scenes,
    suggestedQuestions: settings.suggestedQuestions ?? [],
    fallbackAnswer: org?.qaFallbackText ?? "Let me connect you with our team for that one.",
    endingCaption:
      settings.endingCaption ??
      "Thanks for watching — ask me anything, or replay the walkthrough.",
    appendixHeadline: settings.appendixHeadline ?? "Every figure is backed by documentation.",
    appendixIntro: settings.appendixIntro ?? "",
  };

  return { ok: true, deck, linkId: link.id };
}
