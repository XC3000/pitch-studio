/**
 * Public viewer — `/p/{presentationSlug}-{lang}` (default link) or
 * `/p/{presentationSlug}-{lang}-{code}` (per-recipient link).
 */
import { resolveViewer } from "@/lib/viewer-data";
import { Player } from "@/viewer/player";
import { PasscodeGate } from "./passcode-gate";

export const dynamic = "force-dynamic";

const MESSAGES = {
  not_found: {
    title: "This link doesn’t exist",
    body: "Check the address you were sent — this pitch link couldn’t be found.",
  },
  unavailable: {
    title: "This link is no longer available",
    body: "The link you followed has been closed by its sender. Please reach out to them for a fresh one.",
  },
  unpublished: {
    title: "This pitch isn’t live yet",
    body: "The link resolved, but its presentation hasn’t been published yet. Please check back soon.",
  },
} as const;

export default async function ViewerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveViewer(slug);

  if (!resolved.ok && resolved.reason === "locked") {
    return <PasscodeGate linkId={resolved.linkId} recipientName={resolved.recipientName} />;
  }

  if (!resolved.ok) {
    const msg = MESSAGES[resolved.reason];
    return (
      <main
        className="flex min-h-screen flex-col items-center justify-center px-6 text-center"
        style={{ background: "linear-gradient(180deg,#F8FBFF 0%,#EFF5FC 60%,#E9F1FA 100%)" }}
      >
        <div className="eyebrow">Pitch Studio</div>
        <h1 className="mt-3 text-2xl text-[#1E293B]">{msg.title}</h1>
        <p className="mt-2 max-w-sm text-sm text-[#64748B]">{msg.body}</p>
      </main>
    );
  }

  return <Player deck={resolved.deck} linkId={resolved.linkId} />;
}
