/**
 * Client-side view tracking. Creates the ViewSession on start, then batches
 * events to /api/track — flushed every few seconds, on a full batch, and via
 * sendBeacon when the tab hides (the `exit` path).
 */

export type TrackEventType =
  | "open"
  | "scene_enter"
  | "scene_complete"
  | "evidence_open"
  | "appendix_open"
  | "question"
  | "replay"
  | "exit";

type QueuedEvent = {
  type: TrackEventType;
  sceneId?: string | null;
  payload?: Record<string, unknown>;
  at: string;
};

const FLUSH_MS = 4000;
const MAX_BATCH = 20;

export class Tracker {
  private sessionId: string | null = null;
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;

  constructor(private linkId: string) {}

  /** the ViewSession id, once /api/session has responded (Q&A attaches to it) */
  getSessionId() {
    return this.sessionId;
  }

  start() {
    this.starting ??= fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: this.linkId }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { sessionId?: string };
        this.sessionId = data.sessionId ?? null;
      })
      .catch(() => {});
    this.timer ??= setInterval(() => void this.flush(), FLUSH_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        this.track("exit");
        this.flush(true);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    this.stopListening = () => document.removeEventListener("visibilitychange", onHide);
  }

  private stopListening: () => void = () => {};

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopListening();
  }

  track(type: TrackEventType, sceneId?: string | null, payload?: Record<string, unknown>) {
    this.queue.push({ type, sceneId, payload, at: new Date().toISOString() });
    if (this.queue.length >= MAX_BATCH) void this.flush();
  }

  async flush(beacon = false) {
    if (this.queue.length === 0) return;
    if (!this.sessionId) {
      await this.starting;
      if (!this.sessionId) return; // session never came up — drop silently
    }
    const events = this.queue.splice(0, MAX_BATCH);
    const body = JSON.stringify({ sessionId: this.sessionId, events });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
      return;
    }
    try {
      await fetch("/api/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      });
    } catch {
      // tracking is best-effort; never surface to the viewer
    }
  }
}
