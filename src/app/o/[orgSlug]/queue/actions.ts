"use server";

import { desc, eq, inArray } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { chatComplete, llmConfigured, llmKeyEnvVar, modelInfo, QA_MODEL } from "@/lib/llm";
import { ActionError, safeAction } from "@/lib/safe-action";
import { slugify } from "@/lib/slug";
import { CUE_SCHEMAS } from "@/viewer/cue-schemas";
import {
  DSL_PROMPT_REFERENCE,
  type LayoutNode,
  type TemplateSpec,
  validateTemplateSpec,
} from "@/lib/template-dsl";

/** What a proposal's `proposedSpec` jsonb holds — the validated DSL spec plus
 *  example values so the queue can render a live preview before approval. */
export type ProposalPayload = {
  spec: TemplateSpec;
  previewParams: Record<string, unknown>;
};

export type ProposalRow = {
  id: string;
  name: string;
  reason: string;
  model: string | null;
  createdAt: string;
  sceneName: string | null;
  layout: LayoutNode;
  previewParams: Record<string, unknown>;
};

/** A complete, valid filled proposal — shown to the model so weak models fill
 *  in real values instead of echoing the schema (the `{ "name": string }` bug). */
const DSL_EXAMPLE = JSON.stringify(
  {
    name: "Severity breakdown",
    reason: "No built-in shows a ranked list of items each with its own severity bar.",
    paramSchema: [
      { name: "heading", type: "string" },
      { name: "items", type: "object[]" },
    ],
    layout: {
      type: "stack",
      gap: 18,
      align: "center",
      children: [
        { type: "text", value: { $bind: "heading" }, variant: "title" },
        {
          type: "repeat",
          each: { $bind: "items" },
          as: "row",
          child: {
            type: "progressBar",
            label: { $bind: "row.label" },
            pct: { $bind: "row.pct" },
            value: { $bind: "row.severity" },
          },
        },
      ],
    },
    previewParams: {
      heading: "Critical vulnerabilities",
      items: [
        { label: "SQL injection", pct: 95, severity: "Critical" },
        { label: "Exposed admin API", pct: 80, severity: "High" },
        { label: "Weak TLS config", pct: 55, severity: "Medium" },
      ],
    },
  },
  null,
  2,
);

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

type Scope = ReturnType<typeof forOrg>;

/** Assemble the scene's concrete content (title, script, deck narrative, and
 *  featured metrics) into a grounding block for the LLM. Shared by the brief
 *  drafter and the template generator. Returns null if the scene isn't found. */
