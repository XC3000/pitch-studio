"use server";

import { eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { chatComplete, llmConfigured, llmKeyEnvVar, modelInfo, QA_MODEL } from "@/lib/llm";
import { ActionError, safeAction } from "@/lib/safe-action";

/** Expected cue-param shape per built-in template, so generated JSON renders. */
const TEMPLATE_HINTS: Record<string, string> = {
  pillars: `{ "items": [ { "value": "24/7", "label": "ALWAYS ON" }, … 3-4 items ] }`,
  journey: `{ "stages": [ { "title": "First call", "sub": "member reaches us" }, … mark the last { …, "done": true } ] }`,
  "network-map": `{}  (no params — renders a world map)`,
  "gop-doc": `{ "clock": "00:47", "clockLabel": "AVG GOP TIME", "docHeader": "GUARANTEE OF PAYMENT", "approvedLabel": "✓ APPROVED", "stamp": ["CMA","GOP"] }`,
  rating: `{ "stars": 5, "starsLabel": "4.7 / 5 PATIENT RATING", "barLabel": "CLIENTS WHO STAY", "barPct": 96, "barValue": "96%", "barNote": "100+ partners renew" }`,
  invoice: `{ "header": "INVOICE · CMA-2026", "badge": "99.2% ACCURATE", "lines": 3, "note": "submitted fast · disputes almost never" }`,
  route: `{ "from": "Remote incident", "to": "Critical care · in time", "chips": ["Technology","Automation","Reporting"] }`,
};

export type GeneratedScene = {
  title: string;
  subtitle: string;
  script: string;
  cue: Record<string, unknown>;
};

export type GenerateData = {
  scene: GeneratedScene;
  model: string;
  costUsd: number;
};

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

export async function generateSceneAction(
  orgSlug: string,
  presentationId: string,
  sceneId: string,
  input: { intent: string; templateKey: string | null; model?: string },
): Promise<ActionResult<GenerateData>> {
  return safeAction("generateSceneAction", async () => {
    const { org } = await requireOrg(orgSlug);
    const intent = input.intent.trim();
    if (!intent) throw new ActionError("Add an intent first — what should this scene land?");
    if (!llmConfigured()) {
      throw new ActionError(
        `AI drafting needs ${llmKeyEnvVar()} in .env.local — author the script by hand for now.`,
      );
    }
    const model = input.model || QA_MODEL;
    const scope = forOrg(org.id);

    const [scene] = await scope.db
      .select({ id: schema.scenes.id })
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId), eq(schema.scenes.presentationId, presentationId)));
    if (!scene) throw new ActionError("Scene not found");

    const hint = input.templateKey ? TEMPLATE_HINTS[input.templateKey] : null;

    const system = [
      "You are a senior scriptwriter for CredibleAssist-style B2B sales pitches delivered by an on-screen avatar presenter.",
      "Write for the spoken word: warm, confident, concrete, no marketing fluff, no bullet lists in the script.",
      "The script is one scene of a longer deck and runs ~12-18 seconds (roughly 30-55 words). Never invent specific statistics — if the intent names figures, use them; otherwise speak qualitatively.",
      "Return ONLY a JSON object, no prose, with keys: title (short, ≤6 words), subtitle (one line), script (the spoken words), cue (parameters for the chosen visual template).",
      hint
        ? `The visual template is "${input.templateKey}". Its cue object must match this shape: ${hint}`
        : "There is no visual template; return cue as {}.",
    ].join("\n");

    const user = `Scene intent:\n${intent}\n\nWrite the scene now as JSON.`;

    let parsed: Partial<GeneratedScene>;
    let costUsd: number;
    let usageTokens: number;
    try {
      const res = await chatComplete({ model, system, userContent: user, maxTokens: 900 });
      parsed = extractJson(res.text) as Partial<GeneratedScene>;
      costUsd = res.usage.costUsd;
      usageTokens = res.usage.inputTokens + res.usage.outputTokens;
    } catch (e) {
      throw new ActionError(
        e instanceof Error ? `Generation failed: ${e.message}` : "Generation failed",
      );
    }

    await scope.db.insert(schema.usageRecords).values(
      scope.stamp({
        kind: "llm_generation" as const,
        quantity: String(usageTokens),
        unit: "tokens",
        costUsd: String(costUsd),
        ref: sceneId,
      }),
    );

    // Stamp the generation provenance on the scene.
    await scope.db
      .update(schema.scenes)
      .set({ generationMeta: { model, costUsd, at: new Date().toISOString() } })
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId)));

    const info = await modelInfo(model);
    return {
      model: info?.label ?? model,
      costUsd,
      scene: {
        title: (parsed.title ?? "").toString().slice(0, 120),
        subtitle: (parsed.subtitle ?? "").toString().slice(0, 200),
        script: (parsed.script ?? "").toString(),
        cue: (parsed.cue as Record<string, unknown>) ?? {},
      },
    };
  });
}
