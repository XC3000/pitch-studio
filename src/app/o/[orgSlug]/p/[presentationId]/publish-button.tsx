"use client";

import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { setPresentationStatus } from "../../actions";

export function PublishButton({
  orgSlug,
  presentationId,
  status,
}: {
  orgSlug: string;
  presentationId: string;
  status: "draft" | "live" | "archived";
}) {
  const { run, pending } = useAction();

  const go = (next: "draft" | "live") =>
    run(() => setPresentationStatus(orgSlug, presentationId, next), {
      success: next === "live" ? "Published — link is live" : "Unpublished",
    });

  return (
    <div className="flex items-center gap-2">
      {status === "live" ? (
        <Button
          variant="outline"
          onClick={() => go("draft")}
          disabled={pending}
          className="h-auto rounded-full border-line px-4 py-1.5 text-[11.5px] font-semibold text-ink-2"
        >
          Unpublish
        </Button>
      ) : (
        <Button
          onClick={() => go("live")}
          disabled={pending}
          className="h-auto rounded-full bg-linear-to-br from-accent-2 to-accent px-4 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_10px_22px_-10px_rgba(61,91,245,.6)]"
        >
          Publish
        </Button>
      )}
    </div>
  );
}
