"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { mediaUrl, presignMediaUpload } from "@/lib/r2";
import { ActionError, safeAction } from "@/lib/safe-action";
import { slugify } from "@/lib/slug";
import type { MetricFormat } from "@/viewer/types";

/** ~150 wpm speaking pace → 0.4s per word, floored so a title card still breathes. */
function estimate(script: string): { words: number; seconds: number } {
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  return { words, seconds: Math.max(6, Math.round(words * 0.4)) };
}

export type ScenePatch = {
  name?: string;
  intent?: string;
  title?: string | null;
  subtitle?: string | null;
  script?: string | null;
  templateId?: string | null;
  templateParams?: Record<string, unknown>;
  metricIds?: string[];
  documentIds?: string[];
  readiness?: "draft" | "needs_review" | "ready";
};

export type NewMetric = {
  label: string;
  sublabel: string;
  rawValue: string; // numeric string, "" for literal-only
  format: MetricFormat;
};

export type BuilderMetricRow = {
  id: string;
  key: string;
  label: string;
  sublabel: string | null;
  rawValue: number | null;
  format: MetricFormat;
};

/**
 * Create a metric straight from the Scene Builder inspector (no round-trip to
 * the Metrics tab). Returns the full row so the caller can attach it to the
 * scene immediately.
 */
export async function createSceneMetric(
  orgSlug: string,
  presentationId: string,
  input: NewMetric,
): Promise<ActionResult<BuilderMetricRow>> {
  return safeAction("createSceneMetric", async () => {
    const { org } = await requireOrg(orgSlug);
    const label = input.label.trim();
    if (!label) throw new ActionError("Give the metric a label");
    const key = slugify(label).replace(/-/g, "_").slice(0, 40);
    if (!key) throw new ActionError("Couldn't derive a key from the label");
    const rawStr = input.rawValue.trim();
    if (rawStr !== "" && Number.isNaN(Number(rawStr))) {
      throw new ActionError("Value must be a number (or blank for a literal metric)");
    }
    const scope = forOrg(org.id);
    const sublabel = input.sublabel.trim() || null;
    let row: typeof schema.metricLibraryItems.$inferSelect;
    try {
      [row] = await scope.db
        .insert(schema.metricLibraryItems)
        .values(scope.stamp({ key, label, sublabel, rawValue: rawStr === "" ? null : rawStr, format: input.format }))
        .returning();
    } catch {
      throw new ActionError(`A metric with key "${key}" already exists — pick it from the list instead`);
    }
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
    revalidatePath(`/o/${orgSlug}/metrics`);
    return {
      id: row.id,
      key: row.key,
      label: row.label,
      sublabel: row.sublabel,
      rawValue: row.rawValue == null ? null : Number(row.rawValue),
      format: row.format as MetricFormat,
    };
  });
}

/**
 * Edit an existing library metric from the Scene Builder inspector — the fast
 * path for turning a generated "—" placeholder into a real figure. The metric's
 * `key` is left unchanged (it's the org-unique identity; renaming the label
 * doesn't re-key it), so this never collides with another metric. Note: metrics
 * are org-shared, so an edit updates the figure everywhere it's attached.
 */
export async function updateSceneMetric(
  orgSlug: string,
  presentationId: string,
  metricId: string,
  input: NewMetric,
): Promise<ActionResult<BuilderMetricRow>> {
  return safeAction("updateSceneMetric", async () => {
    const { org } = await requireOrg(orgSlug);
    const label = input.label.trim();
    if (!label) throw new ActionError("Give the metric a label");
    const rawStr = input.rawValue.trim();
    if (rawStr !== "" && Number.isNaN(Number(rawStr))) {
      throw new ActionError("Value must be a number (or blank for a literal metric)");
    }
    const scope = forOrg(org.id);
    const sublabel = input.sublabel.trim() || null;
    const [row] = await scope.db
      .update(schema.metricLibraryItems)
      .set({ label, sublabel, rawValue: rawStr === "" ? null : rawStr, format: input.format })
      .where(scope.own(schema.metricLibraryItems, eq(schema.metricLibraryItems.id, metricId)))
      .returning();
    if (!row) throw new ActionError("Metric not found");
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
    revalidatePath(`/o/${orgSlug}/metrics`);
    return {
      id: row.id,
      key: row.key,
      label: row.label,
      sublabel: row.sublabel,
      rawValue: row.rawValue == null ? null : Number(row.rawValue),
      format: row.format as MetricFormat,
    };
  });
}

