import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { latestRenderJobs } from "@/lib/render";
import { RenderPanel, type SceneRenderRow } from "../render-panel";

export default async function PresentationRenderPage({
  params,
}: {
  params: Promise<{ orgSlug: string; presentationId: string }>;
}) {
  const { orgSlug, presentationId } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const [presentation] = await scope.db
    .select()
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!presentation) notFound();

  const sceneRows = await scope.db
    .select()
    .from(schema.scenes)
    .where(scope.own(schema.scenes, eq(schema.scenes.presentationId, presentationId)))
    .orderBy(asc(schema.scenes.position));

  const presenters = await scope.db
    .select({
      id: schema.presenters.id,
      name: schema.presenters.name,
      supportsMatting: schema.presenters.supportsMatting,
      heygenAvatarId: schema.presenters.heygenAvatarId,
    })
    .from(schema.presenters)
    .where(scope.own(schema.presenters));

  const jobs = await latestRenderJobs(
    scope,
    sceneRows.map((s) => s.id),
    presentation.defaultLang,
  );

  const scenes: SceneRenderRow[] = sceneRows.map((s) => {
    const job = jobs.get(s.id);
    return {
      id: s.id,
      position: s.position,
      name: s.name,
      title: s.title,
      wordCount: s.scriptWordCount,
      hasScript: !!s.script?.trim(),
      job: job
        ? {
            status: job.status,
            durationSec: job.durationSec,
            costUsd: job.costUsd,
            error: job.error,
            updatedAt: job.updatedAt.toISOString(),
          }
        : null,
    };
  });

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-8">
      <p className="max-w-[620px] text-sm text-ink-2">
        Per-scene avatar renders. Renders run in the background — a scene only re-renders when its
        script, language or presenter changed.
      </p>

      <RenderPanel
        orgSlug={orgSlug}
        presentationId={presentation.id}
        defaultPresenterId={presentation.defaultPresenterId}
        presenters={presenters}
        scenes={scenes}
      />
    </div>
  );
}
