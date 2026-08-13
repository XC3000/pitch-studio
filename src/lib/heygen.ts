/**
 * HeyGen API client — all avatar renders run through the platform's key
 * (orgs never bring their own HeyGen account, see plan §5b).
 *
 * Two render paths:
 * - transparent webm via POST /v3/videos with `output_format: "webm"` for
 *   matting-capable avatars (background removal is automatic; a `background`
 *   value is rejected on this path). V3 has no silence voice, so silent idle
 *   loops pass an `audio_url` to a silent WAV we host on R2.
 * - green-screen mp4 via /v2/video/generate for everyone else; the viewer
 *   chroma-keys it client-side (WebGL) into the same cutout slot.
 */

const BASE = "https://api.heygen.com";

/** Standard avatar pay-as-you-go price; override when HeyGen repraces. */
export const HEYGEN_USD_PER_MIN = Number(process.env.HEYGEN_USD_PER_MIN ?? "1");

/** Chroma background color used for non-matting renders (keyed out client-side). */
export const CHROMA_COLOR = "#00FF00";

function apiKey(): string {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("HEYGEN_API_KEY is not set (see .env.example)");
  return key;
}

async function heygenFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey(),
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HeyGen ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

// ── Catalog (stock avatars + voices for the presenter gallery) ─────────────

export type HeygenAvatar = {
  avatar_id: string;
  avatar_name: string;
  gender: string | null;
  preview_image_url: string | null;
  preview_video_url: string | null;
  premium?: boolean;
};

export type HeygenVoice = {
  voice_id: string;
  name: string;
  language: string;
  gender: string | null;
  preview_audio: string | null;
};

export async function listAvatars(): Promise<HeygenAvatar[]> {
  const json = await heygenFetch<{ data?: { avatars?: HeygenAvatar[] } }>("/v2/avatars");
  return json.data?.avatars ?? [];
}

export async function listVoices(): Promise<HeygenVoice[]> {
  const json = await heygenFetch<{ data?: { voices?: HeygenVoice[] } }>("/v2/voices");
  return json.data?.voices ?? [];
}

/**
 * A "look" is one outfit/pose of an account avatar group (e.g. the founder's
 * digital twin in a black suit). Looks render exactly like avatars — pass the
 * look id as `avatar_id`. NOTE: `imageUrl` is a signed URL that expires in
 * ~days, so persist a copy (R2) rather than the URL itself.
 */
export type HeygenLook = {
  id: string;
  name: string;
  imageUrl: string | null;
  groupId: string;
  groupName: string;
};

