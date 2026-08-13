import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import type { VoiceTuning } from "@/lib/heygen";
import { PresenterManager } from "./presenter-manager";

export default async function PresentersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);

  const scope = forOrg(org.id);
  const rows = await scope.db
    .select()
    .from(schema.presenters)
    .where(scope.own(schema.presenters));

  const presenters = rows.map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    headshotUrl: p.headshotUrl,
    heygenAvatarId: p.heygenAvatarId,
    supportsMatting: p.supportsMatting,
    hasIdleLoop: !!p.idleVideoR2Key,
    voices: p.voices as Record<string, { heygenVoiceId?: string; elevenVoiceId?: string }>,
    voiceSettings: (p.voiceSettings ?? {}) as VoiceTuning,
  }));

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-8">
      <div className="eyebrow">Avatars &amp; voices</div>
      <h2 className="mt-1 text-2xl">Presenters</h2>
      <p className="mt-1.5 max-w-[620px] text-sm text-ink-2">
        Presenters deliver your pitch — pick a stock HeyGen avatar to start in minutes, or paste
        the avatar &amp; voice IDs of your own digital twin. All renders run through the platform;
        no HeyGen account needed.
      </p>

      <PresenterManager orgSlug={orgSlug} presenters={presenters} />
    </div>
  );
}
