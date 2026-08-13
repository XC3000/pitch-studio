/**
 * Ingestion pipelines (flow 1 of the plan):
 *
 * doc/ingest:  parse (per-mime) → chunk (heading-aware, ~500 tok, 15% overlap)
 *              → embed (Voyage, batches of 128) → indexed + UsageRecord.
 * fact/ingest: same minus parse — a typed fact chunks & embeds on save.
 *
 * Chunk rows are inserted WITHOUT embeddings first, then embedded in per-batch
 * steps that update rows in place — step outputs stay tiny (counts only, never
 * vectors) and a retry resumes at the unembedded remainder. Failures set
 * status=failed + error for the Knowledge screen's Retry button.
 */

import { NonRetriableError } from "inngest";
import { and, count, eq, isNull } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { chunkText } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";
import { parseDocument } from "@/lib/parse-doc";
import { getDocBytes } from "@/lib/r2";
import { docIngestEvent, factIngestEvent, inngest } from "../client";

const EMBED_BATCH = 128;
const MAX_BATCHES = 400; // runaway backstop (~50k chunks)

type SourceType = "document" | "fact";
type StepTools = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"];

/** Embed all unembedded chunks for a source, batch by batch. Returns totals. */
async function embedSource(
  step: StepTools,
  orgId: string,
  sourceType: SourceType,
  sourceId: string,
  onProgress: (pct: number) => Promise<void>,
) {
  const db = systemDb();
  const own = and(
    eq(schema.chunks.orgId, orgId),
    eq(schema.chunks.sourceType, sourceType),
    eq(schema.chunks.sourceId, sourceId),
  );
  let totals = { tokens: 0, costUsd: 0 };
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await step.run(`embed-batch-${i}`, async () => {
      const [{ value: totalCount }] = await db.select({ value: count() }).from(schema.chunks).where(own);
      const rows = await db
        .select({ id: schema.chunks.id, text: schema.chunks.text })
        .from(schema.chunks)
        .where(and(own, isNull(schema.chunks.embedding)))
        .limit(EMBED_BATCH);
      if (rows.length === 0) return { remaining: 0, tokens: 0, costUsd: 0, totalCount };

      const { embeddings, totalTokens, costUsd, model } = await embed(
        rows.map((r) => r.text),
        "document",
      );
      for (let j = 0; j < rows.length; j++) {
        await db
          .update(schema.chunks)
          .set({ embedding: embeddings[j], embeddingModel: model })
          .where(eq(schema.chunks.id, rows[j].id));
      }
      const [{ value: remaining }] = await db
        .select({ value: count() })
        .from(schema.chunks)
        .where(and(own, isNull(schema.chunks.embedding)));
      return { remaining, tokens: totalTokens, costUsd, totalCount };
    });
    totals = { tokens: totals.tokens + batch.tokens, costUsd: totals.costUsd + batch.costUsd };
    const done = batch.totalCount - batch.remaining;
    await onProgress(batch.totalCount ? Math.round((done / batch.totalCount) * 100) : 100);
    if (batch.remaining === 0) break;
  }
  return totals;
}

