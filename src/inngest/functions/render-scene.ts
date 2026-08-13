import { NonRetriableError } from "inngest";
import { eq } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { estimateWordTimings, parseVttToWords, type WordTiming } from "@/lib/captions";
import { createAvatarVideo, getVideoStatus, renderCostUsd, type VoiceTuning } from "@/lib/heygen";
import { mediaUrl, putMedia } from "@/lib/r2";
import { heygenCompletedEvent, inngest, renderIdleEvent, renderSceneEvent } from "../client";

/**
 * Scene render pipeline (flow 3 of the plan):
 * enqueue (RenderJob row + this event) → HeyGen create-video →
 * waitForEvent('heygen/video.completed') with a poll fallback → download to R2
 * → caption timings (HeyGen VTT asset, else estimated) → SceneAudio + done →
 * UsageRecord(render).
 */

type StepTools = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"];

/**
 * Webhook-first completion wait: 12m on the webhook, then poll HeyGen every
 * 2m (renders are "several minutes"; treated as ambient background state).
 */
async function awaitHeygenVideo(step: StepTools, videoId: string) {
  const webhook = await step.waitForEvent("wait-heygen-webhook", {
    event: heygenCompletedEvent,
    timeout: "12m",
    if: `async.data.heygenVideoId == "${videoId}"`,
  });
  if (webhook && webhook.data.status === "failed") {
    throw new NonRetriableError("HeyGen reported the render failed");
  }
  if (!webhook) {
    for (let i = 0; i < 12; i++) {
      const status = await step.run(`poll-status-${i}`, () => getVideoStatus(videoId));
      if (status.status === "completed") break;
      if (status.status === "failed") {
        throw new NonRetriableError(`HeyGen render failed: ${status.error ?? "unknown"}`);
      }
      if (i === 11) throw new Error("HeyGen render timed out (no webhook, still processing)");
      await step.sleep(`poll-wait-${i}`, "2m");
    }
  }
  // Webhook payloads omit duration/captions — always read the final status.
  return step.run("fetch-final-status", async () => {
    const status = await getVideoStatus(videoId);
    if (status.status !== "completed" || !status.videoUrl) {
      throw new Error(`HeyGen video not downloadable (status ${status.status})`);
    }
    return status;
  });
}

