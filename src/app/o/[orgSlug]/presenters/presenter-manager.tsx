"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
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
import { useAction } from "@/hooks/use-action";
import type { VoiceTuning } from "@/lib/heygen";
import {
  createPresenter,
  deletePresenter,
  getHeygenCatalog,
  requestIdleLoop,
  updatePresenter,
  type Catalog,
  type PresenterInput,
} from "./actions";

type PresenterRow = {
  id: string;
  name: string;
  title: string | null;
  headshotUrl: string | null;
  heygenAvatarId: string | null;
  supportsMatting: boolean;
  hasIdleLoop: boolean;
  voices: Record<string, { heygenVoiceId?: string; elevenVoiceId?: string }>;
  voiceSettings: VoiceTuning;
};

const EMPTY: PresenterInput = {
  name: "",
  title: "",
  headshotUrl: "",
  heygenAvatarId: "",
  heygenVoiceId: "",
  elevenVoiceId: "",
  supportsMatting: false,
  voiceSettings: {},
};

function toInput(p: PresenterRow): PresenterInput {
  return {
    name: p.name,
    title: p.title ?? "",
    headshotUrl: p.headshotUrl ?? "",
    heygenAvatarId: p.heygenAvatarId ?? "",
    heygenVoiceId: p.voices.en?.heygenVoiceId ?? "",
    elevenVoiceId: p.voices.en?.elevenVoiceId ?? "",
    supportsMatting: p.supportsMatting,
    voiceSettings: p.voiceSettings ?? {},
  };
}

