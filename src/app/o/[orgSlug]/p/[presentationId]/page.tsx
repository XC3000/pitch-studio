import { asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { catalog, QA_MODEL } from "@/lib/llm";
import { mediaUrl } from "@/lib/r2";
import type { MetricFormat } from "@/viewer/types";
import type { GenerationStatus } from "../../actions";
import { GenerationGate } from "./generation-gate";
import {
  SceneBuilder,
  type BuilderScene,
  type BuilderDoc,
  type BuilderMetric,
  type BuilderModel,
  type BuilderTemplate,
} from "./scene-builder";

export default async function BuildPage({
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

  // Latest completed render per scene (any presenter/lang) → shown in the
  // builder's live preview; scenes with no render fall back to the cartoon.
  const renderRows = sceneRows.length
    ? await scope.db
        .select({
          sceneId: schema.renderJobs.sceneId,
          r2Key: schema.renderJobs.r2Key,
          createdAt: schema.renderJobs.createdAt,
        })
        .from(schema.renderJobs)
        .where(
          scope.own(
            schema.renderJobs,
            eq(schema.renderJobs.status, "done"),
            inArray(
              schema.renderJobs.sceneId,
              sceneRows.map((s) => s.id),
            ),
          ),
        )
        .orderBy(desc(schema.renderJobs.createdAt))
    : [];
  const videoBySceneId = new Map<string, { url: string; kind: "webm-alpha" | "chroma" }>();
  for (const r of renderRows) {
    if (r.r2Key && !videoBySceneId.has(r.sceneId)) {
      videoBySceneId.set(r.sceneId, {
        url: mediaUrl(r.r2Key),
        kind: r.r2Key.endsWith(".webm") ? "webm-alpha" : "chroma",
      });
    }
  }

  const metricRows = await scope.db
    .select()
    .from(schema.metricLibraryItems)
    .where(scope.own(schema.metricLibraryItems))
    .orderBy(asc(schema.metricLibraryItems.label));

  const docRows = await scope.db
    .select({
      id: schema.documents.id,
      filename: schema.documents.filename,
      status: schema.documents.status,
      ragEnabled: schema.documents.ragEnabled,
    })
    .from(schema.documents)
    .where(scope.own(schema.documents))
    .orderBy(asc(schema.documents.filename));

  // built-in templates (org_id null) + this org's generated ones
  const templateRows = await scope.db
    .select({
      id: schema.visualTemplates.id,
      key: schema.visualTemplates.key,
      name: schema.visualTemplates.name,
      source: schema.visualTemplates.source,
      spec: schema.visualTemplates.spec,
      previewParams: schema.visualTemplates.previewParams,
    })
    .from(schema.visualTemplates)
    .where(or(isNull(schema.visualTemplates.orgId), eq(schema.visualTemplates.orgId, org.id)))
    .orderBy(asc(schema.visualTemplates.name));

  const scenes: BuilderScene[] = sceneRows.map((s) => ({
    id: s.id,
    position: s.position,
    name: s.name,
    intent: s.intent,
    title: s.title,
    subtitle: s.subtitle,
    script: s.script,
    scriptWordCount: s.scriptWordCount,
    estSeconds: s.estSeconds,
    templateId: s.templateId,
    templateParams: (s.templateParams ?? {}) as Record<string, unknown>,
    metricIds: (s.metricIds as string[]) ?? [],
    documentIds: (s.documentIds as string[]) ?? [],
    readiness: s.readiness,
    videoUrl: videoBySceneId.get(s.id)?.url ?? null,
    videoKind: videoBySceneId.get(s.id)?.kind ?? null,
  }));

  const metrics: BuilderMetric[] = metricRows.map((m) => ({
    id: m.id,
    key: m.key,
    label: m.label,
    sublabel: m.sublabel,
    rawValue: m.rawValue == null ? null : Number(m.rawValue),
    format: m.format as MetricFormat,
  }));

  const docs: BuilderDoc[] = docRows.map((d) => ({
    id: d.id,
    filename: d.filename,
    status: d.status,
    ragEnabled: d.ragEnabled,
  }));
  const templates: BuilderTemplate[] = templateRows.map((t) => {
    const gen = t.source === "generated";
    const spec = (t.spec ?? {}) as { layout?: BuilderTemplate["spec"]; paramSchema?: BuilderTemplate["paramSchema"] };
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      // generated templates carry the DSL layout + param docs so the builder can
      // draw them AND show a "how to fill it" field guide with Insert-example.
      spec: gen ? spec.layout ?? null : null,
      paramSchema: gen ? spec.paramSchema ?? [] : undefined,
      previewParams: gen ? ((t.previewParams ?? {}) as Record<string, unknown>) : undefined,
    };
  });

  const generation = (presentation.settings as { generation?: GenerationStatus } | null)?.generation;

  let models: BuilderModel[] = [];
  try {
    models = (await catalog()).map((m) => ({ id: m.id, label: m.label, free: m.free }));
  } catch {
    models = [{ id: QA_MODEL, label: QA_MODEL, free: false }];
  }

  return (
    <>
      <SceneBuilder
        orgSlug={orgSlug}
        presentationId={presentationId}
        initialScenes={scenes}
        metrics={metrics}
        docs={docs}
        templates={templates}
        models={models}
        defaultModel={QA_MODEL}
      />
      {generation && (generation.status === "generating" || generation.status === "failed") && (
        <GenerationGate orgSlug={orgSlug} presentationId={presentationId} initial={generation} />
      )}
    </>
  );
}
