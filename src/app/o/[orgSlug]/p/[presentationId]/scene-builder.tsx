"use client";

/**
 * Scene Builder — the 3-zone editor from design-reference/pitch-studio-admin-design.html.
 *   Left rail   — the scene filmstrip (select / reorder / add / delete).
 *   Center      — the working canvas: intent, the live preview frame in the
 *                 middle, the generated heading, and the spoken script.
 *   Right       — the inspector: metrics (pick OR create inline), visual
 *                 template, supporting documents (attach OR upload, with a
 *                 "add to Q&A?" RAG toggle), and the AI-generation model.
 *
 * Generation is optional: "Generate" fills script + cue params from the intent
 * when the active LLM provider's key is set (see src/lib/llm.ts — DeepSeek
 * direct by default, or OpenRouter). The model list comes from that provider's
 * catalog(), fetched server-side and passed in as `models`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Volume2, VolumeX, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { runWithToast, useAction } from "@/hooks/use-action";
import { AvatarPlaceholder } from "@/viewer/avatar";
import { AvatarVideo } from "@/viewer/avatar-video";
import { CueStage } from "@/viewer/cues";
import { CUE_SCHEMAS, type CueSchema } from "@/viewer/cue-schemas";
import { formatMetric } from "@/viewer/format";
import { DEFAULT_CUE_POS, DEFAULT_METRICS_POS, defaultMetricPos } from "@/viewer/types";
import type {
  DeckVideoKind,
  MetricFormat,
  SceneCueRef,
  SceneLayout,
  SceneMedia,
  ScenePos,
} from "@/viewer/types";
import "@/viewer/viewer.css";
import { slugify } from "@/lib/slug";
import { generateSceneAction } from "./generate-actions";
import { toast } from "sonner";
import { draftVisualBrief, proposeTemplateAction } from "../../queue/actions";
import {
  createScene,
  createSceneMetric,
  deleteScene,
  reorderScenes,
  startSceneMediaUpload,
  updateScene,
  updateSceneMetric,
  type NewMetric,
  type ScenePatch,
} from "./scene-actions";
import { deleteDocument, finishDocumentUpload, startDocumentUpload } from "../../knowledge/actions";

export type BuilderScene = {
  id: string;
  position: number;
  name: string;
  intent: string;
  title: string | null;
  subtitle: string | null;
  script: string | null;
  scriptWordCount: number;
  estSeconds: number;
  templateId: string | null;
  templateParams: Record<string, unknown>;
  metricIds: string[];
  documentIds: string[];
  readiness: "draft" | "needs_review" | "ready";
  /** latest completed render for this scene, if any — shown in the preview */
  videoUrl: string | null;
  videoKind: DeckVideoKind | null;
};

export type BuilderMetric = {
  id: string;
  key: string;
  label: string;
  sublabel: string | null;
  rawValue: number | null;
  format: MetricFormat;
};
export type BuilderDoc = { id: string; filename: string; status: string; ragEnabled: boolean };
export type BuilderTemplate = {
  id: string;
  key: string;
  name: string;
  /** generated-template DSL layout (M5); null for built-ins. Lets the preview
   *  render a generated template the same way the published viewer does. */
  spec?: import("@/lib/template-dsl").LayoutNode | null;
  /** generated-template param declarations — drive the cue-editor field guide. */
  paramSchema?: { name: string; type: string; label?: string }[];
  /** generated-template example values — the "Insert example" prepopulate payload. */
  previewParams?: Record<string, unknown>;
};
export type BuilderModel = { id: string; label: string; free: boolean };

/** which placed element on the canvas is currently selected (size/params/remove) */
type BuilderSelection =
  | { kind: "cue" }
  | { kind: "extra"; id: string }
  | { kind: "metric"; id: string }
  | { kind: "media"; id: string }
  | null;

type Target = Exclude<BuilderSelection, null>;

/** default placement of a freshly-added extra visual (below the primary). */
const NEW_EXTRA_POS: ScenePos = { x: 720, y: 430, scale: 0.9 };

/** default placement of a freshly-added image/video (below the primary). */
const NEW_MEDIA_POS: ScenePos = { x: 720, y: 400, scale: 1 };

/** current placement of any target element within a scene layout. */
function targetPos(layout: SceneLayout, target: Target, focusIds: string[]): ScenePos {
  if (target.kind === "cue") return layout.cue ?? DEFAULT_CUE_POS;
  if (target.kind === "extra")
    return (layout.extraCues ?? []).find((e) => e.id === target.id)?.pos ?? NEW_EXTRA_POS;
  if (target.kind === "media")
    return (layout.media ?? []).find((m) => m.id === target.id)?.pos ?? NEW_MEDIA_POS;
  const i = Math.max(0, focusIds.indexOf(target.id));
  return (
    layout.metricItems?.[target.id] ??
    defaultMetricPos(i, focusIds.length || 1, layout.metrics ?? DEFAULT_METRICS_POS)
  );
}

/** write a target element's placement back into a scene layout. */
function withTargetPos(layout: SceneLayout, target: Target, pos: ScenePos): SceneLayout {
  if (target.kind === "cue") return { ...layout, cue: pos };
  if (target.kind === "metric")
    return { ...layout, metricItems: { ...(layout.metricItems ?? {}), [target.id]: pos } };
  if (target.kind === "media")
    return { ...layout, media: (layout.media ?? []).map((m) => (m.id === target.id ? { ...m, pos } : m)) };
  return {
    ...layout,
    extraCues: (layout.extraCues ?? []).map((e) => (e.id === target.id ? { ...e, pos } : e)),
  };
}

const clampScale = (s: number) => Math.max(0.4, Math.min(2.5, Math.round(s * 100) / 100));

const READINESS_DOT: Record<string, string> = {
  draft: "bg-ink-3",
  needs_review: "bg-warn",
  ready: "bg-ok",
};
const READINESS_LABEL: Record<string, string> = {
  draft: "draft",
  needs_review: "needs review",
  ready: "script ready",
};

const wordCount = (s: string | null) => (s?.trim() ? s.trim().split(/\s+/).length : 0);
const estSeconds = (s: string | null) => Math.max(6, Math.round(wordCount(s) * 0.4));