export async function listMyLooks(): Promise<HeygenLook[]> {
  const groupsJson = await heygenFetch<{
    data?: { avatar_group_list?: { id: string; name: string }[] };
  }>("/v2/avatar_group.list?include_public=false");
  const groups = groupsJson.data?.avatar_group_list ?? [];
  const looks: HeygenLook[] = [];
  for (const group of groups) {
    const looksJson = await heygenFetch<{
      data?: { avatar_list?: { id: string; name: string; image_url?: string | null }[] };
    }>(`/v2/avatar_group/${encodeURIComponent(group.id)}/avatars`);
    for (const look of looksJson.data?.avatar_list ?? []) {
      looks.push({
        id: look.id,
        name: look.name,
        imageUrl: look.image_url ?? null,
        groupId: group.id,
        groupName: group.name,
      });
    }
  }
  return looks;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Per-presenter delivery tuning, stored in `presenters.voice_settings` and
 * passed through on every render. All fields optional — defaults are HeyGen's.
 */
export type VoiceTuning = {
  /** Playback speed multiplier, 0.5–1.5 (1 = normal). */
  speed?: number;
  /** Pitch adjustment in semitones, -50…50 (0 = normal). */
  pitch?: number;
  /** Output volume, 0–1 (1 = full). */
  volume?: number;
  /** ElevenLabs engine tuning — only takes effect on ElevenLabs-backed voices. */
  elevenlabs?: { stability?: number; similarityBoost?: number; style?: number };
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** V3 `voice_settings` payload; undefined when everything is at defaults. */
function voiceSettingsPayload(t: VoiceTuning | undefined) {
  if (!t) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof t.speed === "number" && t.speed !== 1) out.speed = clamp(t.speed, 0.5, 1.5);
  if (typeof t.pitch === "number" && t.pitch !== 0) out.pitch = clamp(Math.round(t.pitch), -50, 50);
  if (typeof t.volume === "number" && t.volume !== 1) out.volume = clamp(t.volume, 0, 1);
  const el = t.elevenlabs;
  if (el && (el.stability != null || el.similarityBoost != null || el.style != null)) {
    out.engine_settings = {
      engine_type: "elevenlabs",
      ...(el.stability != null ? { stability: clamp(el.stability, 0, 1) } : {}),
      ...(el.similarityBoost != null ? { similarity_boost: clamp(el.similarityBoost, 0, 1) } : {}),
      ...(el.style != null ? { style: clamp(el.style, 0, 1) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export type CreateVideoInput = {
  avatarId: string;
  voiceId: string;
  /** Spoken script; when null, renders a silent idle loop of `silenceSec`. */
  script: string | null;
  silenceSec?: number;
  /**
   * Public URL of a silent audio track. Required for matting idle loops —
   * V3 has no silence voice type, so the avatar lip-syncs silence instead.
   */
  silenceAudioUrl?: string;
  /** true → transparent webm (matting avatars); false → green mp4 for client keying. */
  matting: boolean;
  /** per-presenter speed/pitch/volume/ElevenLabs tuning */
  voice?: VoiceTuning;
  /** echoed back in the webhook payload so we can match without state */
  callbackId?: string;
};

export type CreatedVideo = { videoId: string; kind: "webm-alpha" | "chroma" };

export async function createAvatarVideo(input: CreateVideoInput): Promise<CreatedVideo> {
  if (input.matting) {
    // V3 flat body. `output_format: webm` applies background removal
    // automatically and rejects any `background` value — do not add one.
    const body: Record<string, unknown> = {
      type: "avatar",
      avatar_id: input.avatarId,
      output_format: "webm",
      // square render drops straight into the viewer's bottom-center cutout slot
      aspect_ratio: "1:1",
      resolution: "720p",
      callback_id: input.callbackId,
    };
    if (input.script) {
      body.script = input.script;
      body.voice_id = input.voiceId;
      const vs = voiceSettingsPayload(input.voice);
      if (vs) body.voice_settings = vs;
    } else {
      if (!input.silenceAudioUrl) {
        throw new Error("matting idle render requires silenceAudioUrl (V3 has no silence voice)");
      }
      body.audio_url = input.silenceAudioUrl;
    }
    const json = await heygenFetch<{ data?: { video_id?: string } }>("/v3/videos", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const videoId = json.data?.video_id;
    if (!videoId) throw new Error("HeyGen /v3/videos returned no video_id");
    return { videoId, kind: "webm-alpha" };
  }

  const tuning = input.voice;
  const el = tuning?.elevenlabs;
  const voice = input.script
    ? {
        type: "text",
        voice_id: input.voiceId,
        input_text: input.script,
        ...(typeof tuning?.speed === "number" && tuning.speed !== 1
          ? { speed: clamp(tuning.speed, 0.5, 1.5) }
          : {}),
        ...(typeof tuning?.pitch === "number" && tuning.pitch !== 0
          ? { pitch: clamp(Math.round(tuning.pitch), -50, 50) }
          : {}),
        ...(el && (el.stability != null || el.similarityBoost != null || el.style != null)
          ? {
              elevenlabs_settings: {
                ...(el.stability != null ? { stability: clamp(el.stability, 0, 1) } : {}),
                ...(el.similarityBoost != null
                  ? { similarity_boost: clamp(el.similarityBoost, 0, 1) }
                  : {}),
                ...(el.style != null ? { style: clamp(el.style, 0, 1) } : {}),
              },
            }
          : {}),
      }
    : { type: "silence", duration: Math.min(100, Math.max(1, input.silenceSec ?? 8)) };

  const json = await heygenFetch<{ data?: { video_id?: string } }>("/v2/video/generate", {
    method: "POST",
    body: JSON.stringify({
      video_inputs: [
        {
          character: { type: "avatar", avatar_id: input.avatarId, avatar_style: "normal" },
          voice,
          background: { type: "color", value: CHROMA_COLOR },
        },
      ],
      dimension: { width: 720, height: 720 },
      caption: Boolean(input.script),
      callback_id: input.callbackId,
    }),
  });
  const videoId = json.data?.video_id;
  if (!videoId) throw new Error("HeyGen /v2/video/generate returned no video_id");
  return { videoId, kind: "chroma" };
}

export type VideoStatus = {
  status: "waiting" | "pending" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  durationSec: number | null;
  /** word/sentence-timed caption asset (webvtt/ass), when HeyGen produced one */
  captionUrl: string | null;
  error: string | null;
};

export async function getVideoStatus(videoId: string): Promise<VideoStatus> {
  const json = await heygenFetch<{
    data?: {
      status?: string;
      video_url?: string;
      duration?: number;
      caption_url?: string;
      error?: { message?: string } | string | null;
    };
  }>(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`);
  const d = json.data ?? {};
  const err = d.error;
  return {
    status: (d.status as VideoStatus["status"]) ?? "waiting",
    videoUrl: d.video_url ?? null,
    durationSec: typeof d.duration === "number" ? d.duration : null,
    captionUrl: d.caption_url ?? null,
    error: typeof err === "string" ? err : (err?.message ?? null),
  };
}

export function renderCostUsd(durationSec: number): number {
  return (durationSec / 60) * HEYGEN_USD_PER_MIN;
}
