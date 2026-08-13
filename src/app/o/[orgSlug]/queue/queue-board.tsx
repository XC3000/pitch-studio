"use client";

import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { DslRenderer } from "@/viewer/dsl-renderer";
import "@/viewer/viewer.css";
import { approveProposalAction, rejectProposalAction, type ProposalRow } from "./actions";

export function QueueBoard({ orgSlug, proposals }: { orgSlug: string; proposals: ProposalRow[] }) {
  if (proposals.length === 0) {
    return (
      <div className="mt-8 rounded-[16px] border border-line bg-panel px-8 py-16 text-center shadow-card">
        <div className="eyebrow">Nothing to review</div>
        <p className="mx-auto mt-3 max-w-sm text-[13px] text-ink-2">
          When a scene needs a visual no existing template covers, propose one from the Scene Builder
          — it lands here for approval before it can join the library.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      {proposals.map((p) => (
        <ProposalCard key={p.id} orgSlug={orgSlug} proposal={p} />
      ))}
    </div>
  );
}

function ProposalCard({ orgSlug, proposal }: { orgSlug: string; proposal: ProposalRow }) {
  const { run, pending } = useAction();

  return (
    <div className="overflow-hidden rounded-[16px] border border-line bg-panel shadow-card">
      <div className="grid gap-0 lg:grid-cols-[1fr_minmax(0,520px)]">
        {/* left: metadata + actions */}
        <div className="flex flex-col p-6">
          <div className="eyebrow">Proposed template</div>
          <h3 className="mt-1 text-lg font-semibold">{proposal.name}</h3>
          {proposal.sceneName && (
            <div className="mt-1 text-[12px] text-ink-2">
              Requested for scene <span className="font-medium text-ink">{proposal.sceneName}</span>
            </div>
          )}
          <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">Requested because:</span> {proposal.reason}
          </p>
          {proposal.model && (
            <div className="mt-2 text-[11px] uppercase tracking-wide text-ink-3">
              drafted by {proposal.model}
            </div>
          )}

          <div className="mt-auto flex gap-2 pt-6">
            <Button
              onClick={() =>
                run(() => approveProposalAction(orgSlug, proposal.id), {
                  success: `“${proposal.name}” added to the library`,
                })
              }
              disabled={pending}
            >
              <Check className="size-4" /> Approve
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                run(() => rejectProposalAction(orgSlug, proposal.id), { success: "Proposal rejected" })
              }
              disabled={pending}
            >
              <X className="size-4" /> Reject
            </Button>
          </div>
        </div>

        {/* right: live DSL preview on the stage background */}
        <div className="border-t border-line lg:border-l lg:border-t-0">
          <div className="border-b border-line px-4 py-2 text-[11px] uppercase tracking-wide text-ink-3">
            Live preview
          </div>
          <div className="flex min-h-[300px] items-center justify-center overflow-auto bg-[#F2F6FC] p-6">
            {proposal.layout ? (
              <DslRenderer layout={proposal.layout} params={proposal.previewParams} />
            ) : (
              <div className="text-[12px] text-ink-3">No renderable layout in this proposal.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