async function loadSceneContext(
  scope: Scope,
  sceneId: string,
): Promise<{ id: string; sceneContext: string } | null> {
  const [scene] = await scope.db
    .select({
      id: schema.scenes.id,
      name: schema.scenes.name,
      title: schema.scenes.title,
      subtitle: schema.scenes.subtitle,
      script: schema.scenes.script,
      metricIds: schema.scenes.metricIds,
      presentationId: schema.scenes.presentationId,
    })
    .from(schema.scenes)
    .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId)));
  if (!scene) return null;

  const [pres] = await scope.db
    .select({ name: schema.presentations.name, settings: schema.presentations.settings })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, scene.presentationId)));
  const motive = ((pres?.settings ?? {}) as { motive?: string }).motive ?? "";

  const mIds = (scene.metricIds as string[]) ?? [];
  const metricRows = mIds.length
    ? await scope.db
        .select({
          label: schema.metricLibraryItems.label,
          rawValue: schema.metricLibraryItems.rawValue,
          sublabel: schema.metricLibraryItems.sublabel,
        })
        .from(schema.metricLibraryItems)
        .where(scope.own(schema.metricLibraryItems, inArray(schema.metricLibraryItems.id, mIds)))
    : [];

  const sceneContext = [
    pres?.name && `Presentation: ${pres.name}`,
    motive && `Deck narrative: ${motive}`,
    `Scene: ${scene.title || scene.name}${scene.subtitle ? ` — ${scene.subtitle}` : ""}`,
    scene.script && `Spoken script for this scene: ${scene.script}`,
    metricRows.length &&
      `Numbers featured in this scene (use these — never invent figures): ${metricRows
        .map((m) => `${m.label}${m.rawValue != null ? ` = ${m.rawValue}` : ""}${m.sublabel ? ` (${m.sublabel})` : ""}`)
        .join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { id: scene.id, sceneContext };
}

/** The visuals that already exist — built-ins + this org's generated templates
 *  — so the model designs something the set lacks and matches the house style. */
async function loadExistingVocabulary(scope: Scope): Promise<string> {
  const genRows = await scope.db
    .select({ name: schema.visualTemplates.name })
    .from(schema.visualTemplates)
    .where(scope.own(schema.visualTemplates, eq(schema.visualTemplates.source, "generated")));
  return [
    ...Object.entries(CUE_SCHEMAS).map(([k, s]) => `• ${k}: ${s.summary}`),
    ...genRows.map((g) => `• ${g.name} (already generated for this org)`),
  ].join("\n");
}

/**
 * Step 1 of visual creation: draft a short, editable BRIEF describing the
 * single most effective visual to build for this scene — the "what to make",
 * in plain language. The user edits this before `proposeTemplateAction` turns
 * it into an actual template. Degrades to a deterministic brief without an LLM.
 */
export async function draftVisualBrief(
  orgSlug: string,
  input: { sceneId?: string | null; hint?: string; model?: string },
): Promise<ActionResult<{ brief: string; drafted: boolean }>> {
  return safeAction("draftVisualBrief", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);

    let sceneContext = "";
    if (input.sceneId) {
      const ctx = await loadSceneContext(scope, input.sceneId);
      if (!ctx) throw new ActionError("Scene not found");
      sceneContext = ctx.sceneContext;
    }
    const hint = (input.hint ?? "").trim();

    // Deterministic fallback (no LLM, or as the seed if the call fails).
    const fallback =
      `Design a single clear visual for this scene` +
      (hint ? ` that ${hint}` : "") +
      `. It should make one idea instantly legible beside the presenter — a comparison, a breakdown, a flow, a ranked list, or a proof point — using the scene's real content` +
      (sceneContext ? `:\n\n${sceneContext}` : ".");

    if (!llmConfigured()) return { brief: fallback, drafted: false };

    const model = input.model || QA_MODEL;
    const existingVocabulary = await loadExistingVocabulary(scope);
    const system = [
      "You are an information-designer briefing a colleague on ONE on-stage visual to build for a single scene of a B2B sales pitch (an avatar presenter speaks beside it).",
      "Write a SHORT brief (2-4 sentences, plain prose — no JSON, no markup): what the visual shows, its structure (e.g. a ranked bar list, a 3-step flow, a comparison, a proof-card), and which concrete pieces of the scene's content it features. Be specific to THIS scene; suggest the single most effective visual.",
      existingVocabulary && `Avoid duplicating visuals that already exist:\n${existingVocabulary}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = [
      sceneContext ? `SCENE CONTEXT:\n${sceneContext}` : "No scene context provided.",
      hint ? `The user wants the visual to: ${hint}` : "",
      "Write the visual brief now.",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const res = await chatComplete({ model, system, userContent: user, maxTokens: 400 });
      const brief = res.text.trim();
      if (!brief) return { brief: fallback, drafted: false };
      await scope.db.insert(schema.usageRecords).values(
        scope.stamp({
          kind: "llm_generation" as const,
          quantity: String(res.usage.inputTokens + res.usage.outputTokens),
          unit: "tokens",
          costUsd: String(res.usage.costUsd),
          ref: input.sceneId ?? null,
        }),
      );
      return { brief, drafted: true };
    } catch {
      // never block the user — hand back the deterministic brief to edit
      return { brief: fallback, drafted: false };
    }
  });
}

/**
 * Step 2 of visual creation: turn an (edited) brief into a new visual-template
 * proposal. The model is constrained to the primitive DSL; the output is
 * validated before it's ever stored, so an ill-formed or oversized proposal is
 * rejected here rather than reaching the queue.
 */
export async function proposeTemplateAction(
  orgSlug: string,
  input: { intent: string; sceneId?: string | null; model?: string },
): Promise<ActionResult<{ proposalId: string; name: string; model: string }>> {
  return safeAction("proposeTemplateAction", async () => {
    const { org } = await requireOrg(orgSlug);
    const intent = input.intent.trim();
    if (!intent) throw new ActionError("Describe the visual you need first.");
    if (!llmConfigured()) {
      throw new ActionError(`Template proposals need ${llmKeyEnvVar()} in .env.local.`);
    }
    const model = input.model || QA_MODEL;
    const scope = forOrg(org.id);

    // Rich context so the model designs a precise, on-topic visual.
    let sceneId: string | null = null;
    let sceneContext = "";
    if (input.sceneId) {
      const ctx = await loadSceneContext(scope, input.sceneId);
      if (!ctx) throw new ActionError("Scene not found");
      sceneId = ctx.id;
      sceneContext = ctx.sceneContext;
    }
    const existingVocabulary = await loadExistingVocabulary(scope);

    const system = [
      "You are a senior information-designer creating ONE reusable on-stage VISUAL for a single scene of a B2B sales pitch delivered by an avatar presenter.",
      "The visual sits beside the presenter and animates while they speak. It must make ONE idea instantly legible — a comparison, a breakdown, a flow, a ranked list, or a single proof point — never a wall of text. Aim for 3-6 elements, clean and specific.",
      "A template is expressed ONLY in the following primitive layout DSL — never write code, HTML, or props outside it.",
      DSL_PROMPT_REFERENCE,
      `Visuals that ALREADY exist — do NOT recreate these; design something the set is missing, in the same clean, minimal style:\n${existingVocabulary}`,
      'Return ONLY a JSON object — no prose, no markdown, no comments. Keys: "name" (≤5 words), "reason" (one sentence: why the existing visuals do not fit), "paramSchema" (array — EVERY entry MUST include a "label" saying what that param controls and where it appears on screen), "layout" (the root node), "previewParams" (a realistic example value for EVERY param, drawn from the SCENE CONTEXT so the preview looks real, not placeholder).',
      'Fill in REAL values — actual strings and numbers from the scene, NOT the type names (write "Data Poisoning", never "string"). Design for reuse: prefer a repeat over a list param instead of hardcoding repeated content.',
      `A COMPLETE, VALID example to imitate in shape:\n${DSL_EXAMPLE}`,
    ].join("\n\n");

    const user = [
      sceneContext ? `SCENE CONTEXT:\n${sceneContext}` : null,
      `WHAT THIS VISUAL MUST DO:\n${intent}`,
      "Design the template now as JSON, grounded in the scene context above. Every previewParams value must come from that content.",
    ]
      .filter(Boolean)
      .join("\n\n");

    let raw: {
      name?: unknown;
      reason?: unknown;
      paramSchema?: unknown;
      layout?: unknown;
      previewParams?: unknown;
    };
    let costUsd: number;
    let usageTokens: number;
    try {
      const res = await chatComplete({ model, system, userContent: user, maxTokens: 1600 });
      try {
        raw = extractJson(res.text) as typeof raw;
      } catch {
        // The model returned prose or echoed the schema instead of valid JSON —
        // almost always a weak/free model not following instructions.
        throw new ActionError(
          "The model didn't return a usable template (it replied with prose, not JSON). Try a stronger model from the picker, or rephrase the intent.",
        );
      }
      costUsd = res.usage.costUsd;
      usageTokens = res.usage.inputTokens + res.usage.outputTokens;
    } catch (e) {
      if (e instanceof ActionError) throw e;
      throw new ActionError(e instanceof Error ? `Generation failed: ${e.message}` : "Generation failed");
    }

    const validation = validateTemplateSpec({ paramSchema: raw.paramSchema, layout: raw.layout });
    if (!validation.ok) {
      throw new ActionError(
        `The model's template didn't fit the visual DSL (${validation.errors[0]}). Try again or rephrase the intent.`,
      );
    }

    const name = (typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Custom visual").slice(0, 80);
    const reason =
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim().slice(0, 400)
        : "No existing template fit this scene's intent.";
    const previewParams =
      raw.previewParams && typeof raw.previewParams === "object" && !Array.isArray(raw.previewParams)
        ? (raw.previewParams as Record<string, unknown>)
        : {};

    const payload: ProposalPayload = { spec: validation.spec, previewParams };

    const [row] = await scope.db
      .insert(schema.templateProposals)
      .values(scope.stamp({ sceneId, name, proposedSpec: payload, reason, model, status: "pending" as const }))
      .returning({ id: schema.templateProposals.id });

    await scope.db.insert(schema.usageRecords).values(
      scope.stamp({
        kind: "llm_generation" as const,
        quantity: String(usageTokens),
        unit: "tokens",
        costUsd: String(costUsd),
        ref: row.id,
      }),
    );

    const info = await modelInfo(model);
    return { proposalId: row.id, name, model: info?.label ?? model };
  });
}

/** All pending proposals for the org, newest first — feeds the queue page. */
export async function listPendingProposals(orgId: string): Promise<ProposalRow[]> {
  const scope = forOrg(orgId);
  const rows = await scope.db
    .select({
      id: schema.templateProposals.id,
      name: schema.templateProposals.name,
      reason: schema.templateProposals.reason,
      model: schema.templateProposals.model,
      createdAt: schema.templateProposals.createdAt,
      proposedSpec: schema.templateProposals.proposedSpec,
      sceneName: schema.scenes.name,
    })
    .from(schema.templateProposals)
    .leftJoin(schema.scenes, eq(schema.templateProposals.sceneId, schema.scenes.id))
    .where(scope.own(schema.templateProposals, eq(schema.templateProposals.status, "pending")))
    .orderBy(desc(schema.templateProposals.createdAt));

  return rows.map((r) => {
    const payload = (r.proposedSpec ?? {}) as ProposalPayload;
    return {
      id: r.id,
      name: r.name,
      reason: r.reason,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      sceneName: r.sceneName,
      layout: payload.spec?.layout as LayoutNode,
      previewParams: payload.previewParams ?? {},
    };
  });
}

/**
 * Approve a proposal → materialize it as an org-scoped generated
 * `visualTemplate`, and (if the proposal came from a scene) point that scene at
 * the new template so it renders immediately with the example params.
 */
export async function approveProposalAction(
  orgSlug: string,
  proposalId: string,
): Promise<ActionResult<{ templateId: string }>> {
  return safeAction("approveProposalAction", async () => {
    const { org, clerkUserId } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);

    const [proposal] = await scope.db
      .select()
      .from(schema.templateProposals)
      .where(scope.own(schema.templateProposals, eq(schema.templateProposals.id, proposalId)));
    if (!proposal) throw new ActionError("Proposal not found");
    if (proposal.status !== "pending") throw new ActionError("This proposal was already reviewed.");

    const payload = (proposal.proposedSpec ?? {}) as ProposalPayload;
    // Re-validate at approval time — never trust stored JSON blindly.
    const validation = validateTemplateSpec(payload.spec);
    if (!validation.ok) throw new ActionError(`Stored template is invalid (${validation.errors[0]}).`);

    const key = `gen-${slugify(proposal.name) || "template"}-${proposal.id.slice(-5)}`;
    const [template] = await scope.db
      .insert(schema.visualTemplates)
      .values(
        scope.stamp({
          key,
          name: proposal.name,
          spec: validation.spec,
          previewParams: payload.previewParams ?? {},
          status: "active" as const,
          source: "generated" as const,
        }),
      )
      .returning({ id: schema.visualTemplates.id });

    await scope.db
      .update(schema.templateProposals)
      .set({ status: "approved", reviewedBy: clerkUserId, reviewedAt: new Date() })
      .where(scope.own(schema.templateProposals, eq(schema.templateProposals.id, proposalId)));

    // Point the originating scene at the approved template, seeding its params
    // (under `cue`, where both built-in and generated cues read from).
    if (proposal.sceneId) {
      const [scene] = await scope.db
        .select({ id: schema.scenes.id, templateParams: schema.scenes.templateParams })
        .from(schema.scenes)
        .where(scope.own(schema.scenes, eq(schema.scenes.id, proposal.sceneId)));
      if (scene) {
        const params = (scene.templateParams ?? {}) as Record<string, unknown>;
        await scope.db
          .update(schema.scenes)
          .set({ templateId: template.id, templateParams: { ...params, cue: payload.previewParams ?? {} } })
          .where(scope.own(schema.scenes, eq(schema.scenes.id, scene.id)));
      }
    }

    return { templateId: template.id };
  });
}

export async function rejectProposalAction(
  orgSlug: string,
  proposalId: string,
): Promise<ActionResult<null>> {
  return safeAction("rejectProposalAction", async () => {
    const { org, clerkUserId } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const res = await scope.db
      .update(schema.templateProposals)
      .set({ status: "rejected", reviewedBy: clerkUserId, reviewedAt: new Date() })
      .where(
        scope.own(
          schema.templateProposals,
          eq(schema.templateProposals.id, proposalId),
          eq(schema.templateProposals.status, "pending"),
        ),
      )
      .returning({ id: schema.templateProposals.id });
    if (res.length === 0) throw new ActionError("Proposal not found or already reviewed.");
    return null;
  });
}
