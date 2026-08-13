"use server";

import { revalidatePath } from "next/cache";
import { asc, eq, ne } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { inngest, presentationGenerateEvent } from "@/inngest/client";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { llmConfigured, llmKeyEnvVar } from "@/lib/llm";
import { ActionError, safeAction } from "@/lib/safe-action";
import { slugify } from "@/lib/slug";

/** Find a slug not already used by another presentation in this org. */
async function uniqueSlug(orgId: string, base: string, exceptId?: string): Promise<string> {
  const scope = forOrg(orgId);
  const root = slugify(base) || "pitch";
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const clash = await scope.db
      .select({ id: schema.presentations.id })
      .from(schema.presentations)
      .where(
        scope.own(
          schema.presentations,
          eq(schema.presentations.slug, candidate),
          exceptId ? ne(schema.presentations.id, exceptId) : undefined,
        ),
      );
    if (clash.length === 0) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export async function createPresentation(
  orgSlug: string,
  name: string,
): Promise<ActionResult<{ presentationId: string }>> {
  return safeAction("createPresentation", async () => {
    const { org } = await requireOrg(orgSlug);
    const trimmed = name.trim();
    if (!trimmed) throw new ActionError("Give the presentation a name");
    const scope = forOrg(org.id);
    const slug = await uniqueSlug(org.id, trimmed);
    const [row] = await scope.db
      .insert(schema.presentations)
      .values(scope.stamp({ name: trimmed.slice(0, 120), slug, status: "draft" as const }))
      .returning({ id: schema.presentations.id });
    // Every presentation gets a default (codeless) link so /p/{slug}-en resolves.
    await scope.db
      .insert(schema.shareLinks)
      .values(scope.stamp({ presentationId: row.id, code: null, isDefault: true, status: "draft" as const }));
    revalidatePath(`/o/${orgSlug}`);
    return { presentationId: row.id };
  });
}

/**
 * Create a presentation from a brief + pre-uploaded documents, then kick off the
 * background deck-generation job. The docs must already be uploaded (via
 * startDocumentUpload/finishDocumentUpload) so we only pass their ids here.
 */
export async function createPresentationFromBrief(
  orgSlug: string,
  input: { name: string; brief: string; documentIds: string[] },
): Promise<ActionResult<{ presentationId: string }>> {
  return safeAction("createPresentationFromBrief", async () => {
    const { org } = await requireOrg(orgSlug);
    const trimmed = input.name.trim();
    if (!trimmed) throw new ActionError("Give the presentation a name");
    if (!llmConfigured()) {
      throw new ActionError(
        `AI deck generation needs ${llmKeyEnvVar()} in .env.local — create a blank presentation instead.`,
      );
    }
    const scope = forOrg(org.id);
    const slug = await uniqueSlug(org.id, trimmed);
    const [row] = await scope.db
      .insert(schema.presentations)
      .values(
        scope.stamp({
          name: trimmed.slice(0, 120),
          slug,
          status: "draft" as const,
          settings: { generation: { status: "generating", at: new Date().toISOString() } },
        }),
      )
      .returning({ id: schema.presentations.id });
    await scope.db
      .insert(schema.shareLinks)
      .values(scope.stamp({ presentationId: row.id, code: null, isDefault: true, status: "draft" as const }));

    // Queue the background deck-generation job. If the send fails (e.g. the
    // Inngest dev server isn't running locally), don't leave the deck stuck in
    // "generating" forever — mark it failed with a clear, recoverable message.
    try {
      await inngest.send(
        presentationGenerateEvent.create({
          orgId: org.id,
          presentationId: row.id,
          brief: input.brief.trim().slice(0, 8000),
          documentIds: input.documentIds.slice(0, 30),
        }),
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : "unknown error";
      await scope.db
        .update(schema.presentations)
        .set({
          settings: {
            generation: {
              status: "failed",
              error: `Couldn't start generation — is the Inngest dev server running? (${detail})`,
              at: new Date().toISOString(),
            },
          },
        })
        .where(scope.own(schema.presentations, eq(schema.presentations.id, row.id)));
    }

    revalidatePath(`/o/${orgSlug}`);
    return { presentationId: row.id };
  });
}

export type GenerationStatus = {
  status: "generating" | "ready" | "failed" | "none";
  error?: string;
  sceneCount?: number;
};

/** Poll the deck-generation job's progress (read-only; returns data, not an ActionResult). */
export async function getGenerationStatus(
  orgSlug: string,
  presentationId: string,
): Promise<GenerationStatus> {
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);
  const [row] = await scope.db
    .select({ settings: schema.presentations.settings })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  const gen = (row?.settings as { generation?: GenerationStatus } | undefined)?.generation;
  if (!gen) return { status: "none" };
  return { status: gen.status, error: gen.error, sceneCount: gen.sceneCount };
}

export async function renamePresentation(
  orgSlug: string,
  presentationId: string,
  name: string,
): Promise<ActionResult> {
  return safeAction("renamePresentation", async () => {
    const { org } = await requireOrg(orgSlug);
    const trimmed = name.trim();
    if (!trimmed) throw new ActionError("Name cannot be empty");
    const scope = forOrg(org.id);
    const updated = await scope.db
      .update(schema.presentations)
      .set({ name: trimmed.slice(0, 120) })
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)))
      .returning({ id: schema.presentations.id });
    if (updated.length === 0) throw new ActionError("Presentation not found");
    revalidatePath(`/o/${orgSlug}`);
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

/** Publish → live, unpublish → draft, or archive. Publishing also flips the
 *  default share link live so the pitch URL resolves. */
export async function setPresentationStatus(
  orgSlug: string,
  presentationId: string,
  status: "draft" | "live" | "archived",
): Promise<ActionResult> {
  return safeAction("setPresentationStatus", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [pres] = await scope.db
      .select({ id: schema.presentations.id })
      .from(schema.presentations)
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    if (!pres) throw new ActionError("Presentation not found");
    await scope.db
      .update(schema.presentations)
      .set({ status })
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    if (status === "live") {
      await scope.db
        .update(schema.shareLinks)
        .set({ status: "live" })
        .where(
          scope.own(
            schema.shareLinks,
            eq(schema.shareLinks.presentationId, presentationId),
            eq(schema.shareLinks.isDefault, true),
          ),
        );
    }
    revalidatePath(`/o/${orgSlug}`);
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

/** Deep-copy a presentation + its scenes into a fresh draft. Links/renders are not copied. */
export async function duplicatePresentation(
  orgSlug: string,
  presentationId: string,
): Promise<ActionResult<{ presentationId: string }>> {
  return safeAction("duplicatePresentation", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [src] = await scope.db
      .select()
      .from(schema.presentations)
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    if (!src) throw new ActionError("Presentation not found");

    const name = `${src.name} (copy)`;
    const slug = await uniqueSlug(org.id, name);
    const [copy] = await scope.db
      .insert(schema.presentations)
      .values(
        scope.stamp({
          name: name.slice(0, 120),
          slug,
          status: "draft" as const,
          defaultLang: src.defaultLang,
          defaultPresenterId: src.defaultPresenterId,
          baseDeckLabel: src.baseDeckLabel,
          settings: src.settings,
        }),
      )
      .returning({ id: schema.presentations.id });

    const scenes = await scope.db
      .select()
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.presentationId, presentationId)))
      .orderBy(asc(schema.scenes.position));
    if (scenes.length > 0) {
      await scope.db.insert(schema.scenes).values(
        scenes.map((s) =>
          scope.stamp({
            presentationId: copy.id,
            position: s.position,
            name: s.name,
            intent: s.intent,
            templateId: s.templateId,
            templateParams: s.templateParams,
            title: s.title,
            subtitle: s.subtitle,
            script: s.script,
            scriptWordCount: s.scriptWordCount,
            estSeconds: s.estSeconds,
            metricIds: s.metricIds,
            documentIds: s.documentIds,
            readiness: s.readiness,
            generationMeta: s.generationMeta,
          }),
        ),
      );
    }
    await scope.db
      .insert(schema.shareLinks)
      .values(scope.stamp({ presentationId: copy.id, code: null, isDefault: true, status: "draft" as const }));

    revalidatePath(`/o/${orgSlug}`);
    return { presentationId: copy.id };
  });
}

export async function deletePresentation(
  orgSlug: string,
  presentationId: string,
): Promise<ActionResult> {
  return safeAction("deletePresentation", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const deleted = await scope.db
      .delete(schema.presentations)
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)))
      .returning({ id: schema.presentations.id });
    if (deleted.length === 0) throw new ActionError("Presentation not found");
    revalidatePath(`/o/${orgSlug}`);
  });
}
