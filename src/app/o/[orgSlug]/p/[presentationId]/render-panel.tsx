"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { renderChangedScenes, renderSceneAction, setDefaultPresenter } from "./actions";

export type SceneRenderRow = {
  id: string;
  position: number;
  name: string;
  title: string | null;
  wordCount: number;
  hasScript: boolean;
  job: {
    status: "queued" | "rendering" | "downloading" | "done" | "failed";
    durationSec: number | null;
    costUsd: string | null;
    error: string | null;
    updatedAt: string;
  } | null;
};

type PresenterOption = {
  id: string;
  name: string;
  supportsMatting: boolean;
  heygenAvatarId: string | null;
};

const STATUS_STYLE: Record<string, { label: string; dot: string; text: string }> = {
  none: { label: "not rendered", dot: "bg-ink-3", text: "text-ink-3" },
  queued: { label: "queued", dot: "bg-warn animate-pulse", text: "text-warn" },
  rendering: { label: "rendering", dot: "bg-warn animate-pulse", text: "text-warn" },
  downloading: { label: "downloading", dot: "bg-accent animate-pulse", text: "text-accent" },
  done: { label: "ready", dot: "bg-ok", text: "text-ok" },
  failed: { label: "failed", dot: "bg-bad", text: "text-bad" },
};

export function RenderPanel({
  orgSlug,
  presentationId,
  defaultPresenterId,
  presenters,
  scenes,
}: {
  orgSlug: string;
  presentationId: string;
  defaultPresenterId: string | null;
  presenters: PresenterOption[];
  scenes: SceneRenderRow[];
}) {
  const router = useRouter();
  const { run, pending } = useAction();

  // Renders are ambient background state — poll while any job is in flight.
  const inFlight = scenes.some(
    (s) => s.job && ["queued", "rendering", "downloading"].includes(s.job.status),
  );
  useEffect(() => {
    if (!inFlight) return;
    const iv = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(iv);
  }, [inFlight, router]);

  const presenter = presenters.find((p) => p.id === defaultPresenterId) ?? null;
  const doneCount = scenes.filter((s) => s.job?.status === "done").length;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-[16px] border border-line bg-panel px-5 py-4 shadow-card">
        <div>
          <div className="eyebrow">Presenter</div>
          <Select
            value={defaultPresenterId ?? ""}
            disabled={pending}
            onValueChange={(id) => {
              if (!id) return;
              run(() => setDefaultPresenter(orgSlug, presentationId, id), {
                success: "Presenter set",
              });
            }}
          >
            <SelectTrigger className="mt-1.5 min-w-[220px]">
              <SelectValue
                placeholder={
                  presenters.length ? "Choose a presenter…" : "No presenters yet — add one first"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {presenters.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.supportsMatting ? " (alpha)" : " (chroma-key)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-[12px] text-ink-3">
            {doneCount}/{scenes.length} scenes ready
          </span>
          <Button
            disabled={pending || !presenter?.heygenAvatarId}
            title={!presenter ? "Pick a presenter first" : undefined}
            onClick={() =>
              run(() => renderChangedScenes(orgSlug, presentationId), {
                loading: "Checking scenes…",
                success: ({ queued, unchanged }) =>
                  queued === 0
                    ? "Nothing to render — every scene is up to date."
                    : `${queued} scene${queued === 1 ? "" : "s"} queued (${unchanged} unchanged).`,
              })
            }
            className="bg-linear-to-br from-accent-2 to-accent px-5 shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
          >
            Render changed scenes
          </Button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-[16px] border border-line bg-panel shadow-card">
        {scenes.map((s) => {
          const st = STATUS_STYLE[s.job?.status ?? "none"];
          return (
            <div
              key={s.id}
              className="flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-none"
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-panel-2 text-[12px] font-bold text-ink-2">
                {s.position + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{s.title ?? s.name}</div>
                <div className="text-[11px] text-ink-3">
                  {s.hasScript ? `${s.wordCount} words` : "no script"}
                  {s.job?.status === "done" && s.job.durationSec
                    ? ` · ${s.job.durationSec.toFixed(1)}s · $${Number(s.job.costUsd ?? 0).toFixed(2)}`
                    : ""}
                  {s.job?.status === "failed" && s.job.error ? ` · ${s.job.error}` : ""}
                </div>
              </div>
              <span className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.08em] ${st.text}`}>
                <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                {st.label}
              </span>
              <button
                disabled={pending || !s.hasScript || !presenter?.heygenAvatarId}
                onClick={() =>
                  run(() => renderSceneAction(orgSlug, presentationId, s.id), {
                    success: (res) =>
                      res.outcome === "queued"
                        ? "Render queued"
                        : res.outcome === "unchanged"
                          ? "Scene unchanged since its last render — nothing to do."
                          : res.outcome === "already_running"
                            ? "This scene is already rendering."
                            : "Scene has no script yet.",
                  })
                }
                className="rounded-full border border-accent-line bg-accent-soft px-3.5 py-1.5 text-[11.5px] font-semibold text-accent disabled:opacity-40"
              >
                {s.job?.status === "done" ? "Re-render" : "Render"}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
