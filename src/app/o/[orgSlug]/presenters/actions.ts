"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { inngest, renderIdleEvent } from "@/inngest/client";
import {
  listAvatars,
  listMyLooks,
  listVoices,
  type HeygenAvatar,
  type HeygenLook,
  type HeygenVoice,
  type VoiceTuning,
} from "@/lib/heygen";
import { mediaUrl, putMedia } from "@/lib/r2";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { ActionError, safeAction } from "@/lib/safe-action";

export type Catalog = { avatars: HeygenAvatar[]; voices: HeygenVoice[]; looks: HeygenLook[] };

// The stock catalog is platform-wide (fetched with the platform key), so a
// short module-level cache is safe across orgs.
let catalogCache: { at: number; data: Catalog } | null = null;

export async function getHeygenCatalog(orgSlug: string): Promise<ActionResult<Catalog>> {
  return safeAction("getHeygenCatalog", async () => {
    await requireOrg(orgSlug);
    if (catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.data;
    try {
      const [avatars, voices, looks] = await Promise.all([
        listAvatars(),
        listVoices(),
        // account looks are a bonus — a failure here shouldn't hide the stock gallery
        listMyLooks().catch(() => [] as HeygenLook[]),
      ]);
      catalogCache = { at: Date.now(), data: { avatars, voices, looks } };
      return catalogCache.data;
    } catch (e) {
      throw new ActionError(e instanceof Error ? e.message : "HeyGen catalog unavailable");
    }
  });
}

export type PresenterInput = {
  name: string;
  title: string;
  headshotUrl: string;
  heygenAvatarId: string;
  heygenVoiceId: string;
  elevenVoiceId: string;
  supportsMatting: boolean;
  voiceSettings: VoiceTuning;
};

/**
 * HeyGen look/preview images are signed URLs that expire within days — copy
 * them into our public media bucket so presenter cards don't rot.
 */
async function persistHeadshot(orgId: string, url: string): Promise<string> {
  if (!url || !/heygen\.(ai|com)/i.test(url)) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) return url;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const ext = contentType.includes("webp") ? "webp" : contentType.includes("png") ? "png" : "jpg";
    const key = `presenters/${orgId}/headshots/${crypto.randomUUID()}.${ext}`;
    await putMedia(key, bytes, contentType);
    return mediaUrl(key);
  } catch {
    return url;
  }
}

/** Strip a client-supplied tuning object down to the fields we store. */
function sanitizeVoiceSettings(v: VoiceTuning | undefined): VoiceTuning {
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
  const el = v?.elevenlabs;
  const out: VoiceTuning = {
    speed: num(v?.speed),
    pitch: num(v?.pitch),
    volume: num(v?.volume),
  };
  const elOut = {
    stability: num(el?.stability),
    similarityBoost: num(el?.similarityBoost),
    style: num(el?.style),
  };
  if (elOut.stability != null || elOut.similarityBoost != null || elOut.style != null) {
    out.elevenlabs = elOut;
  }
  return JSON.parse(JSON.stringify(out)) as VoiceTuning; // drop undefined keys
}

function validatePresenterInput(input: PresenterInput) {
  if (!input.name.trim()) throw new ActionError("Name is required");
  if (!input.heygenAvatarId.trim()) throw new ActionError("A HeyGen avatar is required");
  if (!input.heygenVoiceId.trim()) throw new ActionError("A HeyGen voice is required");
}

export async function createPresenter(
  orgSlug: string,
  input: PresenterInput,
): Promise<ActionResult> {
  return safeAction("createPresenter", async () => {
    const { org } = await requireOrg(orgSlug);
    validatePresenterInput(input);

    const scope = forOrg(org.id);
    await scope.db.insert(schema.presenters).values(
      scope.stamp({
        name: input.name.trim(),
        title: input.title.trim() || null,
        headshotUrl: (await persistHeadshot(org.id, input.headshotUrl.trim())) || null,
        heygenAvatarId: input.heygenAvatarId.trim(),
        supportsMatting: input.supportsMatting,
        voiceSettings: sanitizeVoiceSettings(input.voiceSettings),
        voices: {
          en: {
            heygenVoiceId: input.heygenVoiceId.trim(),
            elevenVoiceId: input.elevenVoiceId.trim() || undefined,
          },
        },
      }),
    );
    revalidatePath(`/o/${orgSlug}/presenters`);
  });
}

export async function updatePresenter(
  orgSlug: string,
  presenterId: string,
  input: PresenterInput,
): Promise<ActionResult> {
  return safeAction("updatePresenter", async () => {
    const { org } = await requireOrg(orgSlug);
    validatePresenterInput(input);

    const scope = forOrg(org.id);
    const [existing] = await scope.db
      .select()
      .from(schema.presenters)
      .where(scope.own(schema.presenters, eq(schema.presenters.id, presenterId)));
    if (!existing) throw new ActionError("Presenter not found");

    const voices = { ...(existing.voices as Record<string, object>) };
    voices.en = {
      heygenVoiceId: input.heygenVoiceId.trim(),
      elevenVoiceId: input.elevenVoiceId.trim() || undefined,
    };

    const avatarChanged = input.heygenAvatarId.trim() !== existing.heygenAvatarId;
    const headshot = input.headshotUrl.trim();
    await scope.db
      .update(schema.presenters)
      .set({
        name: input.name.trim(),
        title: input.title.trim() || null,
        headshotUrl:
          headshot === existing.headshotUrl
            ? existing.headshotUrl
            : (await persistHeadshot(org.id, headshot)) || null,
        heygenAvatarId: input.heygenAvatarId.trim(),
        supportsMatting: input.supportsMatting,
        voiceSettings: sanitizeVoiceSettings(input.voiceSettings),
        voices,
        // the idle loop was rendered with the old avatar/matting — force a re-render
        ...(avatarChanged || input.supportsMatting !== existing.supportsMatting
          ? { idleVideoR2Key: null }
          : {}),
      })
      .where(scope.own(schema.presenters, eq(schema.presenters.id, presenterId)));
    revalidatePath(`/o/${orgSlug}/presenters`);
  });
}

export async function deletePresenter(
  orgSlug: string,
  presenterId: string,
): Promise<ActionResult> {
  return safeAction("deletePresenter", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    await scope.db
      .delete(schema.presenters)
      .where(scope.own(schema.presenters, eq(schema.presenters.id, presenterId)));
    revalidatePath(`/o/${orgSlug}/presenters`);
  });
}

/** Kick off the short silent idle/attentive loop render for a presenter. */
export async function requestIdleLoop(
  orgSlug: string,
  presenterId: string,
): Promise<ActionResult> {
  return safeAction("requestIdleLoop", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [presenter] = await scope.db
      .select()
      .from(schema.presenters)
      .where(scope.own(schema.presenters, eq(schema.presenters.id, presenterId)));
    if (!presenter) throw new ActionError("Presenter not found");
    if (!presenter.heygenAvatarId) throw new ActionError("Presenter has no HeyGen avatar id");
    await inngest.send(renderIdleEvent.create({ orgId: org.id, presenterId }));
  });
}
