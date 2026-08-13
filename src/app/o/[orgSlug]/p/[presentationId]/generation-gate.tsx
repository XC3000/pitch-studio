"use client";

/**
 * Progress overlay for the create-with-a-brief flow. While the deck-generation
 * Inngest job runs (presentations.settings.generation.status === "generating"),
 * this covers the Scene Builder and polls getGenerationStatus. On "ready" it
 * does a full reload so the server component re-renders with the new scenes
 * (the builder holds initialScenes in state, so a soft refresh wouldn't show them).
 *
 * Resilient by design: one poll in flight at a time (recursive setTimeout, not
 * setInterval), transient errors tolerated, and a hard timeout that stops
 * polling and surfaces a manual escape — so a job that never runs (e.g. the
 * Inngest dev server isn't started) can't spin forever.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getGenerationStatus, type GenerationStatus } from "../../actions";

const POLL_MS = 2500;
const TIMEOUT_MS = 3 * 60 * 1000; // stop polling after 3 min of no completion

type View = "generating" | "failed" | "timeout" | "done";

export function GenerationGate({
  orgSlug,
  presentationId,
  initial,
}: {
  orgSlug: string;
  presentationId: string;
  initial: GenerationStatus;
}) {
  const [view, setView] = useState<View>(initial.status === "failed" ? "failed" : "generating");
  const [error, setError] = useState(initial.error);
  const dismissed = useRef(false);

  useEffect(() => {
    if (view !== "generating") return;
    dismissed.current = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;

    const poll = async () => {
      if (dismissed.current) return;
      try {
        const next = await getGenerationStatus(orgSlug, presentationId);
        consecutiveErrors = 0;
        if (dismissed.current) return;
        if (next.status === "ready") {
          window.location.reload();
          return;
        }
        if (next.status === "failed") {
          setError(next.error);
          setView("failed");
          return;
        }
        // status "generating" or "none" → keep waiting, unless we've waited too long
      } catch {
        // Transient (network hiccup, action error) — tolerate a few before giving up.
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          setView("timeout");
          return;
        }
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setView("timeout");
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      dismissed.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [view, orgSlug, presentationId]);

  if (view === "done") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 backdrop-blur-sm">
      <div className="mx-4 max-w-md rounded-[18px] border border-line bg-panel px-8 py-9 text-center shadow-card">
        {view === "generating" ? (
          <>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Sparkles className="size-6" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Drafting your deck…</h2>
            <p className="mt-2 text-[13px] text-ink-2">
              Reading your brief and documents, then writing the narrative and each scene. This
              usually takes under a minute.
            </p>
            <Loader2 className="mx-auto mt-5 size-5 animate-spin text-ink-3" />
            <button
              className="mt-6 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
              onClick={() => setView("done")}
            >
              Skip and build by hand
            </button>
          </>
        ) : (
          <>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-bad-soft text-bad">
              <AlertTriangle className="size-6" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              {view === "failed" ? "Generation failed" : "Still working…"}
            </h2>
            <p className="mt-2 text-[13px] text-ink-2">
              {view === "failed"
                ? error || "Something went wrong while drafting the deck."
                : "The draft hasn't finished. If you're running locally, make sure the Inngest dev server is running (npx inngest-cli@latest dev) so the job can process."}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button variant="outline" onClick={() => setView("done")}>
                Build by hand
              </Button>
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