export function SceneBuilder({
  orgSlug,
  presentationId,
  initialScenes,
  metrics: initialMetrics,
  docs: initialDocs,
  templates,
  models,
  defaultModel,
}: {
  orgSlug: string;
  presentationId: string;
  initialScenes: BuilderScene[];
  metrics: BuilderMetric[];
  docs: BuilderDoc[];
  templates: BuilderTemplate[];
  models: BuilderModel[];
  defaultModel: string;
}) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [uploading, setUploading] = useState(false);
  const [scenes, setScenes] = useState(initialScenes);
  // Metrics & docs are editable from inside the builder, so they live in state.
  const [metrics, setMetrics] = useState(initialMetrics);
  const [docs, setDocs] = useState(initialDocs);
  const [selectedId, setSelectedId] = useState<string | null>(initialScenes[0]?.id ?? null);
  const [genModel, setGenModel] = useState<string>(defaultModel);
  const [deletingScene, setDeletingScene] = useState<BuilderScene | null>(null);
  // "Propose a custom visual" is a two-step flow: draft an editable brief, then
  // (on confirm) generate the template from it.
  const [briefOpen, setBriefOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);

  const selected = scenes.find((s) => s.id === selectedId) ?? null;
  const [draft, setDraft] = useState<BuilderScene | null>(selected);
  // which placed element is selected on the canvas (for size/params/remove)
  const [pick, setPick] = useState<BuilderSelection>(null);
  // Re-seed the draft when selection changes (derived-state-during-render).
  const [draftFor, setDraftFor] = useState<string | null>(selectedId);
  if (selectedId !== draftFor) {
    setDraftFor(selectedId);
    setDraft(scenes.find((s) => s.id === selectedId) ?? null);
    setPick(null);
  }

  const templateKeyById = useMemo(() => new Map(templates.map((t) => [t.id, t.key])), [templates]);
  const templateSpecById = useMemo(
    () => new Map(templates.map((t) => [t.id, t.spec ?? null])),
    [templates],
  );
  const genGuideById = useMemo(
    () => new Map(templates.filter((t) => t.spec).map((t) => [t.id, deriveGeneratedGuide(t)])),
    [templates],
  );
  const metricById = useMemo(() => new Map(metrics.map((m) => [m.id, m])), [metrics]);
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);

  const dirty = draft && selected ? JSON.stringify(draft) !== JSON.stringify(selected) : false;
  const patch = (p: Partial<BuilderScene>) => draft && setDraft({ ...draft, ...p });

  // ── canvas layout (free placement + size of visuals & metrics) ─────────────
  const sceneLayout = (draft?.templateParams.layout as SceneLayout) ?? {};
  const patchLayout = (next: SceneLayout) =>
    draft && patch({ templateParams: { ...draft.templateParams, layout: next } });

  const addExtraCue = (templateId: string) => {
    if (!draft) return;
    const t = templates.find((x) => x.id === templateId);
    const key = t?.key ?? null;
    // seed with sensible params so the added visual renders something immediately
    const params = t?.spec ? t.previewParams ?? {} : key ? CUE_SCHEMAS[key]?.example ?? {} : {};
    const id = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const ec: SceneCueRef = { id, templateId, params, pos: { ...NEW_EXTRA_POS } };
    patchLayout({ ...sceneLayout, extraCues: [...(sceneLayout.extraCues ?? []), ec] });
    setPick({ kind: "extra", id });
  };
  const removeExtraCue = (id: string) => {
    patchLayout({ ...sceneLayout, extraCues: (sceneLayout.extraCues ?? []).filter((e) => e.id !== id) });
    setPick(null);
  };
  const setExtraCueParams = (id: string, params: Record<string, unknown>) =>
    patchLayout({
      ...sceneLayout,
      extraCues: (sceneLayout.extraCues ?? []).map((e) => (e.id === id ? { ...e, params } : e)),
    });

  const removeMedia = (id: string) => {
    patchLayout({ ...sceneLayout, media: (sceneLayout.media ?? []).filter((m) => m.id !== id) });
    setPick(null);
  };

  // upload an image/video to the public media bucket and drop it on the canvas
  const uploadMedia = async (file: File) => {
    if (!draft) return;
    const kind: SceneMedia["kind"] = file.type.startsWith("video/") ? "video" : "image";
    const ext = file.name.split(".").pop() ?? (kind === "video" ? "mp4" : "png");
    setUploading(true);
    try {
      const media = await runWithToast(
        async () => {
          const started = await startSceneMediaUpload(orgSlug, { contentType: file.type, ext });
          if (!started.ok) throw new Error(started.error);
          const put = await fetch(started.data.uploadUrl, {
            method: "PUT",
            headers: { "content-type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!put.ok) {
            throw new Error(`Upload failed (${put.status}) — check R2 CORS allows PUT from this origin.`);
          }
          const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          const item: SceneMedia = {
            id,
            kind,
            url: started.data.publicUrl,
            w: kind === "video" ? 520 : 420,
            pos: { ...NEW_MEDIA_POS },
          };
          return item;
        },
        { loading: "Uploading…", success: `${kind === "video" ? "Video" : "Image"} added to the scene` },
      );
      if (!media) return;
      // read latest layout at apply-time (draft may have changed during upload)
      setDraft((d) =>
        d
          ? {
              ...d,
              templateParams: {
                ...d.templateParams,
                layout: {
                  ...((d.templateParams.layout as SceneLayout) ?? {}),
                  media: [...(((d.templateParams.layout as SceneLayout) ?? {}).media ?? []), media],
                },
              },
            }
          : d,
      );
      setPick({ kind: "media", id: media.id });
    } finally {
      setUploading(false);
    }
  };

  // size the currently-selected element
  const setSelectedScale = (scale: number) => {
    if (!draft || !pick) return;
    const cur = targetPos(sceneLayout, pick, draft.metricIds);
    patchLayout(withTargetPos(sceneLayout, pick, { ...cur, scale: clampScale(scale) }));
  };

  // ── propose a custom visual: draft an editable brief, then generate from it ──
  const draftBrief = async (hint?: string) => {
    if (!draft) return;
    setBriefLoading(true);
    const res = await draftVisualBrief(orgSlug, { sceneId: draft.id, hint, model: genModel });
    setBriefLoading(false);
    if (res.ok) setBrief(res.data.brief);
    else toast.error(res.error);
  };
  const openBrief = () => {
    if (!draft) return;
    setBrief("");
    setBriefOpen(true);
    void draftBrief(draft.intent.trim() || undefined);
  };
  const createFromBrief = () =>
    run(() => proposeTemplateAction(orgSlug, { intent: brief, sceneId: draft!.id, model: genModel }), {
      loading: "Creating the visual…",
      success: (d) => `Proposed “${d.name}” — approve it in the queue`,
      onSuccess: () => {
        setBriefOpen(false);
        router.push(`/o/${orgSlug}/queue`);
      },
      refresh: false,
    });

  // when an extra visual is selected, the cue-params editor edits IT (not the primary)
  const activeExtra =
    pick?.kind === "extra" ? (sceneLayout.extraCues ?? []).find((e) => e.id === pick.id) ?? null : null;
  const activeCueTemplateId = activeExtra ? activeExtra.templateId : draft?.templateId ?? null;
  const selScale = draft && pick ? targetPos(sceneLayout, pick, draft.metricIds).scale ?? 1 : 1;
  const pickLabel = !pick
    ? ""
    : pick.kind === "cue"
      ? "Visual template"
      : pick.kind === "extra"
        ? `Extra visual · ${templates.find((t) => t.id === activeExtra?.templateId)?.name ?? "visual"}`
        : pick.kind === "media"
          ? `${(sceneLayout.media ?? []).find((m) => m.id === pick.id)?.kind === "video" ? "Video" : "Image"}`
          : `Metric · ${metricById.get(pick.id)?.label ?? ""}`;

  const save = () => {
    if (!draft) return;
    const params = {
      ...draft.templateParams,
      sceneKey: (draft.templateParams.sceneKey as string) || slugify(draft.name).replace(/-/g, "_"),
    };
    const body: ScenePatch = {
      name: draft.name,
      intent: draft.intent,
      title: draft.title,
      subtitle: draft.subtitle,
      script: draft.script,
      templateId: draft.templateId,
      templateParams: params,
      metricIds: draft.metricIds,
      documentIds: draft.documentIds,
      readiness: draft.readiness,
    };
    run(() => updateScene(orgSlug, presentationId, draft.id, body), {
      success: "Scene saved",
      onSuccess: () =>
        setScenes((prev) => prev.map((s) => (s.id === draft.id ? { ...draft, templateParams: params } : s))),
    });
  };

  const addScene = () =>
    run(() => createScene(orgSlug, presentationId), {
      success: "Scene added",
      onSuccess: ({ sceneId }) => {
        const fresh: BuilderScene = {
          id: sceneId,
          position: scenes.length,
          name: "New scene",
          intent: "",
          title: null,
          subtitle: null,
          script: null,
          scriptWordCount: 0,
          estSeconds: 0,
          templateId: null,
          templateParams: {},
          metricIds: [],
          documentIds: [],
          readiness: "draft",
          videoUrl: null,
          videoKind: null,
        };
        setScenes((prev) => [...prev, fresh]);
        setSelectedId(sceneId);
      },
    });

  const removeScene = (id: string) =>
    run(() => deleteScene(orgSlug, presentationId, id), {
      success: "Scene deleted",
      onSuccess: () => {
        setScenes((prev) => prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, position: i })));
        if (selectedId === id) setSelectedId(null);
        setDeletingScene(null);
      },
    });

  const move = (id: string, dir: -1 | 1) => {
    const idx = scenes.findIndex((s) => s.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= scenes.length) return;
    const next = [...scenes];
    [next[idx], next[to]] = [next[to], next[idx]];
    setScenes(next.map((s, i) => ({ ...s, position: i })));
    // Silent on success (reorders are frequent); errors toast + resync.
    run(() => reorderScenes(orgSlug, presentationId, next.map((s) => s.id)), {
      onError: () => router.refresh(),
    });
  };

  const generate = () => {
    if (!draft) return;
    run(
      () =>
        generateSceneAction(orgSlug, presentationId, draft.id, {
          intent: draft.intent,
          templateKey: draft.templateId ? templateKeyById.get(draft.templateId) ?? null : null,
          model: genModel,
        }),
      {
        loading: "Drafting with AI…",
        success: (d) => `Draft ready — ${d.model} · $${d.costUsd.toFixed(3)}`,
        onSuccess: (d) =>
          patch({
            title: d.scene.title,
            subtitle: d.scene.subtitle,
            script: d.scene.script,
            templateParams: { ...draft.templateParams, cue: d.scene.cue },
          }),
      },
    );
  };

  // ── metric + document mutations from the inspector ────────────────────────
  const attachMetric = (id: string) =>
    draft && !draft.metricIds.includes(id) && patch({ metricIds: [...draft.metricIds, id] });
  const detachMetric = (id: string) => draft && patch({ metricIds: draft.metricIds.filter((x) => x !== id) });

  const createMetric = async (input: NewMetric): Promise<boolean> => {
    const metric = await run(() => createSceneMetric(orgSlug, presentationId, input), {
      success: "Metric created",
    });
    if (!metric) return false;
    setMetrics((prev) => [...prev, metric]);
    attachMetric(metric.id);
    return true;
  };

  const updateMetric = async (id: string, input: NewMetric): Promise<boolean> => {
    const metric = await run(() => updateSceneMetric(orgSlug, presentationId, id, input), {
      success: "Metric updated",
    });
    if (!metric) return false;
    setMetrics((prev) => prev.map((m) => (m.id === metric.id ? metric : m)));
    return true;
  };

  const attachDoc = (id: string) =>
    draft && !draft.documentIds.includes(id) && patch({ documentIds: [...draft.documentIds, id] });
  const detachDoc = (id: string) => draft && patch({ documentIds: draft.documentIds.filter((x) => x !== id) });

  const uploadDoc = async (file: File, ragEnabled: boolean): Promise<boolean> => {
    setUploading(true);
    try {
      const doc = await runWithToast(
        async () => {
          const started = await startDocumentUpload(orgSlug, {
            filename: file.name,
            mime: file.type,
            bytes: file.size,
            ragEnabled,
          });
          if (!started.ok) throw new Error(started.error);
          const put = await fetch(started.data.uploadUrl, {
            method: "PUT",
            headers: { "content-type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!put.ok) {
            await deleteDocument(orgSlug, started.data.documentId);
            throw new Error(`Upload failed (${put.status}) — check R2 CORS allows PUT from this origin.`);
          }
          const finished = await finishDocumentUpload(orgSlug, started.data.documentId);
          if (!finished.ok) throw new Error(finished.error);
          const fresh: BuilderDoc = {
            id: started.data.documentId,
            filename: file.name,
            status: ragEnabled ? "uploaded" : "stored",
            ragEnabled,
          };
          return fresh;
        },
        {
          loading: "Uploading…",
          success: ragEnabled
            ? "Document uploaded — indexing for Q&A…"
            : "Document uploaded as evidence (not searchable)",
        },
      );
      if (!doc) return false;
      setDocs((prev) => [doc, ...prev]);
      attachDoc(doc.id);
      return true;
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid h-[calc(100vh-168px)] min-h-[560px] grid-cols-1 lg:grid-cols-[264px_minmax(0,1fr)_340px]">
      {/* ── LEFT RAIL: scene filmstrip ──────────────────────────────── */}
      <aside className="overflow-y-auto border-b border-line bg-panel p-4 lg:border-r lg:border-b-0">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-ink-3 italic">Scenes play in order →</span>
          <span className="eyebrow">{scenes.length}</span>
        </div>
        <div className="flex flex-col gap-2.5">
          {scenes.map((s, i) => {
            const tmpl = s.templateId ? templateKeyById.get(s.templateId) : null;
            const docCount = s.documentIds.length;
            return (
              <div
                key={s.id}
                className={`group relative rounded-[11px] border px-3 py-2.5 transition ${
                  s.id === selectedId
                    ? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]"
                    : "border-line bg-panel-2 hover:border-accent-line"
                }`}
              >
                <button onClick={() => setSelectedId(s.id)} className="block w-full text-left">
                  <div className="font-mono text-[10px] text-ink-3">{String(i + 1).padStart(2, "0")}</div>
                  <div className="mt-1 truncate text-[13px] font-semibold">{s.name}</div>
                  {tmpl && (
                    <span className="mt-2 inline-block rounded-[5px] bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold tracking-[.06em] text-accent uppercase">
                      {tmpl}
                    </span>
                  )}
                  <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                    <span className={`h-1.5 w-1.5 rounded-full ${READINESS_DOT[s.readiness]}`} />
                    {READINESS_LABEL[s.readiness]}
                    {docCount > 0 && <span>· {docCount} doc{docCount > 1 ? "s" : ""}</span>}
                  </div>
                </button>
                <div className="absolute top-2 right-2 flex items-center opacity-0 transition group-hover:opacity-100">
                  <button onClick={() => move(s.id, -1)} disabled={i === 0} className="px-1 text-ink-3 disabled:opacity-30" aria-label="Move up">
                    <ArrowUp className="size-3" />
                  </button>
                  <button onClick={() => move(s.id, 1)} disabled={i === scenes.length - 1} className="px-1 text-ink-3 disabled:opacity-30" aria-label="Move down">
                    <ArrowDown className="size-3" />
                  </button>
                  <button onClick={() => setDeletingScene(s)} className="px-1 text-bad" aria-label="Delete scene">
                    <X className="size-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <Button
          variant="outline"
          onClick={addScene}
          disabled={pending}
          className="mt-3 w-full rounded-[11px] border-dashed border-line bg-transparent py-2.5 text-[12px] font-semibold text-ink-2 hover:border-accent-line hover:bg-transparent hover:text-accent"
        >
          + Add scene
        </Button>
      </aside>

      {/* ── CENTER CANVAS ───────────────────────────────────────────── */}
      <section className="overflow-y-auto bg-ground px-6 py-5">
        {!draft ? (
          <div className="grid h-full place-items-center text-[13px] text-ink-3">
            Select a scene on the left, or add one.
          </div>
        ) : (
          <div className="mx-auto max-w-[760px]">
            {/* head */}
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="truncate text-[22px]">
                  Scene {String((draft.position ?? 0) + 1).padStart(2, "0")} — {draft.name}
                </h3>
                <div className="mt-1 flex items-center gap-2">
                  <Select
                    value={draft.readiness}
                    onValueChange={(v) => patch({ readiness: v as BuilderScene["readiness"] })}
                  >
                    <SelectTrigger size="sm" className="w-auto text-[11.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">draft</SelectItem>
                      <SelectItem value="needs_review">needs review</SelectItem>
                      <SelectItem value="ready">ready</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                onClick={save}
                disabled={pending || !dirty}
                className="h-auto flex-none rounded-[10px] bg-linear-to-br from-accent-2 to-accent px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
              >
                {dirty ? "Save scene" : "Saved"}
              </Button>
            </div>

            <NumberedCard num={1} eyebrow="What should this scene land?">
              <Textarea
                className="w-full resize-y rounded-[10px] border-line bg-panel-2 px-3.5 py-3 text-[13.5px] leading-relaxed focus-visible:border-accent focus-visible:ring-0"
                style={{ minHeight: 70 }}
                placeholder="Tell it in plain words what you're trying to prove — e.g. Prove our scale: 140k cases, 96% completed, one owner per case. Warm, human, not a boast."
                value={draft.intent}
                onChange={(e) => patch({ intent: e.target.value })}
              />
              <p className="mt-1.5 text-[11px] text-ink-3">
                Drives the generated script &amp; the visual the model suggests.
              </p>
            </NumberedCard>

            <NumberedCard num={2} eyebrow="Generated frame — live preview">
              <PreviewFrame
                draft={draft}
                templateKey={draft.templateId ? templateKeyById.get(draft.templateId) ?? null : null}
                templateSpec={draft.templateId ? templateSpecById.get(draft.templateId) ?? null : null}
                metricById={metricById}
                docCount={draft.documentIds.length}
                onLayout={patchLayout}
                pick={pick}
                setPick={setPick}
                cueFor={(id) => ({
                  key: templateKeyById.get(id) ?? "",
                  spec: templateSpecById.get(id) ?? null,
                })}
              />
            </NumberedCard>

            <NumberedCard num={3} eyebrow="Scene heading — generated, editable">
              <div className="rounded-[10px] border border-line bg-panel-2 px-3.5 py-3">
                <div className="eyebrow">Scene name (internal)</div>
                <Input
                  className="mt-1 h-auto w-full rounded-none border-none bg-transparent p-0 text-[14px] font-semibold text-ink focus-visible:text-accent focus-visible:ring-0"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className="mt-2.5 rounded-[10px] border border-line bg-panel-2 px-3.5 py-3">
                <div className="eyebrow">Title (shown on the frame)</div>
                <Input
                  className="mt-1 h-auto w-full rounded-none border-none bg-transparent p-0 text-[18px] font-bold tracking-tight text-ink focus-visible:text-accent focus-visible:ring-0"
                  value={draft.title ?? ""}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="Every case is a real person"
                />
              </div>
              <div className="mt-2.5 rounded-[10px] border border-line bg-panel-2 px-3.5 py-3">
                <div className="eyebrow">Subtitle</div>
                <Input
                  className="mt-1 h-auto w-full rounded-none border-none bg-transparent p-0 text-[13px] text-ink-2 focus-visible:text-accent focus-visible:ring-0"
                  value={draft.subtitle ?? ""}
                  onChange={(e) => patch({ subtitle: e.target.value })}
                  placeholder="One line under the title"
                />
              </div>
            </NumberedCard>

            <NumberedCard num={4} eyebrow="Orator script — generated, editable">
              <Textarea
                className="w-full resize-y rounded-[10px] border-line bg-panel-2 px-4 py-3.5 text-[13.5px] leading-[1.65] focus-visible:border-accent focus-visible:ring-0"
                style={{ minHeight: 140 }}
                placeholder="What the presenter says on this scene…"
                value={draft.script ?? ""}
                onChange={(e) => patch({ script: e.target.value })}
              />
              <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[11px] text-ink-3">
                <span>~{estSeconds(draft.script)}s spoken</span>
                <span>{wordCount(draft.script)} words</span>
              </div>
            </NumberedCard>

            <details className="mt-3.5 rounded-[16px] border border-line bg-panel px-4 py-3 shadow-card">
              <summary className="cursor-pointer text-[11.5px] font-semibold text-ink-2">
                Cue parameters (JSON) — advanced
              </summary>
              <p className="mt-2 mb-1.5 text-[11px] text-ink-3">
                {activeExtra
                  ? `Editing the selected extra visual (${templateKeyById.get(activeExtra.templateId) ?? "visual"}).`
                  : `Drives the ${activeCueTemplateId ? templateKeyById.get(activeCueTemplateId) : "visual"} illustration. Usually filled by Generate.`}
              </p>
              <CueParamsEditor
                templateKey={activeCueTemplateId ? templateKeyById.get(activeCueTemplateId) ?? null : null}
                genSchema={activeCueTemplateId ? genGuideById.get(activeCueTemplateId) ?? null : null}
                value={
                  activeExtra
                    ? activeExtra.params ?? {}
                    : (draft.templateParams.cue as Record<string, unknown>) ?? {}
                }
                onChange={(v) =>
                  activeExtra
                    ? setExtraCueParams(activeExtra.id, v)
                    : patch({ templateParams: { ...draft.templateParams, cue: v } })
                }
              />
            </details>
          </div>
        )}
      </section>

      {/* ── RIGHT INSPECTOR ─────────────────────────────────────────── */}
      <aside className="flex flex-col overflow-y-auto border-t border-line bg-panel lg:border-t-0 lg:border-l">
        {draft ? (
          <>
            <div className="flex-1 p-4">
              {pick && (
                <div className="mb-4 rounded-[12px] border border-accent-line bg-accent-soft/40 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold text-accent">Selected · {pickLabel}</div>
                    <button
                      type="button"
                      onClick={() => setPick(null)}
                      className="text-[11px] text-ink-3 hover:text-ink"
                    >
                      Deselect
                    </button>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="w-9 text-[11px] text-ink-2">Size</span>
                    <Slider
                      min={0.4}
                      max={2.5}
                      step={0.05}
                      value={[selScale]}
                      onValueChange={([v]) => setSelectedScale(v)}
                      className="flex-1"
                    />
                    <span className="w-9 text-right text-[11px] tabular-nums text-ink-2">
                      {Math.round(selScale * 100)}%
                    </span>
                  </div>
                  {pick.kind === "extra" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 h-auto w-full py-1.5 text-[11px] text-bad"
                      onClick={() => removeExtraCue(pick.id)}
                    >
                      Remove this visual
                    </Button>
                  )}
                  {pick.kind === "media" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 h-auto w-full py-1.5 text-[11px] text-bad"
                      onClick={() => removeMedia(pick.id)}
                    >
                      Remove this media
                    </Button>
                  )}
                  <p className="mt-2 text-[10.5px] text-ink-3">
                    Drag it on the canvas to move · slider to resize.
                  </p>
                </div>
              )}
              <InspectorSection title="Numbers in this scene">
                <MetricInspector
                  attached={draft.metricIds.map((id) => metricById.get(id)).filter((m): m is BuilderMetric => !!m)}
                  available={metrics.filter((m) => !draft.metricIds.includes(m.id))}
                  onAttach={attachMetric}
                  onDetach={detachMetric}
                  onCreate={createMetric}
                  onUpdate={updateMetric}
                  pending={pending}
                />
                <p className="mt-2 text-[11px] text-ink-3">
                  Pulled from your metric library — formatting stays consistent everywhere.
                </p>
              </InspectorSection>

              <InspectorSection title="Visual template">
                <div className="grid grid-cols-2 gap-2">
                  <TemplateTile
                    selected={!draft.templateId}
                    name="None"
                    onClick={() => patch({ templateId: null })}
                  />
                  {templates.map((t) => (
                    <TemplateTile
                      key={t.id}
                      selected={draft.templateId === t.id}
                      name={t.name}
                      onClick={() => patch({ templateId: t.id })}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  className="mt-2 h-auto w-full py-2 text-[12px]"
                  disabled={pending}
                  onClick={openBrief}
                >
                  ✨ Propose a custom visual
                </Button>
                <p className="mt-2 text-[11px] text-ink-3">
                  No template fits? Draft an editable brief of the visual to make, then generate it
                  — it lands in the approval queue before it can be used.
                </p>

                {/* multiple visuals — add more templates and place each anywhere */}
                <div className="mt-3 border-t border-line pt-3">
                  <div className="text-[11px] font-semibold text-ink-2">Additional visuals</div>
                  {(sceneLayout.extraCues ?? []).length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {(sceneLayout.extraCues ?? []).map((ec) => {
                        const on = pick?.kind === "extra" && pick.id === ec.id;
                        return (
                          <div
                            key={ec.id}
                            className={`flex items-center justify-between rounded-[8px] border px-2.5 py-1.5 text-[11px] ${on ? "border-accent bg-accent-soft/40" : "border-line"}`}
                          >
                            <button
                              type="button"
                              className="truncate text-left"
                              onClick={() => setPick({ kind: "extra", id: ec.id })}
                            >
                              {templates.find((t) => t.id === ec.templateId)?.name ?? "visual"}
                            </button>
                            <button
                              type="button"
                              className="ml-2 flex-none text-ink-3 hover:text-bad"
                              onClick={() => removeExtraCue(ec.id)}
                              aria-label="Remove visual"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <Select value="" onValueChange={(id) => addExtraCue(id)}>
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue placeholder="+ Add another visual…" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1.5 text-[11px] text-ink-3">
                    Each added visual is drag-to-move &amp; resizable; select it to edit its params.
                  </p>
                </div>
              </InspectorSection>

              <InspectorSection title="Images & video">
                <label
                  className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-line py-2.5 text-[12px] text-ink-2 transition hover:border-accent hover:text-accent ${uploading ? "pointer-events-none opacity-60" : ""}`}
                >
                  <input
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadMedia(f);
                      e.currentTarget.value = "";
                    }}
                  />
                  ⬆ Upload image or video
                </label>
                {(sceneLayout.media ?? []).length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {(sceneLayout.media ?? []).map((md) => {
                      const on = pick?.kind === "media" && pick.id === md.id;
                      return (
                        <div
                          key={md.id}
                          className={`flex items-center justify-between rounded-[8px] border px-2.5 py-1.5 text-[11px] ${on ? "border-accent bg-accent-soft/40" : "border-line"}`}
                        >
                          <button
                            type="button"
                            className="truncate text-left"
                            onClick={() => setPick({ kind: "media", id: md.id })}
                          >
                            {md.kind === "video" ? "🎬 Video" : "🖼 Image"}
                          </button>
                          <button
                            type="button"
                            className="ml-2 flex-none text-ink-3 hover:text-bad"
                            onClick={() => removeMedia(md.id)}
                            aria-label="Remove media"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="mt-1.5 text-[11px] text-ink-3">
                  Placed on the canvas — drag to move, select to resize. Needs R2 media storage
                  configured.
                </p>
              </InspectorSection>

              <InspectorSection title="Supporting documents">
                <DocInspector
                  attached={draft.documentIds.map((id) => docById.get(id)).filter((d): d is BuilderDoc => !!d)}
                  available={docs.filter((d) => !draft.documentIds.includes(d.id))}
                  onAttach={attachDoc}
                  onDetach={detachDoc}
                  onUpload={uploadDoc}
                  pending={pending || uploading}
                />
                <p className="mt-2 text-[11px] text-ink-3">
                  Attached docs show as evidence. RAG-enabled ones are searched first when a viewer asks a
                  question on this scene.
                </p>
              </InspectorSection>

              <InspectorSection title="AI model for generation">
                <Select value={genModel} onValueChange={setGenModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.free ? "🆓 " : "💲 "}
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-2 text-[11px] text-ink-3">
                  {models.length <= 1
                    ? "Set the active LLM provider's API key to load the model catalog."
                    : "🆓 free · 💲 paid — pricing from the configured LLM provider."}
                </p>
              </InspectorSection>
            </div>

            {/* sticky generate bar */}
            <div className="sticky bottom-0 border-t border-line bg-panel/95 p-4 backdrop-blur">
              <Button
                onClick={generate}
                disabled={pending || !draft.intent.trim()}
                className="h-auto w-full gap-2 rounded-[11px] bg-linear-to-br from-accent-2 to-accent py-3 text-[13px] font-bold text-white shadow-[0_14px_30px_-12px_rgba(61,91,245,.7)]"
              >
                ✨ {pending ? "Generating…" : "Generate heading, script & visual"}
              </Button>
              <p className="mt-2 text-center text-[10.5px] text-ink-3">
                Runs the selected model from the intent above.
              </p>
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-[12px] text-ink-3">
            Select a scene to edit its metrics, template &amp; documents.
          </div>
        )}
      </aside>

      <AlertDialog open={deletingScene !== null} onOpenChange={(open) => !open && setDeletingScene(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deletingScene?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the scene from the presentation. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() => deletingScene && removeScene(deletingScene.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* propose-a-visual: edit the AI-drafted brief, then generate */}
      <Dialog open={briefOpen} onOpenChange={(o) => !o && !pending && setBriefOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Propose a custom visual</DialogTitle>
            <DialogDescription>
              Here’s a draft brief of the visual to build for this scene. Edit it to say exactly what
              you want, then generate — it lands in the approval queue.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-[160px] text-[13px]"
            placeholder={briefLoading ? "Drafting a brief…" : "Describe the visual to build…"}
            value={brief}
            disabled={briefLoading}
            onChange={(e) => setBrief(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="text-[11px] text-ink-2 underline-offset-2 hover:underline disabled:opacity-50"
              disabled={briefLoading || pending}
              onClick={() => void draftBrief(brief.trim() || draft?.intent.trim() || undefined)}
            >
              ↻ Re-draft{brief.trim() ? " from my edits" : ""}
            </button>
            <span className="text-[11px] text-ink-3">Model: {genModel}</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBriefOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={createFromBrief} disabled={pending || briefLoading || !brief.trim()}>
              ✨ {pending ? "Creating…" : "Generate visual"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── small building blocks ────────────────────────────────────────────────

function NumberedCard({ num, eyebrow, children }: { num: number; eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5 rounded-[16px] border border-line bg-panel p-[18px] shadow-card first:mt-0">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-accent-soft font-mono text-[11px] font-bold text-accent">
          {num}
        </span>
        <span className="eyebrow">{eyebrow}</span>
      </div>
      {children}
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 border-b border-line pb-4 last:mb-0 last:border-none last:pb-0">
      <div className="mb-3 eyebrow">{title}</div>
      {children}
    </section>
  );
}

function TemplateTile({ selected, name, onClick }: { selected: boolean; name: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-[10px] border bg-panel-2 px-2 py-2.5 text-center text-[11px] font-semibold transition ${
        selected ? "border-accent text-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line text-ink-2 hover:border-accent-line"
      }`}
    >
      {name}
      {selected && " ✓"}
    </button>
  );
}

// ── metric inspector: attached chips + pick/create popover ─────────────────

function MetricInspector({
  attached,
  available,
  onAttach,
  onDetach,
  onCreate,
  onUpdate,
  pending,
}: {
  attached: BuilderMetric[];
  available: BuilderMetric[];
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
  onCreate: (input: NewMetric) => Promise<boolean>;
  onUpdate: (id: string, input: NewMetric) => Promise<boolean>;
  pending: boolean;
}) {
  const [open, setOpen] = useState<null | "pick" | "create">(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editMetric = attached.find((m) => m.id === editing) ?? null;
  // a placeholder metric (literal "—") is the thing users most want to fill in
  const isPlaceholder = (m: BuilderMetric) => m.format.style === "literal" && m.format.text === "—";

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {attached.map((m) => (
          <span
            key={m.id}
            className={`flex items-center gap-2 rounded-[9px] border px-2.5 py-1.5 ${
              isPlaceholder(m) ? "border-dashed border-accent-line bg-accent-soft/40" : "border-line bg-panel-2"
            }`}
          >
            <span className="font-mono text-[14px] font-bold text-accent">{formatMetric(m.format, m.rawValue)}</span>
            <span className="text-[10px] font-semibold tracking-[.05em] text-ink-2 uppercase">{m.label}</span>
            <button
              onClick={() => {
                setOpen(null);
                setEditing((cur) => (cur === m.id ? null : m.id));
              }}
              className="text-ink-3 hover:text-accent"
              aria-label="Edit metric"
            >
              <Pencil className="size-3" />
            </button>
            <button onClick={() => onDetach(m.id)} className="text-ink-3 hover:text-bad" aria-label="Remove metric">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null);
            setOpen(open ? null : "pick");
          }}
          className="h-auto rounded-[9px] border-dashed border-line bg-transparent px-3 py-1.5 text-[12px] font-semibold text-ink-2 hover:border-accent-line hover:bg-transparent hover:text-accent"
        >
          + metric
        </Button>
      </div>

      {editMetric && (
        <div className="mt-2.5 rounded-[10px] border border-accent-line bg-panel-2 p-3">
          <p className="mb-2.5 text-[11px] font-semibold text-ink-2">
            {isPlaceholder(editMetric) ? "Fill in this metric" : "Edit metric"}
          </p>
          <MetricForm
            key={editMetric.id}
            pending={pending}
            initial={editMetric}
            submitLabel="Save"
            onSubmit={async (input) => (await onUpdate(editMetric.id, input)) && setEditing(null)}
          />
        </div>
      )}

      {open && (
        <div className="mt-2.5 rounded-[10px] border border-line bg-panel-2 p-3">
          <div className="mb-2.5 flex gap-1.5">
            <TabBtn on={open === "pick"} onClick={() => setOpen("pick")}>From library</TabBtn>
            <TabBtn on={open === "create"} onClick={() => setOpen("create")}>Create new</TabBtn>
          </div>
          {open === "pick" ? (
            available.length === 0 ? (
              <p className="py-2 text-center text-[11.5px] text-ink-3">
                All metrics attached — create a new one instead.
              </p>
            ) : (
              <div className="flex max-h-[180px] flex-col gap-1 overflow-auto">
                {available.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onAttach(m.id)}
                    className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-panel"
                  >
                    <span className="font-mono text-[13px] font-bold text-accent">{formatMetric(m.format, m.rawValue)}</span>
                    <span className="truncate text-[12px]">{m.label}</span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <MetricForm
              pending={pending}
              submitLabel="Add & attach"
              onSubmit={async (input) => (await onCreate(input)) && setOpen(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        on ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

const METRIC_STYLES: MetricFormat["style"][] = ["number", "percent", "rating", "duration", "literal"];

/**
 * Create OR edit a metric. With `initial` it prefills for editing an existing
 * library metric; a generated "—" placeholder opens ready to type a real number
 * (style pre-set to "number", value blank) so filling one in is one keystroke away.
 * Advanced format tuning (decimals, suffix, unit) lives in the Metrics tab.
 */
function MetricForm({
  pending,
  initial,
  submitLabel,
  onSubmit,
}: {
  pending: boolean;
  initial?: BuilderMetric;
  submitLabel: string;
  onSubmit: (input: NewMetric) => void;
}) {
  const isPlaceholder = initial?.format.style === "literal" && initial.format.text === "—";
  const [label, setLabel] = useState(initial?.label ?? "");
  const [sublabel, setSublabel] = useState(initial?.sublabel ?? "");
  const [rawValue, setRawValue] = useState(initial?.rawValue != null ? String(initial.rawValue) : "");
  // a placeholder opens as a plain number ready to fill; real literals keep their style
  const [style, setStyle] = useState<MetricFormat["style"]>(isPlaceholder ? "number" : (initial?.format.style ?? "number"));
  const [literalText, setLiteralText] = useState(
    initial?.format.style === "literal" && !isPlaceholder ? initial.format.text : "",
  );

  const format: MetricFormat =
    style === "literal"
      ? { style: "literal", text: literalText || label }
      : style === "rating"
        ? { style: "rating", outOf: 5 }
        : { style };

  const submit = () =>
    onSubmit({
      label,
      sublabel,
      rawValue: style === "literal" ? "" : rawValue,
      format,
    });

  return (
    <div className="flex flex-col gap-2">
      <Input placeholder="Label — e.g. Cases handled" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Input
        placeholder="Sublabel — context (optional)"
        value={sublabel}
        onChange={(e) => setSublabel(e.target.value)}
      />
      <div className="flex gap-2">
        <Select value={style} onValueChange={(v) => setStyle(v as MetricFormat["style"])}>
          <SelectTrigger className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_STYLES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {style === "literal" ? (
          <Input className="flex-1" placeholder="Text — e.g. ≤1 hr" value={literalText} onChange={(e) => setLiteralText(e.target.value)} />
        ) : (
          <Input className="flex-1" type="number" placeholder="Value" value={rawValue} onChange={(e) => setRawValue(e.target.value)} />
        )}
      </div>
      <Button
        size="sm"
        onClick={submit}
        disabled={pending || !label.trim()}
        className="self-end rounded-full bg-accent px-4 text-[12px] font-semibold text-white hover:bg-accent/90"
      >
        {pending ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}

// ── document inspector: attached list + attach/upload popover ──────────────

function DocInspector({
  attached,
  available,
  onAttach,
  onDetach,
  onUpload,
  pending,
}: {
  attached: BuilderDoc[];
  available: BuilderDoc[];
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
  onUpload: (file: File, ragEnabled: boolean) => Promise<boolean>;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ragEnabled, setRagEnabled] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      {attached.map((d) => (
        <div key={d.id} className="mb-1.5 flex items-center gap-2.5 rounded-[9px] border border-line bg-panel-2 px-2.5 py-2">
          <span className="text-sm">📄</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{d.filename}</span>
          {d.ragEnabled ? (
            <span className="flex-none rounded-[5px] bg-ok-soft px-1.5 py-0.5 text-[8px] font-semibold tracking-[.06em] text-ok uppercase">
              RAG
            </span>
          ) : (
            <span className="flex-none rounded-[5px] bg-panel px-1.5 py-0.5 text-[8px] font-semibold tracking-[.06em] text-ink-3 uppercase">
              evidence
            </span>
          )}
          <button onClick={() => onDetach(d.id)} className="flex-none text-ink-3 hover:text-bad" aria-label="Detach document">
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        className="mt-0.5 h-auto w-full rounded-[9px] border-dashed border-line bg-transparent py-2 text-[11.5px] font-semibold text-ink-2 hover:border-accent-line hover:bg-transparent hover:text-accent"
      >
        + Attach document
      </Button>

      {open && (
        <div className="mt-2.5 rounded-[10px] border border-line bg-panel-2 p-3">
          {available.length > 0 && (
            <>
              <div className="eyebrow mb-1.5">Already uploaded</div>
              <div className="mb-3 flex max-h-[140px] flex-col gap-1 overflow-auto">
                {available.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => onAttach(d.id)}
                    className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-panel"
                  >
                    <span className="text-[13px]">📄</span>
                    <span className="min-w-0 flex-1 truncate text-[12px]">{d.filename}</span>
                    <span className={`text-[9px] ${d.ragEnabled ? "text-ok" : "text-ink-3"}`}>
                      {d.ragEnabled ? "RAG" : "evidence"}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="eyebrow mb-1.5">Upload new</div>
          <label className="mb-2 flex items-center gap-2 text-[11.5px] text-ink-2">
            <Checkbox checked={ragEnabled} onCheckedChange={(v) => setRagEnabled(v === true)} />
            Add to Q&amp;A knowledge base (searchable)
          </label>
          <p className="mb-2 text-[10.5px] text-ink-3">
            {ragEnabled
              ? "Parsed, chunked & embedded — the avatar can cite it in answers."
              : "Stored as evidence only — shown in the panel, never searched."}
          </p>
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="h-auto w-full rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:bg-accent/90"
          >
            {pending ? "Uploading…" : "Choose file & upload"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,.csv"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                const ok = await onUpload(f, ragEnabled);
                if (ok) setOpen(false);
              }
              if (fileRef.current) fileRef.current.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── cue params + preview ───────────────────────────────────────────────────

/**
 * Build a cue-editor field guide for a GENERATED template from its param
 * declarations + example values — so the user sees what each field controls
 * and can prepopulate it via "Insert example" (built-ins use CUE_SCHEMAS).
 */
function deriveGeneratedGuide(t: BuilderTemplate): CueSchema | null {
  if (!t.spec) return null; // built-in → CUE_SCHEMAS handles it
  const preview = t.previewParams ?? {};
  const fields = (t.paramSchema ?? []).map((p) => {
    let type = p.type;
    // for object-list params, surface the observed sub-keys so the shape is clear
    if (p.type === "object[]") {
      const first = Array.isArray(preview[p.name]) ? (preview[p.name] as unknown[])[0] : null;
      const keys = first && typeof first === "object" ? Object.keys(first as object) : [];
      if (keys.length) type = `{ ${keys.join(", ")} }[]`;
    }
    return { name: p.name, type, desc: p.label ?? "value for this field" };
  });
  return {
    summary: `“${t.name}” — a custom generated visual. Fill each field below (or click Insert example to prefill), then edit the values to fit this scene.`,
    fields,
    example: preview,
  };
}

function CueParamsEditor({
  templateKey,
  genSchema,
  value,
  onChange,
}: {
  templateKey: string | null;
  /** generated-template field guide; when set it overrides the CUE_SCHEMAS lookup. */
  genSchema?: CueSchema | null;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [textFor, setTextFor] = useState(JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  const incoming = JSON.stringify(value);
  if (incoming !== textFor) {
    setTextFor(incoming);
    setText(JSON.stringify(value, null, 2));
    setInvalid(false);
  }

  const schema = genSchema ?? (templateKey ? CUE_SCHEMAS[templateKey] : undefined);
  const empty = !value || Object.keys(value).length === 0;

  return (
    <>
      {schema && (
        <div className="mb-2.5 rounded-[10px] border border-line bg-panel-2 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11.5px] text-ink-2">{schema.summary}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = schema.example;
                setText(JSON.stringify(next, null, 2));
                setTextFor(JSON.stringify(next));
                setInvalid(false);
                onChange(next);
              }}
              className="h-auto flex-none rounded-full px-3 py-1 text-[11px] font-semibold"
            >
              {empty ? "Insert example" : "Reset to example"}
            </Button>
          </div>
          <dl className="mt-2.5 flex flex-col gap-1.5">
            {schema.fields.map((f) => (
              <div key={f.name} className="text-[11px] leading-snug">
                <span className="font-mono font-semibold text-accent">{f.name}</span>
                <span className="text-ink-3"> : {f.type}</span>
                {f.required && <span className="text-bad"> *</span>}
                <span className="text-ink-2"> — {f.desc}</span>
              </div>
            ))}
          </dl>
        </div>
      )}
      <Textarea
        className="min-h-[120px] font-mono text-[11.5px]"
        aria-invalid={invalid || undefined}
        placeholder={schema ? '{ }  — click "Insert example" above to start' : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTextFor(e.target.value);
          try {
            const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <p className="mt-1.5 text-[11px] text-bad">Cue JSON is invalid — fix it before saving.</p>
      )}
    </>
  );
}

/** 16:9 preview that scales the 1440×810 viewer stage to the container width.
 *  Every visual template (primary + extras) and every metric card is freely
 *  drag-to-move, click-to-select (size in the inspector). */
function PreviewFrame({
  draft,
  templateKey,
  templateSpec,
  metricById,
  docCount,
  onLayout,
  pick,
  setPick,
  cueFor,
}: {
  draft: BuilderScene;
  templateKey: string | null;
  templateSpec: import("@/lib/template-dsl").LayoutNode | null;
  metricById: Map<string, BuilderMetric>;
  docCount: number;
  /** persist a drag */
  onLayout: (layout: SceneLayout) => void;
  pick: BuilderSelection;
  setPick: (s: BuilderSelection) => void;
  /** resolve an extra cue's templateId → render key + generated spec */
  cueFor: (templateId: string) => { key: string; spec: import("@/lib/template-dsl").LayoutNode | null };
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = width ? width / 1440 : 0;
  const cue = (draft.templateParams.cue as Record<string, unknown>) ?? {};
  const focus = draft.metricIds.map((id) => metricById.get(id)).filter((m): m is BuilderMetric => !!m);
  const layout = (draft.templateParams.layout as SceneLayout) ?? {};
  const focusIds = focus.map((m) => m.id);

  const sameTarget = (a: BuilderSelection, b: Target) =>
    !!a && a.kind === b.kind && (a.kind === "cue" || (a as { id: string }).id === (b as { id: string }).id);

  // Drag any target by its top-center anchor; screen px → stage coords ÷ scale.
  const startDrag = (target: Target, e: React.PointerEvent) => {
    if (scale <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    setPick(target);
    const base = (draft.templateParams.layout as SceneLayout) ?? {};
    const origin = targetPos(base, target, focusIds);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      moved = true;
      const nx = Math.max(80, Math.min(1360, origin.x + (ev.clientX - startX) / scale));
      const ny = Math.max(0, Math.min(760, origin.y + (ev.clientY - startY) / scale));
      onLayout(withTargetPos(base, target, { ...origin, x: Math.round(nx), y: Math.round(ny) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      void moved;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const boxProps = (target: Target): React.HTMLAttributes<HTMLDivElement> => {
    const sel = sameTarget(pick, target);
    return {
      onPointerDown: (e) => startDrag(target, e),
      style: {
        cursor: dragging && sel ? "grabbing" : "grab",
        outline: sel ? "2px solid rgba(61,91,245,.9)" : "none",
        outlineOffset: 6,
        borderRadius: 8,
        touchAction: "none",
        userSelect: "none",
      },
      title: "Drag to move · click to select (size in the inspector)",
    };
  };

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-[12px] border border-line"
      style={{ aspectRatio: "16 / 9", background: "linear-gradient(180deg,#F8FBFF,#E9F1FA)" }}
      onPointerDown={() => setPick(null)}
    >
      {docCount > 0 && (
        <div className="absolute top-2.5 right-2.5 z-10 rounded-full border border-accent-line bg-white px-2.5 py-1 text-[8px] font-semibold text-accent shadow-sm">
          📄 {docCount} document{docCount > 1 ? "s" : ""} — backed by evidence
        </div>
      )}
      {scale > 0 && (
        // 1440×810 stage scaled to fit — mirrors the live viewer's absolute
        // layout so the preview reads exactly like the published presentation.
        <div
          style={{
            width: 1440,
            height: 810,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          {/* scene title */}
          <div
            style={{
              position: "absolute",
              top: 64,
              left: "50%",
              transform: "translateX(-50%)",
              textAlign: "center",
              width: 760,
              zIndex: 5,
            }}
          >
            <div style={{ font: "700 22px Inter", color: "#1E293B", letterSpacing: "-.2px" }}>
              {draft.title || draft.name}
            </div>
            {draft.subtitle && (
              <div style={{ marginTop: 5, font: "500 13px Inter", color: "#64748B" }}>{draft.subtitle}</div>
            )}
          </div>

          {/* primary visual template */}
          {(templateKey || templateSpec) &&
            (() => {
              const pos = layout.cue ?? DEFAULT_CUE_POS;
              return (
                <div
                  {...boxProps({ kind: "cue" })}
                  style={{
                    ...boxProps({ kind: "cue" }).style,
                    position: "absolute",
                    top: pos.y,
                    left: pos.x,
                    transform: `translateX(-50%) scale(${pos.scale ?? 1})`,
                    transformOrigin: "top center",
                    height: 196,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: sameTarget(pick, { kind: "cue" }) ? 8 : 3,
                  }}
                >
                  <CueStage template={templateKey ?? ""} params={cue} spec={templateSpec} />
                </div>
              );
            })()}

          {/* additional visual templates */}
          {(layout.extraCues ?? []).map((ec) => {
            const resolved = cueFor(ec.templateId);
            const target: Target = { kind: "extra", id: ec.id };
            return (
              <div
                key={ec.id}
                {...boxProps(target)}
                style={{
                  ...boxProps(target).style,
                  position: "absolute",
                  top: ec.pos.y,
                  left: ec.pos.x,
                  transform: `translateX(-50%) scale(${ec.pos.scale ?? 1})`,
                  transformOrigin: "top center",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: sameTarget(pick, target) ? 8 : 3,
                }}
              >
                <CueStage template={resolved.key} params={ec.params ?? {}} spec={resolved.spec} />
              </div>
            );
          })}

          {/* images & videos — each drag-to-move & sizable */}
          {(layout.media ?? []).map((md) => {
            const target: Target = { kind: "media", id: md.id };
            return (
              <div
                key={md.id}
                {...boxProps(target)}
                style={{
                  ...boxProps(target).style,
                  position: "absolute",
                  top: md.pos.y,
                  left: md.pos.x,
                  width: md.w,
                  transform: `translateX(-50%) scale(${md.pos.scale ?? 1})`,
                  transformOrigin: "top center",
                  zIndex: sameTarget(pick, target) ? 8 : 2,
                }}
              >
                {md.kind === "video" ? (
                  <video
                    src={md.url}
                    style={{ width: "100%", height: "auto", borderRadius: 14, display: "block", pointerEvents: "none" }}
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={md.url}
                    alt=""
                    draggable={false}
                    style={{ width: "100%", height: "auto", borderRadius: 14, display: "block", pointerEvents: "none" }}
                  />
                )}
              </div>
            );
          })}

          {/* focus metric cards — each individually placeable & sizable */}
          {focus.map((m, i) => {
            const target: Target = { kind: "metric", id: m.id };
            const pos = layout.metricItems?.[m.id] ?? defaultMetricPos(i, focus.length, layout.metrics ?? DEFAULT_METRICS_POS);
            return (
              <div
                key={m.id}
                {...boxProps(target)}
                style={{
                  ...boxProps(target).style,
                  position: "absolute",
                  top: pos.y,
                  left: pos.x,
                  transform: `translateX(-50%) scale(${pos.scale ?? 1})`,
                  transformOrigin: "top center",
                  zIndex: sameTarget(pick, target) ? 8 : 3,
                }}
              >
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid rgba(61,91,245,.5)",
                    borderRadius: 16,
                    padding: "20px 26px",
                    minWidth: 180,
                    textAlign: "center",
                    boxShadow: "0 24px 56px -18px rgba(61,91,245,.3)",
                  }}
                >
                  <div style={{ font: "600 10px Inter", letterSpacing: "1.5px", color: "#3D5BF5" }}>
                    {m.label}
                  </div>
                  <div style={{ font: "700 42px/1.1 Inter", color: "#3D5BF5", marginTop: 6 }}>
                    {formatMetric(m.format, m.rawValue)}
                  </div>
                  {m.sublabel && (
                    <div style={{ font: "400 11px Inter", color: "#94A3B8", marginTop: 4 }}>{m.sublabel}</div>
                  )}
                </div>
              </div>
            );
          })}

          {/* presenter — the actual render if this scene has one, else the
              illustrated placeholder flagged as not-yet-rendered */}
          {draft.videoUrl ? (
            <AvatarVideo
              src={draft.videoUrl}
              kind={draft.videoKind ?? "chroma"}
              tilt={0}
              playing={playing}
              loop
              muted={muted}
            />
          ) : (
            <>
              <AvatarPlaceholder speaking={false} tilt={0} />
              <div
                style={{
                  position: "absolute",
                  bottom: 20,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 6,
                  font: "600 12px Inter",
                  color: "#64748B",
                  background: "rgba(255,255,255,.85)",
                  border: "1px solid rgba(226,232,240,.9)",
                  borderRadius: 999,
                  padding: "6px 14px",
                  whiteSpace: "nowrap",
                }}
              >
                Not rendered yet — cartoon stand-in
              </div>
            </>
          )}
        </div>
      )}

      {/* playback controls — only meaningful when the scene has a real render */}
      {draft.videoUrl && (
        <div className="absolute bottom-2.5 left-2.5 z-10 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
            className="grid h-8 w-8 place-items-center rounded-full border border-line bg-white/90 text-ink shadow-sm backdrop-blur transition hover:bg-white"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? "Unmute" : "Mute"}
            className="grid h-8 w-8 place-items-center rounded-full border border-line bg-white/90 text-ink shadow-sm backdrop-blur transition hover:bg-white"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* placement hint + reset — every visual & metric is drag-to-move */}
      {(templateKey || templateSpec || focus.length > 0 || (layout.extraCues?.length ?? 0) > 0) && (
        <div className="absolute right-2.5 bottom-2.5 z-10 flex items-center gap-1.5">
          {(layout.cue || layout.metrics || layout.metricItems) && (
            <button
              type="button"
              // reset positions/sizes but keep any added visuals
              onClick={() => onLayout({ extraCues: layout.extraCues })}
              className="rounded-full border border-line bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-ink-2 shadow-sm backdrop-blur transition hover:bg-white"
            >
              Reset positions
            </button>
          )}
          <span className="rounded-full border border-line bg-white/80 px-2.5 py-1 text-[10px] text-ink-3 shadow-sm backdrop-blur">
            Drag to move · click to select · size in the inspector
          </span>
        </div>
      )}
    </div>
  );
}
