"use server";

import { revalidatePath } from "next/cache";
import { asc, eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { ActionError, safeAction } from "@/lib/safe-action";
import { enqueueSceneRender, type EnqueueResult } from "@/lib/render";

async function loadPresentation(orgId: string, presentationId: string) {
  const scope = forOrg(orgId);
  const [presentation] = await scope.db
    .select()
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  return { scope, presentation };
}

export async function setDefaultPresenter(
  orgSlug: string,
  presentationId: string,
  presenterId: string,
): Promise<ActionResult> {
  return safeAction("setDefaultPresenter", async () => {
    const { org } = await requireOrg(orgSlug);
    const { scope, presentation } = await loadPresentation(org.id, presentationId);
    if (!presentation) throw new ActionError("Presentation not found");
    const [presenter] = await scope.db
      .select({ id: schema.presenters.id })
      .from(schema.presenters)
      .where(scope.own(schema.presenters, eq(schema.presenters.id, presenterId)));
    if (!presenter) throw new ActionError("Presenter not found");
    await scope.db
      .update(schema.presentations)
      .set({ defaultPresenterId: presenterId })
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
  });
}

export async function renderSceneAction(
  orgSlug: string,
  presentationId: string,
  sceneId: string,
): Promise<ActionResult<EnqueueResult>> {
  return safeAction("renderSceneAction", async () => {
    const { org } = await requireOrg(orgSlug);
    const { scope, presentation } = await loadPresentation(org.id, presentationId);
    if (!presentation) throw new ActionError("Presentation not found");
    if (!presentation.defaultPresenterId) throw new ActionError("Pick a presenter first");
    const [scene] = await scope.db
      .select()
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.id, sceneId)));
    if (!scene || scene.presentationId !== presentationId) throw new ActionError("Scene not found");
    const result = await enqueueSceneRender(
      scope,
      scene,
      presentation.defaultLang,
      presentation.defaultPresenterId,
    );
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
    return result;
  });
}

/** "Render all changed" — the publish→render diff: only stale scenes enqueue. */
export async function renderChangedScenes(
  orgSlug: string,
  presentationId: string,
): Promise<ActionResult<{ queued: number; unchanged: number }>> {
  return safeAction("renderChangedScenes", async () => {
    const { org } = await requireOrg(orgSlug);
    const { scope, presentation } = await loadPresentation(org.id, presentationId);
    if (!presentation) throw new ActionError("Presentation not found");
    if (!presentation.defaultPresenterId) throw new ActionError("Pick a presenter first");
    const sceneRows = await scope.db
      .select()
      .from(schema.scenes)
      .where(scope.own(schema.scenes, eq(schema.scenes.presentationId, presentationId)))
      .orderBy(asc(schema.scenes.position));

    let queued = 0;
    let unchanged = 0;
    for (const scene of sceneRows) {
      const res = await enqueueSceneRender(
        scope,
        scene,
        presentation.defaultLang,
        presentation.defaultPresenterId,
      );
      if (res.outcome === "queued") queued++;
      else unchanged++;
    }
    revalidatePath(`/o/${orgSlug}/p/${presentationId}`);
    return { queued, unchanged };
  });
}
