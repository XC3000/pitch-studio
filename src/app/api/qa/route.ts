/**
 * POST /api/qa — the live RAG Q&A endpoint the viewer calls when a prospect
 * interrupts. Public by design (the share link is the credential): the org is
 * derived from the linkId server-side, rate limits guard cost, and the answer
 * streams back as SSE:
 *
 *   event: citations  → [{chunkId, sourceName, sourceType, page?}]
 *   event: delta      → {t: "..."}            (answer text, incremental)
 *   event: done       → {exchangeId, hitFallback, answer, voice}
 *   event: error      → {message}
 *
 * After `done`, the client may GET /api/qa/audio?exchange=…&link=… for TTS.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { answerQuestion, qaConfigured } from "@/lib/qa";
import { checkQaRateLimit } from "@/lib/ratelimit";
import { ttsConfigured } from "@/lib/tts";
import { resolveQaContext } from "@/lib/viewer-data";

export const dynamic = "force-dynamic";

const MAX_QUESTION_CHARS = 300;
const encoder = new TextEncoder();

function sse(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: Request) {
  let body: { linkId?: string; sessionId?: string; question?: string; sceneId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const { linkId, sessionId, sceneId } = body;
  const question = body.question?.trim();
  if (!linkId || !question) return Response.json({ error: "linkId and question required" }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json({ error: "question too long" }, { status: 400 });
  }

  const ctx = await resolveQaContext(linkId);
  if (!ctx) return Response.json({ error: "link not available" }, { status: 404 });

  // sessionId is optional but must belong to this link if provided
  let validSessionId: string | null = null;
  if (sessionId) {
    const [session] = await systemDb()
      .select({ id: schema.viewSessions.id })
      .from(schema.viewSessions)
      .where(and(eq(schema.viewSessions.id, sessionId), eq(schema.viewSessions.shareLinkId, linkId)));
    validSessionId = session?.id ?? null;
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);
  const rate = await checkQaRateLimit({ ipHash, linkId, sessionId: validSessionId });
  if (!rate.allowed) return Response.json({ error: rate.reason }, { status: 429 });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!qaConfigured()) {
          // Keys not wired yet — degrade to the org fallback so the viewer
          // still gets a spoken-style reply instead of an error.
          controller.enqueue(sse("citations", []));
          controller.enqueue(sse("delta", { t: ctx.fallbackText }));
          controller.enqueue(
            sse("done", { exchangeId: null, hitFallback: true, answer: ctx.fallbackText, voice: false }),
          );
          return;
        }
        const outcome = await answerQuestion({
          orgId: ctx.orgId,
          question,
          fallbackText: ctx.fallbackText,
          sessionId: validSessionId,
          presentationId: ctx.presentationId,
          sceneId: sceneId ?? null,
          onCitations: (citations) => controller.enqueue(sse("citations", citations)),
          onDelta: (t) => controller.enqueue(sse("delta", { t })),
        });
        controller.enqueue(
          sse("done", {
            exchangeId: outcome.exchangeId,
            hitFallback: outcome.hitFallback,
            answer: outcome.answer,
            voice: ttsConfigured() && !!ctx.elevenVoiceId,
          }),
        );
      } catch (e) {
        controller.enqueue(
          sse("error", { message: e instanceof Error ? e.message.slice(0, 200) : "answer failed" }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
