import { requireOrg } from "@/lib/auth";
import { listPendingProposals } from "./actions";
import { QueueBoard } from "./queue-board";

export default async function TemplateQueuePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);
  const proposals = await listPendingProposals(org.id);

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-8">
      <div className="eyebrow">Governance</div>
      <h2 className="mt-1 text-2xl">Template approval queue</h2>
      <p className="mt-1.5 max-w-[620px] text-sm text-ink-2">
        When a scene needs a visual no existing template covers, the model proposes a new one built
        from the visual DSL. Nothing generated reaches a client deck until you approve it here —
        approved templates join the reusable library.
      </p>

      <QueueBoard orgSlug={orgSlug} proposals={proposals} />
    </div>
  );
}
