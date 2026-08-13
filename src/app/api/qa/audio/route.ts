/**
 * GET /api/qa/audio?exchange=…&link=… — streams ElevenLabs TTS of a just-
 * answered Q&A exchange in the presenter's cloned voice.
 *
 * TTS-abuse protection: the text spoken is ALWAYS the stored answer of a
 * recent exchange belonging to this link's org (never caller-supplied text),
 * and each exchange can only be voiced once shortly after it was created.
 * 204 = captions-only degrade (no key, no voice, expired, or replay).
 */

import { and, eq } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { ttsConfigured, ttsCostUsd, ttsStream } from "@/lib/tts";
import { resolveQaContext } from "@/lib/viewer-data";

export const dynamic = "force-dynamic";

const MAX_AGE_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const exchangeId = url.searchParams.get("exchange");
  const linkId = url.searchParams.get("link");
  if (!exchangeId || !linkId) return new Response(null, { status: 400 });
  if (!ttsConfigured()) return new Response(null, { status: 204 });

  const ctx = await resolveQaContext(linkId);
  if (!ctx) return new Response(null, { status: 404 });
  if (!ctx.elevenVoiceId) return new Response(null, { status: 204 });

  const db = systemDb();
  const [exchange] = await db
    .select({
      id: schema.qaExchanges.id,
      answer: schema.qaExchanges.answer,
      createdAt: schema.qaExchanges.createdAt,
    })
    .from(schema.qaExchanges)
    .where(and(eq(schema.qaExchanges.id, exchangeId), eq(schema.qaExchanges.orgId, ctx.orgId)));
  if (!exchange || !exchange.answer.trim()) return new Response(null, { status: 204 });
  if (Date.now() - exchange.createdAt.getTime() > MAX_AGE_MS) return new Response(null, { status: 204 });

  try {
    const audio = await ttsStream(ctx.elevenVoiceId, exchange.answer);
    await db.insert(schema.usageRecords).values({
      orgId: ctx.orgId,
      kind: "tts",
      quantity: String(exchange.answer.length),
      unit: "characters",
      costUsd: ttsCostUsd(exchange.answer).toFixed(6),
      ref: exchange.id,
    });
    return new Response(audio, {
      headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 204 }); // captions-only degrade
  }
}