export function PresenterManager({
  orgSlug,
  presenters,
}: {
  orgSlug: string;
  presenters: PresenterRow[];
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PresenterRow | null>(null);
  const [deleting, setDeleting] = useState<PresenterRow | null>(null);
  const { run, pending } = useAction();

  const panelOpen = adding || editing !== null;

  return (
    <>
      <div className="mt-6 flex items-center justify-between">
        <span className="eyebrow">{presenters.length} presenter{presenters.length === 1 ? "" : "s"}</span>
        <Button
          onClick={() => {
            setEditing(null);
            setAdding((v) => !v);
          }}
          className="bg-linear-to-br from-accent-2 to-accent shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          {panelOpen ? (
            <>
              <X /> Close
            </>
          ) : (
            <>
              <Plus /> Add presenter
            </>
          )}
        </Button>
      </div>

      {panelOpen && (
        <PresenterPanel
          key={editing?.id ?? "new"}
          orgSlug={orgSlug}
          existing={editing}
          onDone={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

      <div className="mt-4 grid gap-3.5 md:grid-cols-2">
        {presenters.length === 0 && !adding && (
          <div className="rounded-[16px] border border-line bg-panel px-8 py-14 text-center md:col-span-2">
            <div className="eyebrow">No presenters yet</div>
            <p className="mx-auto mt-3 max-w-sm text-[13px] text-ink-2">
              Add one from your HeyGen looks or the stock gallery, or paste your founder&apos;s
              HeyGen avatar &amp; voice IDs.
            </p>
          </div>
        )}
        {presenters.map((p) => (
          <div key={p.id} className="rounded-[16px] border border-line bg-panel p-5 shadow-card">
            <div className="flex items-start gap-3.5">
              {p.headshotUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.headshotUrl}
                  alt={p.name}
                  className="h-14 w-14 rounded-[12px] object-cover"
                />
              ) : (
                <span className="flex h-14 w-14 items-center justify-center rounded-[12px] bg-accent-soft text-xl">
                  🎙️
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold">{p.name}</div>
                <div className="text-[11.5px] text-ink-3">{p.title ?? "—"}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip ok={!!p.heygenAvatarId}>
                    {p.heygenAvatarId ? "HeyGen avatar linked" : "no avatar id"}
                  </Chip>
                  <Chip ok={!!p.voices.en?.heygenVoiceId}>
                    {p.voices.en?.heygenVoiceId ? "EN voice" : "no voice"}
                  </Chip>
                  <Chip ok={p.supportsMatting}>
                    {p.supportsMatting ? "transparent bg" : "chroma-key"}
                  </Chip>
                  {typeof p.voiceSettings?.speed === "number" && p.voiceSettings.speed !== 1 && (
                    <Chip ok>voice ×{p.voiceSettings.speed.toFixed(2)}</Chip>
                  )}
                  <Chip ok={p.hasIdleLoop}>{p.hasIdleLoop ? "idle loop ready" : "no idle loop"}</Chip>
                </div>
              </div>
            </div>
            <div className="mt-4 flex gap-2 border-t border-line pt-3.5">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => requestIdleLoop(orgSlug, p.id), {
                    success: "Idle loop render queued — it appears here when done.",
                  })
                }
                className="rounded-full border-accent-line bg-accent-soft text-[11.5px] font-semibold text-accent hover:bg-accent-soft hover:text-accent"
              >
                {p.hasIdleLoop ? "Re-render idle loop" : "Render idle loop"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setAdding(false);
                  setEditing(p);
                }}
                className="rounded-full border-line text-[11.5px] font-semibold"
              >
                <Pencil /> Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setDeleting(p)}
                className="ml-auto rounded-full border-line text-[11.5px] font-semibold text-bad hover:text-bad"
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete presenter &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Scenes rendered with this presenter keep their videos, but new renders will need a
              different presenter. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-bad text-white hover:bg-bad/90"
              onClick={() => {
                if (!deleting) return;
                run(() => deletePresenter(orgSlug, deleting.id), {
                  success: `Presenter "${deleting.name}" deleted`,
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

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <Badge
      className={`rounded-full border-none px-2 py-0.5 text-[10px] font-bold tracking-[.06em] uppercase ${
        ok ? "bg-ok-soft text-ok" : "bg-panel-2 text-ink-3"
      }`}
    >
      {children}
    </Badge>
  );
}

// ── Add / edit panel: your looks + stock gallery (Tier 1) or manual IDs ─────

function PresenterPanel({
  orgSlug,
  existing,
  onDone,
}: {
  orgSlug: string;
  existing: PresenterRow | null;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"gallery" | "manual">("gallery");
  const [input, setInput] = useState<PresenterInput>(existing ? toInput(existing) : EMPTY);
  const { run, pending } = useAction();

  const set = (patch: Partial<PresenterInput>) => setInput((v) => ({ ...v, ...patch }));

  const save = () =>
    run(
      () =>
        existing
          ? updatePresenter(orgSlug, existing.id, input)
          : createPresenter(orgSlug, input),
      {
        success: existing
          ? `Presenter "${input.name}" updated${
              existing.supportsMatting !== input.supportsMatting ||
              existing.heygenAvatarId !== input.heygenAvatarId
                ? " — re-render the idle loop and scenes to apply the new look"
                : ""
            }`
          : `Presenter "${input.name}" added`,
        onSuccess: onDone,
      },
    );

  return (
    <div className="mt-4 rounded-[16px] border border-accent-line bg-panel p-5 shadow-card-lg">
      {existing && (
        <div className="mb-3 text-[13px] font-semibold">
          Editing <span className="text-accent">{existing.name}</span>
        </div>
      )}
      <div className="flex gap-1.5">
        {(
          [
            ["gallery", "Avatar gallery"],
            ["manual", "Paste HeyGen IDs"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`rounded-full border px-3.5 py-1.5 text-[11.5px] font-semibold ${
              mode === key
                ? "border-accent-line bg-accent-soft text-accent"
                : "border-line text-ink-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Presenter name *">
          <Input
            value={input.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Dr. Sarah Malik"
          />
        </Field>
        <Field label="Title">
          <Input
            value={input.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Chief Medical Officer"
          />
        </Field>
      </div>

      {mode === "gallery" ? (
        <GalleryPicker
          orgSlug={orgSlug}
          selectedAvatarId={input.heygenAvatarId}
          selectedVoiceId={input.heygenVoiceId}
          onPickAvatar={(a) =>
            set({ heygenAvatarId: a.avatar_id, headshotUrl: a.preview_image_url ?? "" })
          }
          onPickLook={(look) =>
            // account looks are matting-capable (verified against V3) — default transparent on
            set({
              heygenAvatarId: look.id,
              headshotUrl: look.imageUrl ?? "",
              supportsMatting: true,
            })
          }
          onPickVoice={(voiceId) => set({ heygenVoiceId: voiceId })}
        />
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="HeyGen avatar ID *">
            <Input
              value={input.heygenAvatarId}
              onChange={(e) => set({ heygenAvatarId: e.target.value })}
              placeholder="e.g. 73c84e2b…"
              className="font-mono"
            />
          </Field>
          <Field label="HeyGen voice ID (EN) *">
            <Input
              value={input.heygenVoiceId}
              onChange={(e) => set({ heygenVoiceId: e.target.value })}
              placeholder="e.g. 077ab11b…"
              className="font-mono"
            />
          </Field>
          <Field label="ElevenLabs voice ID (Q&A voice, optional)">
            <Input
              value={input.elevenVoiceId}
              onChange={(e) => set({ elevenVoiceId: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field label="Headshot URL (optional)">
            <Input
              value={input.headshotUrl}
              onChange={(e) => set({ headshotUrl: e.target.value })}
            />
          </Field>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between rounded-[12px] border border-line bg-panel-2 px-4 py-3">
        <div>
          <div className="text-[12.5px] font-semibold">Transparent background</div>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            Renders the avatar as an alpha-channel webm cutout — no room, no green screen. Needs a
            matting-capable avatar (your own looks qualify); otherwise we chroma-key a green render
            in the viewer.
          </p>
        </div>
        <Switch
          checked={input.supportsMatting}
          onCheckedChange={(checked) => set({ supportsMatting: checked === true })}
        />
      </div>

      <VoiceSettingsEditor
        value={input.voiceSettings}
        onChange={(voiceSettings) => set({ voiceSettings })}
      />

      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
        <Button
          disabled={pending}
          onClick={save}
          className="bg-linear-to-br from-accent-2 to-accent shadow-[0_12px_26px_-10px_rgba(61,91,245,.55)]"
        >
          {pending ? "Saving…" : existing ? "Save changes" : "Save presenter"}
        </Button>
      </div>
    </div>
  );
}

// ── Voice settings (speed / volume / ElevenLabs tuning) ─────────────────────

const EL_DEFAULTS = { stability: 0.5, similarityBoost: 0.75, style: 0 };

function VoiceSettingsEditor({
  value,
  onChange,
}: {
  value: VoiceTuning;
  onChange: (v: VoiceTuning) => void;
}) {
  const advanced = value.elevenlabs != null;
  const el = { ...EL_DEFAULTS, ...value.elevenlabs };

  return (
    <div className="mt-3 rounded-[12px] border border-line bg-panel-2 px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[.08em] text-ink-3 uppercase">
        Voice settings
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <SliderField
          label="Speed"
          display={`×${(value.speed ?? 1).toFixed(2)}`}
          hint="0.5 = slower · 1.5 = faster"
          min={0.5}
          max={1.5}
          step={0.05}
          value={value.speed ?? 1}
          onChange={(speed) => onChange({ ...value, speed })}
        />
        <SliderField
          label="Volume"
          display={`${Math.round((value.volume ?? 1) * 100)}%`}
          hint="output loudness"
          min={0}
          max={1}
          step={0.05}
          value={value.volume ?? 1}
          onChange={(volume) => onChange({ ...value, volume })}
        />
      </div>

      <label className="mt-4 flex items-center gap-2.5 text-[12.5px] text-ink-2">
        <Switch
          size="sm"
          checked={advanced}
          onCheckedChange={(checked) => {
            if (checked === true) onChange({ ...value, elevenlabs: { ...EL_DEFAULTS } });
            else onChange({ ...value, elevenlabs: undefined });
          }}
        />
        Tune voice character (ElevenLabs engine — similarity, stability, style)
      </label>

      {advanced && (
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <SliderField
            label="Similarity"
            display={el.similarityBoost.toFixed(2)}
            hint="how closely it matches the cloned voice"
            min={0}
            max={1}
            step={0.05}
            value={el.similarityBoost}
            onChange={(similarityBoost) =>
              onChange({ ...value, elevenlabs: { ...el, similarityBoost } })
            }
          />
          <SliderField
            label="Stability"
            display={el.stability.toFixed(2)}
            hint="low = expressive, high = consistent"
            min={0}
            max={1}
            step={0.05}
            value={el.stability}
            onChange={(stability) => onChange({ ...value, elevenlabs: { ...el, stability } })}
          />
          <SliderField
            label="Style"
            display={el.style.toFixed(2)}
            hint="exaggeration of the speaking style"
            min={0}
            max={1}
            step={0.05}
            value={el.style}
            onChange={(style) => onChange({ ...value, elevenlabs: { ...el, style } })}
          />
        </div>
      )}
      <p className="mt-3 text-[11px] text-ink-3">
        Applied to every new HeyGen render for this presenter — already-rendered scenes keep their
        audio until re-rendered.
      </p>
    </div>
  );
}

function SliderField({
  label,
  display,
  hint,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  display: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold tracking-[.08em] text-ink-3 uppercase">
          {label}
        </span>
        <span className="font-mono text-[11.5px] font-semibold text-accent">{display}</span>
      </div>
      <Slider
        className="mt-2"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
      <p className="mt-1.5 text-[10.5px] text-ink-3">{hint}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold tracking-[.08em] text-ink-3 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function GalleryPicker({
  orgSlug,
  selectedAvatarId,
  selectedVoiceId,
  onPickAvatar,
  onPickLook,
  onPickVoice,
}: {
  orgSlug: string;
  selectedAvatarId: string;
  selectedVoiceId: string;
  onPickAvatar: (a: Catalog["avatars"][number]) => void;
  onPickLook: (l: Catalog["looks"][number]) => void;
  onPickVoice: (voiceId: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarQuery, setAvatarQuery] = useState("");
  const [voiceQuery, setVoiceQuery] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHeygenCatalog(orgSlug)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error);
          toast.error("Couldn't load the HeyGen catalog");
        } else {
          setCatalog(res.data);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("HeyGen catalog unavailable");
        toast.error("Couldn't load the HeyGen catalog");
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const avatars = useMemo(() => {
    const q = avatarQuery.toLowerCase();
    return (catalog?.avatars ?? [])
      .filter((a) => !q || a.avatar_name.toLowerCase().includes(q))
      .slice(0, 60);
  }, [catalog, avatarQuery]);

  const voices = useMemo(() => {
    const q = voiceQuery.toLowerCase();
    return (catalog?.voices ?? [])
      .filter((v) => v.language?.toLowerCase().startsWith("en"))
      .filter((v) => !q || v.name.toLowerCase().includes(q))
      .slice(0, 40);
  }, [catalog, voiceQuery]);

  if (error) {
    return (
      <div className="mt-3 rounded-[10px] border border-line bg-panel-2 px-4 py-3 text-[12.5px] text-ink-2">
        Couldn&apos;t load the HeyGen catalog — {error} You can still add a presenter via “Paste
        HeyGen IDs”.
      </div>
    );
  }
  if (!catalog) {
    return <div className="mt-3 py-8 text-center text-[12.5px] text-ink-3">Loading HeyGen catalog…</div>;
  }

  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_320px]">
      <div>
        {catalog.looks.length > 0 && (
          <div className="mb-4">
            <span className="eyebrow">Your avatars</span>
            <p className="mt-1 text-[11.5px] text-ink-3">
              Looks from your HeyGen account — outfits &amp; poses of your digital twin. These
              support transparent backgrounds.
            </p>
            <div className="mt-2.5 grid grid-cols-3 gap-2.5 md:grid-cols-4">
              {catalog.looks.map((look) => (
                <button
                  key={look.id}
                  onClick={() => onPickLook(look)}
                  className={`overflow-hidden rounded-[12px] border text-left transition-colors ${
                    selectedAvatarId === look.id
                      ? "border-accent shadow-[0_0_0_2px_rgba(61,91,245,.35)]"
                      : "border-line hover:border-accent-line"
                  }`}
                >
                  {look.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={look.imageUrl}
                      alt={look.name}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square items-center justify-center bg-panel-2 text-2xl">
                      🧑
                    </div>
                  )}
                  <div className="truncate px-2 py-1.5 text-[11px] font-semibold">{look.name}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="eyebrow">Stock avatars</span>
          <Input
            value={avatarQuery}
            onChange={(e) => setAvatarQuery(e.target.value)}
            placeholder="Search avatars…"
            className="max-w-[200px]"
          />
        </div>
        <div className="mt-2.5 grid max-h-[360px] grid-cols-3 gap-2.5 overflow-y-auto pr-1 md:grid-cols-4">
          {avatars.map((a) => (
            <button
              key={a.avatar_id}
              onClick={() => onPickAvatar(a)}
              className={`overflow-hidden rounded-[12px] border text-left transition-colors ${
                selectedAvatarId === a.avatar_id
                  ? "border-accent shadow-[0_0_0_2px_rgba(61,91,245,.35)]"
                  : "border-line hover:border-accent-line"
              }`}
            >
              {a.preview_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.preview_image_url}
                  alt={a.avatar_name}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <div className="flex aspect-square items-center justify-center bg-panel-2 text-2xl">
                  🧑
                </div>
              )}
              <div className="truncate px-2 py-1.5 text-[11px] font-semibold">{a.avatar_name}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="eyebrow">English voices</span>
          <Input
            value={voiceQuery}
            onChange={(e) => setVoiceQuery(e.target.value)}
            placeholder="Search…"
            className="max-w-[130px]"
          />
        </div>
        <div className="mt-2.5 flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-1">
          {voices.map((v) => (
            <div
              key={v.voice_id}
              className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 ${
                selectedVoiceId === v.voice_id ? "border-accent bg-accent-soft" : "border-line"
              }`}
            >
              <button
                onClick={() => onPickVoice(v.voice_id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-[12.5px] font-semibold">{v.name}</div>
                <div className="text-[10.5px] text-ink-3">
                  {v.language}
                  {v.gender ? ` · ${v.gender}` : ""}
                </div>
              </button>
              {v.preview_audio && (
                <button
                  aria-label={`Preview ${v.name}`}
                  onClick={() => {
                    audioRef.current?.pause();
                    audioRef.current = new Audio(v.preview_audio!);
                    audioRef.current.play();
                  }}
                  className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-accent-line bg-panel text-[11px] text-accent"
                >
                  ▶
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
