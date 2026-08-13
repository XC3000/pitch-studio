"use client";

/** Metric library CRUD (M4) with a live count-up preview via formatMetric(). */

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { formatMetric } from "@/viewer/format";
import type { MetricFormat } from "@/viewer/types";
import { deleteMetric, saveMetric, type MetricInput } from "./actions";

export type MetricRow = {
  id: string;
  key: string;
  label: string;
  sublabel: string | null;
  rawValue: string | null;
  format: MetricFormat;
};

type Style = MetricFormat["style"];
const STYLES: Style[] = ["number", "percent", "rating", "duration", "literal"];

function blankDraft(): MetricInput {
  return { key: "", label: "", sublabel: "", rawValue: "", format: { style: "number" } };
}

function rowToDraft(r: MetricRow): MetricInput {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    sublabel: r.sublabel ?? "",
    rawValue: r.rawValue ?? "",
    format: r.format,
  };
}

export function MetricsManager({ orgSlug, initial }: { orgSlug: string; initial: MetricRow[] }) {
  const { run, pending } = useAction();
  const [editing, setEditing] = useState<MetricInput | null>(null);
  const [deleting, setDeleting] = useState<MetricRow | null>(null);

  const preview = (m: { format: MetricFormat; rawValue: string | null }) =>
    formatMetric(m.format, m.rawValue == null || m.rawValue === "" ? null : Number(m.rawValue));

  const save = () => {
    if (!editing) return;
    run(() => saveMetric(orgSlug, editing), {
      success: "Metric saved",
      onSuccess: () => setEditing(null),
    });
  };

  return (
    <>
      <div className="mt-5 flex items-center justify-between">
        <span className="text-[12px] text-ink-3">{initial.length} metrics</span>
        <Button
          onClick={() => setEditing(blankDraft())}
          disabled={pending}
          className="bg-linear-to-br from-accent-2 to-accent shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          <Plus /> New metric
        </Button>
      </div>

      {editing && (
        <MetricEditor
          draft={editing}
          setDraft={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
          pending={pending}
          preview={preview}
        />
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {initial.map((m) => (
          <div key={m.id} className="rounded-[14px] border border-line bg-panel px-4 py-3.5 shadow-card">
            <div className="text-[24px] font-bold tabular-nums text-accent">{preview(m)}</div>
            <div className="mt-1 text-[10px] font-semibold tracking-[.12em] text-ink-3 uppercase">
              {m.label}
            </div>
            {m.sublabel && <div className="mt-0.5 text-[11px] text-ink-2">{m.sublabel}</div>}
            <div className="mt-2 flex items-center gap-3">
              <code className="text-[10px] text-ink-3">{m.key}</code>
              <button
                onClick={() => setEditing(rowToDraft(m))}
                className="ml-auto text-[11.5px] font-semibold text-accent"
              >
                Edit
              </button>
              <button
                onClick={() => setDeleting(m)}
                className="text-[11.5px] font-semibold text-bad"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete metric &ldquo;{deleting?.label}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Scenes referencing it will drop the card. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() => {
                if (!deleting) return;
                run(() => deleteMetric(orgSlug, deleting.id), {
                  success: "Metric deleted",
                  onSuccess: () => setDeleting(null),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MetricEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  pending,
  preview,
}: {
  draft: MetricInput;
  setDraft: (d: MetricInput) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  preview: (m: { format: MetricFormat; rawValue: string | null }) => string;
}) {
  const style = draft.format.style;
  const fmt = draft.format as Record<string, unknown>;
  const setFmt = (patch: Record<string, unknown>) =>
    setDraft({ ...draft, format: { ...draft.format, ...patch } as MetricFormat });
  const setStyle = (s: Style) => {
    const base: Record<Style, MetricFormat> = {
      number: { style: "number" },
      percent: { style: "percent" },
      rating: { style: "rating", outOf: 5 },
      duration: { style: "duration" },
      literal: { style: "literal", text: "≤1 hr" },
    };
    setDraft({ ...draft, format: base[s] });
  };

  return (
    <div className="mt-4 rounded-[14px] border border-accent-line bg-accent-soft px-4 py-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="block">
          <span className="eyebrow">Label</span>
          <Input
            autoFocus
            className="mt-1.5"
            placeholder="CASES HANDLED"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="eyebrow">Key {draft.id ? "" : "(auto if blank)"}</span>
          <Input
            className="mt-1.5"
            placeholder="cases"
            value={draft.key}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          />
        </label>
        <div className="block">
          <span className="eyebrow">Style</span>
          <Select value={style} onValueChange={(v) => setStyle(v as Style)}>
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STYLES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {style !== "literal" && (
          <label className="block">
            <span className="eyebrow">Value</span>
            <Input
              className="mt-1.5"
              placeholder="140000"
              value={draft.rawValue}
              onChange={(e) => setDraft({ ...draft, rawValue: e.target.value })}
            />
          </label>
        )}
        {style === "literal" && (
          <label className="block">
            <span className="eyebrow">Text</span>
            <Input
              className="mt-1.5"
              placeholder="≤1 hr"
              value={(fmt.text as string) ?? ""}
              onChange={(e) => setFmt({ text: e.target.value })}
            />
          </label>
        )}
        {style === "number" && (
          <>
            <label className="block">
              <span className="eyebrow">Suffix</span>
              <Input className="mt-1.5" placeholder="+" value={(fmt.suffix as string) ?? ""} onChange={(e) => setFmt({ suffix: e.target.value })} />
            </label>
            <label className="block">
              <span className="eyebrow">Decimals</span>
              <Input className="mt-1.5" type="number" value={(fmt.decimals as number) ?? 0} onChange={(e) => setFmt({ decimals: Number(e.target.value) || 0 })} />
            </label>
          </>
        )}
        {style === "percent" && (
          <label className="block">
            <span className="eyebrow">Decimals</span>
            <Input className="mt-1.5" type="number" value={(fmt.decimals as number) ?? 0} onChange={(e) => setFmt({ decimals: Number(e.target.value) || 0 })} />
          </label>
        )}
        {style === "rating" && (
          <label className="block">
            <span className="eyebrow">Out of</span>
            <Input className="mt-1.5" type="number" value={(fmt.outOf as number) ?? 5} onChange={(e) => setFmt({ outOf: Number(e.target.value) || 5 })} />
          </label>
        )}
        {style === "duration" && (
          <>
            <label className="block">
              <span className="eyebrow">Prefix</span>
              <Input className="mt-1.5" placeholder="≤" value={(fmt.prefix as string) ?? ""} onChange={(e) => setFmt({ prefix: e.target.value })} />
            </label>
            <label className="block">
              <span className="eyebrow">Unit</span>
              <Input className="mt-1.5" placeholder="min" value={(fmt.unit as string) ?? ""} onChange={(e) => setFmt({ unit: e.target.value })} />
            </label>
          </>
        )}

        <label className="block md:col-span-2">
          <span className="eyebrow">Sublabel</span>
          <Input
            className="mt-1.5"
            placeholder="coordinated end-to-end"
            value={draft.sublabel}
            onChange={(e) => setDraft({ ...draft, sublabel: e.target.value })}
          />
        </label>
        <div className="flex items-end">
          <div className="rounded-[10px] border border-line bg-panel px-4 py-2">
            <div className="eyebrow">Preview</div>
            <div className="text-[20px] font-bold tabular-nums text-accent">{preview(draft)}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={onSave} disabled={pending}>
          {draft.id ? "Save changes" : "Add metric"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
