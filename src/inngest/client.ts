import { Inngest, eventType } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({ id: "pitch-studio" });

// Typed events (Inngest v4): use as function triggers, and build payloads with
// `.create(...)`. NOTE: `.create()` only BUILDS the event object — it does NOT
// send. You must pass it to `inngest.send(...)` to actually dispatch the event.

export const docIngestEvent = eventType("doc/ingest", {
  schema: z.object({ orgId: z.string(), documentId: z.string() }),
});

export const factIngestEvent = eventType("fact/ingest", {
  schema: z.object({ orgId: z.string(), factId: z.string() }),
});

export const renderSceneEvent = eventType("render/scene", {
  schema: z.object({
    orgId: z.string(),
    sceneId: z.string(),
    lang: z.string(),
    presenterId: z.string(),
    renderJobId: z.string(),
  }),
});

export const renderIdleEvent = eventType("render/idle", {
  schema: z.object({ orgId: z.string(), presenterId: z.string() }),
});

export const presentationGenerateEvent = eventType("presentation/generate", {
  schema: z.object({
    orgId: z.string(),
    presentationId: z.string(),
    brief: z.string(),
    documentIds: z.array(z.string()),
  }),
});

export const heygenCompletedEvent = eventType("heygen/video.completed", {
  schema: z.object({
    heygenVideoId: z.string(),
    status: z.enum(["success", "failed"]),
    videoUrl: z.string().optional(),
  }),
});