export const ingestDocument = inngest.createFunction(
  {
    id: "ingest-document",
    retries: 2,
    triggers: [docIngestEvent],
    onFailure: async ({ event }) => {
      const { documentId } = event.data.event.data;
      const message = event.data.error.message ?? "ingestion failed";
      await systemDb()
        .update(schema.documents)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(schema.documents.id, documentId));
    },
  },
  async ({ event, step }) => {
    const { orgId, documentId } = event.data;
    const db = systemDb();

    const chunked = await step.run("parse-and-chunk", async () => {
      const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!doc || doc.orgId !== orgId) throw new NonRetriableError("document not found in org");

      await db
        .update(schema.documents)
        .set({ status: "parsing", progressPct: 5, error: null })
        .where(eq(schema.documents.id, documentId));

      const bytes = await getDocBytes(doc.r2Key);
      const parsed = await parseDocument(bytes, doc.mime, doc.filename).catch((e) => {
        throw new NonRetriableError(e instanceof Error ? e.message : "parse failed");
      });

      // Cache the full extracted text so deck generation doesn't re-extract this file.
      const fullText = parsed.blocks.map((b) => b.text).join("\n\n");
      await db
        .update(schema.documents)
        .set({ status: "chunking", progressPct: 20, extractedText: fullText || null })
        .where(eq(schema.documents.id, documentId));

      const chunks = parsed.blocks.flatMap((block) =>
        chunkText(block.text).map((c) => ({
          ...c,
          metadata: { ...c.metadata, ...(block.page ? { page: block.page } : {}) },
        })),
      );
      if (chunks.length === 0) throw new NonRetriableError("no text could be extracted");

      // reindex-safe: drop previous chunks for this doc, insert fresh
      await db
        .delete(schema.chunks)
        .where(
          and(
            eq(schema.chunks.orgId, orgId),
            eq(schema.chunks.sourceType, "document"),
            eq(schema.chunks.sourceId, documentId),
          ),
        );
      for (let i = 0; i < chunks.length; i += 200) {
        await db.insert(schema.chunks).values(
          chunks.slice(i, i + 200).map((c, j) => ({
            orgId,
            sourceType: "document" as const,
            sourceId: documentId,
            seq: i + j,
            text: c.text,
            tokenCount: c.tokenCount,
            metadata: c.metadata,
          })),
        );
      }
      await db
        .update(schema.documents)
        .set({ status: "embedding", progressPct: 30, chunkCount: chunks.length })
        .where(eq(schema.documents.id, documentId));
      return { chunkCount: chunks.length };
    });

    const totals = await embedSource(step, orgId, "document", documentId, async (pct) => {
      await db
        .update(schema.documents)
        .set({ progressPct: 30 + Math.round(pct * 0.7) })
        .where(eq(schema.documents.id, documentId));
    });

    await step.run("finish", async () => {
      await db
        .update(schema.documents)
        .set({ status: "indexed", progressPct: 100, error: null })
        .where(eq(schema.documents.id, documentId));
      await db.insert(schema.usageRecords).values({
        orgId,
        kind: "embedding",
        quantity: String(totals.tokens),
        unit: "tokens",
        costUsd: totals.costUsd.toFixed(6),
        ref: documentId,
      });
    });

    return { documentId, chunkCount: chunked.chunkCount };
  },
);

export const ingestFact = inngest.createFunction(
  {
    id: "ingest-fact",
    retries: 2,
    triggers: [factIngestEvent],
    onFailure: async ({ event }) => {
      const { factId } = event.data.event.data;
      await systemDb()
        .update(schema.facts)
        .set({ status: "failed" })
        .where(eq(schema.facts.id, factId));
    },
  },
  async ({ event, step }) => {
    const { orgId, factId } = event.data;
    const db = systemDb();

    const chunked = await step.run("chunk", async () => {
      const [fact] = await db.select().from(schema.facts).where(eq(schema.facts.id, factId));
      if (!fact || fact.orgId !== orgId) throw new NonRetriableError("fact not found in org");

      const text = fact.title ? `${fact.title}\n\n${fact.body}` : fact.body;
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new NonRetriableError("fact has no text");

      await db
        .delete(schema.chunks)
        .where(
          and(
            eq(schema.chunks.orgId, orgId),
            eq(schema.chunks.sourceType, "fact"),
            eq(schema.chunks.sourceId, factId),
          ),
        );
      await db.insert(schema.chunks).values(
        chunks.map((c, i) => ({
          orgId,
          sourceType: "fact" as const,
          sourceId: factId,
          seq: i,
          text: c.text,
          tokenCount: c.tokenCount,
          metadata: c.metadata,
        })),
      );
      await db
        .update(schema.facts)
        .set({ status: "embedding", chunkCount: chunks.length })
        .where(eq(schema.facts.id, factId));
      return { chunkCount: chunks.length };
    });

    const totals = await embedSource(step, orgId, "fact", factId, async () => {});

    await step.run("finish", async () => {
      await db.update(schema.facts).set({ status: "indexed" }).where(eq(schema.facts.id, factId));
      await db.insert(schema.usageRecords).values({
        orgId,
        kind: "embedding",
        quantity: String(totals.tokens),
        unit: "tokens",
        costUsd: totals.costUsd.toFixed(6),
        ref: factId,
      });
    });

    return { factId, chunkCount: chunked.chunkCount };
  },
);