export async function createScene(
  orgSlug: string,
  presentationId: string,
  name?: string,
): Promise<ActionResult<{ sceneId: string }>> {
  return safeAction("createScene", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [pres] = await scope.db
      .select({ id: schema.presentations.id })
      .from(schema.presentations)
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    if (!pres) throw new ActionError("Presentation not found");

    const [{ maxPos }] = await scope.db
      .select({ maxPos: sql<number>`coalesce(max(${schema.scenes.position}), -1)::int` })
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.presentationId, presentationId)));

    const [row] = await scope.db
      .insert(schema.scenes)
      .values(
        scope.stamp({
          presentationId,
          position: (maxPos ?? -1) + 1,
          name: (name?.trim() || "New scene").slice(0, 80),
          intent: "",
          readiness: "draft" as const,
        }),
      )
      .returning({ id: schema.scenes.id });
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
    return { sceneId: row.id };
  });
}

export async function updateScene(
  orgSlug: string,
  presentationId: string,
  sceneId: string,
  patch: ScenePatch,
): Promise<ActionResult> {
  return safeAction("updateScene", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);

    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 80) || "Untitled scene";
    if (patch.intent !== undefined) set.intent = patch.intent.slice(0, 400);
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.subtitle !== undefined) set.subtitle = patch.subtitle;
    if (patch.templateId !== undefined) set.templateId = patch.templateId;
    if (patch.templateParams !== undefined) set.templateParams = patch.templateParams;
    if (patch.metricIds !== undefined) set.metricIds = patch.metricIds;
    if (patch.documentIds !== undefined) set.documentIds = patch.documentIds;
    if (patch.readiness !== undefined) set.readiness = patch.readiness;
    if (patch.script !== undefined) {
      const script = patch.script ?? "";
      const est = estimate(script);
      set.script = script;
      set.scriptWordCount = est.words;
      set.estSeconds = est.seconds;
    }

    const updated = await scope.db
      .update(schema.scenes)
      .set(set)
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId), eq(schema.scenes.presentationId, presentationId)))
      .returning({ id: schema.scenes.id });
    if (updated.length === 0) throw new ActionError("Scene not found");
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

export async function deleteScene(
  orgSlug: string,
  presentationId: string,
  sceneId: string,
): Promise<ActionResult> {
  return safeAction("deleteScene", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [scene] = await scope.db
      .select({ position: schema.scenes.position })
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId), eq(schema.scenes.presentationId, presentationId)));
    if (!scene) throw new ActionError("Scene not found");
    await scope.db
      .delete(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId)));
    // Close the gap so positions stay contiguous.
    await scope.db
      .update(schema.scenes)
      .set({ position: sql`${schema.scenes.position} - 1` })
      .where(
        scope.own(
          schema.scenes,
          eq(schema.scenes.presentationId, presentationId),
          gte(schema.scenes.position, scene.position),
        ),
      );
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

/** Persist a full ordering (array of scene ids in the new order). */
export async function reorderScenes(
  orgSlug: string,
  presentationId: string,
  orderedIds: string[],
): Promise<ActionResult> {
  return safeAction("reorderScenes", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const scenes = await scope.db
      .select({ id: schema.scenes.id })
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.presentationId, presentationId)))
      .orderBy(asc(schema.scenes.position));
    const known = new Set(scenes.map((s) => s.id));
    if (orderedIds.length !== known.size || !orderedIds.every((id) => known.has(id))) {
      throw new ActionError("Ordering doesn't match this presentation's scenes");
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await scope.db
        .update(schema.scenes)
        .set({ position: i })
        .where(scope.own(schema.scenes, and(eq(schema.scenes.id, orderedIds[i]))));
    }
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

/**
 * Presign a direct browser upload of an image/video into the public MEDIA
 * bucket, for placing on a scene canvas. Returns the upload URL + the public
 * CDN URL to store on the scene's `layout.media[]`.
 */
export async function startSceneMediaUpload(
  orgSlug: string,
  input: { contentType: string; ext: string },
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string }>> {
  return safeAction("startSceneMediaUpload", async () => {
    const { org } = await requireOrg(orgSlug);
    const ct = input.contentType.toLowerCase();
    if (!ct.startsWith("image/") && !ct.startsWith("video/")) {
      throw new ActionError("Only image or video files can be placed on a scene.");
    }
    if (!process.env.R2_MEDIA_PUBLIC_URL) {
      throw new ActionError("Media storage isn't configured (R2_MEDIA_PUBLIC_URL). See .env.example.");
    }
    const safeExt = (input.ext || "").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
    const key = `scene-media/${org.id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
    const uploadUrl = await presignMediaUpload(key, input.contentType);
    return { uploadUrl, publicUrl: mediaUrl(key) };
  });
}