async function downloadToR2(url: string, key: string, contentType: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`video download failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await putMedia(key, bytes, contentType);
  return bytes.byteLength;
}

const SILENCE_SEC = 8;
const SILENCE_KEY = `assets/silence-${SILENCE_SEC}s.wav`;

/** 16kHz 16-bit mono PCM WAV of pure silence (V3 idle loops lip-sync this). */
function silentWav(seconds: number): Uint8Array {
  const rate = 16000;
  const dataLen = rate * seconds * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits/sample
  ascii(36, "data");
  v.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

/** Upload (idempotent overwrite) the shared silent track and return its public URL. */
async function ensureSilenceAudio(): Promise<string> {
  await putMedia(SILENCE_KEY, silentWav(SILENCE_SEC), "audio/wav");
  return mediaUrl(SILENCE_KEY);
}

export const renderScene = inngest.createFunction(
  {
    id: "render-scene",
    retries: 2,
    triggers: [renderSceneEvent],
    onFailure: async ({ event }) => {
      const { renderJobId } = event.data.event.data;
      const message = event.data.error.message ?? "render failed";
      await systemDb()
        .update(schema.renderJobs)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(schema.renderJobs.id, renderJobId));
    },
  },
  async ({ event, step }) => {
    const { orgId, sceneId, lang, presenterId, renderJobId } = event.data;
    const db = systemDb();

    const ctx = await step.run("load", async () => {
      const [job] = await db
        .select()
        .from(schema.renderJobs)
        .where(eq(schema.renderJobs.id, renderJobId));
      if (!job || job.orgId !== orgId) throw new NonRetriableError("render job not found");
      const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId));
      const [presenter] = await db
        .select()
        .from(schema.presenters)
        .where(eq(schema.presenters.id, presenterId));
      if (!scene || scene.orgId !== orgId || !presenter || presenter.orgId !== orgId) {
        throw new NonRetriableError("scene or presenter not found in org");
      }
      if (!scene.script) throw new NonRetriableError("scene has no script to render");
      if (!presenter.heygenAvatarId) {
        throw new NonRetriableError("presenter has no HeyGen avatar id");
      }
      const voices = presenter.voices as Record<string, { heygenVoiceId?: string }>;
      const heygenVoiceId = voices[lang]?.heygenVoiceId;
      if (!heygenVoiceId) {
        throw new NonRetriableError(`presenter has no HeyGen voice for "${lang}"`);
      }
      return {
        script: scene.script,
        avatarId: presenter.heygenAvatarId,
        heygenVoiceId,
        matting: presenter.supportsMatting,
        voice: (presenter.voiceSettings ?? {}) as VoiceTuning,
      };
    });

    const created = await step.run("create-heygen-video", async () => {
      const video = await createAvatarVideo({
        avatarId: ctx.avatarId,
        voiceId: ctx.heygenVoiceId,
        script: ctx.script,
        matting: ctx.matting,
        voice: ctx.voice,
        callbackId: renderJobId,
      });
      await db
        .update(schema.renderJobs)
        .set({ status: "rendering", heygenVideoId: video.videoId, error: null })
        .where(eq(schema.renderJobs.id, renderJobId));
      return video;
    });

    const status = await awaitHeygenVideo(step, created.videoId);

    const stored = await step.run("download-to-r2", async () => {
      await db
        .update(schema.renderJobs)
        .set({ status: "downloading" })
        .where(eq(schema.renderJobs.id, renderJobId));
      const ext = created.kind === "webm-alpha" ? "webm" : "mp4";
      const key = `renders/${orgId}/${sceneId}/${lang}/${renderJobId}.${ext}`;
      const contentType = created.kind === "webm-alpha" ? "video/webm" : "video/mp4";
      await downloadToR2(status.videoUrl!, key, contentType);
      return { key };
    });

    await step.run("captions-and-finish", async () => {
      const durationSec = status.durationSec ?? 0;
      let captions: WordTiming[] = [];
      if (status.captionUrl) {
        try {
          const vtt = await (await fetch(status.captionUrl)).text();
          captions = parseVttToWords(vtt);
        } catch {
          // fall through to the estimate
        }
      }
      if (captions.length === 0 && durationSec > 0) {
        captions = estimateWordTimings(ctx.script, durationSec);
      }

      const costUsd = renderCostUsd(durationSec);
      await db
        .insert(schema.sceneAudios)
        .values({ orgId, renderJobId, captions })
        .onConflictDoUpdate({ target: schema.sceneAudios.renderJobId, set: { captions } });
      await db
        .update(schema.renderJobs)
        .set({
          status: "done",
          r2Key: stored.key,
          durationSec,
          costUsd: costUsd.toFixed(4),
          error: null,
        })
        .where(eq(schema.renderJobs.id, renderJobId));
      await db.insert(schema.usageRecords).values({
        orgId,
        kind: "render",
        quantity: durationSec.toFixed(2),
        unit: "seconds",
        costUsd: costUsd.toFixed(4),
        ref: renderJobId,
      });
    });

    return { renderJobId, videoId: created.videoId, r2Key: stored.key, kind: created.kind };
  },
);

/**
 * Idle/attentive loop per presenter — a short silent render the viewer plays
 * while Q&A answers stream as captions + TTS.
 */
export const renderIdleLoop = inngest.createFunction(
  { id: "render-idle-loop", retries: 2, triggers: [renderIdleEvent] },
  async ({ event, step }) => {
    const { orgId, presenterId } = event.data;
    const db = systemDb();

    const ctx = await step.run("load", async () => {
      const [presenter] = await db
        .select()
        .from(schema.presenters)
        .where(eq(schema.presenters.id, presenterId));
      if (!presenter || presenter.orgId !== orgId) {
        throw new NonRetriableError("presenter not found in org");
      }
      if (!presenter.heygenAvatarId) {
        throw new NonRetriableError("presenter has no HeyGen avatar id");
      }
      const voices = presenter.voices as Record<string, { heygenVoiceId?: string }>;
      const heygenVoiceId = Object.values(voices)[0]?.heygenVoiceId ?? "";
      return {
        avatarId: presenter.heygenAvatarId,
        heygenVoiceId,
        matting: presenter.supportsMatting,
      };
    });

    // V3 (matting) has no silence voice — the idle loop lip-syncs a hosted silent track.
    const silenceAudioUrl = ctx.matting
      ? await step.run("ensure-silence-audio", ensureSilenceAudio)
      : undefined;

    const created = await step.run("create-heygen-video", () =>
      createAvatarVideo({
        avatarId: ctx.avatarId,
        voiceId: ctx.heygenVoiceId,
        script: null,
        silenceSec: SILENCE_SEC,
        silenceAudioUrl,
        matting: ctx.matting,
        callbackId: `idle:${presenterId}`,
      }),
    );

    const status = await awaitHeygenVideo(step, created.videoId);

    await step.run("store-idle", async () => {
      const ext = created.kind === "webm-alpha" ? "webm" : "mp4";
      const key = `presenters/${orgId}/${presenterId}/idle.${ext}`;
      const contentType = created.kind === "webm-alpha" ? "video/webm" : "video/mp4";
      await downloadToR2(status.videoUrl!, key, contentType);
      await db
        .update(schema.presenters)
        .set({ idleVideoR2Key: key })
        .where(eq(schema.presenters.id, presenterId));
      const durationSec = status.durationSec ?? 8;
      await db.insert(schema.usageRecords).values({
        orgId,
        kind: "render",
        quantity: durationSec.toFixed(2),
        unit: "seconds",
        costUsd: renderCostUsd(durationSec).toFixed(4),
        ref: `idle:${presenterId}`,
      });
    });

    return { presenterId, videoId: created.videoId };
  },
);
