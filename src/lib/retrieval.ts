/**
 * Org-isolated vector retrieval over `chunks`.
 *
 * Isolation layer 3: EVERY search pins `org_id` in the WHERE clause BEFORE the
 * vector ORDER BY, so a cross-org chunk can never enter a prompt. Callers pass
 * an orgId they derived server-side (from a share link or requireOrg) — never
 * from client input.
 *
 * Tiered retrieval (binding decision): a question searches progressively wider
 * pools and stops at the first that clears the grounding threshold —
 *   (1) documents attached to the current SCENE (scenes.documentIds),
 *   (2) documents scoped to the current PRESENTATION (documents.presentationId),
 *   (3) ORG-WIDE documents + facts.
 * Facts are org-wide only (no presentation scope), so they surface in tier 3.
 * The query is embedded ONCE and reused across tiers.
 */

import { and, cosineDistance, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";
import { embed } from "@/lib/embeddings";

export type RetrievedChunk = {
  chunkId: string;
  text: string;
  similarity: number;
  sourceType: "document" | "fact";
  sourceId: string;
  sourceName: string;
  page?: number;
  heading?: string;
};

export type RetrievalTier = "scene" | "presentation" | "org" | "none";

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  /** cosine similarity of the best chunk; 0 when nothing indexed */
  topSimilarity: number;
  /** which pool the returned chunks came from */
  tier: RetrievalTier;
  queryTokens: number;
  queryCostUsd: number;
};

const TOP_K = 8;
/** below this floor a chunk isn't worth showing the model at all */
const MIN_SIMILARITY = Number(process.env.QA_MIN_SIMILARITY ?? "0.35");
/** the best chunk must clear this bar or we answer with the org fallback */
export const GROUNDING_THRESHOLD = Number(process.env.QA_GROUNDING_THRESHOLD ?? "0.45");

/**
 * The pool a single vector search runs over. `org` is the widest (all indexed
 * documents + facts for the org). `documents` restricts to a specific set of
 * document ids (facts are excluded — they have no scene/presentation scope).
 */
type SearchFilter = { kind: "org" } | { kind: "documents"; documentIds: string[] };

type RawChunk = {
  chunkId: string;
  text: string;
  similarity: number;
  sourceType: "document" | "fact";
  sourceId: string;
  metadata: unknown;
};

/** One org-isolated vector search over the given pool. Returns [] for an empty pool. */
async function searchChunks(
  orgId: string,
  queryVector: number[],
  filter: SearchFilter,
): Promise<RawChunk[]> {
  if (filter.kind === "documents" && filter.documentIds.length === 0) return [];
  const db = systemDb();

  const similarity = sql<number>`1 - (${cosineDistance(schema.chunks.embedding, queryVector)})`;
  const conditions = [
    eq(schema.chunks.orgId, orgId), // org filter FIRST — hard isolation
    isNotNull(schema.chunks.embedding),
    gt(similarity, MIN_SIMILARITY),
  ];
  if (filter.kind === "documents") {
    conditions.push(eq(schema.chunks.sourceType, "document"));
    conditions.push(inArray(schema.chunks.sourceId, filter.documentIds));
  }

  const rows = await db
    .select({
      chunkId: schema.chunks.id,
      text: schema.chunks.text,
      similarity,
      sourceType: schema.chunks.sourceType,
      sourceId: schema.chunks.sourceId,
      metadata: schema.chunks.metadata,
    })
    .from(schema.chunks)
    .where(and(...conditions))
    .orderBy(desc(similarity))
    .limit(TOP_K);
  return rows as RawChunk[];
}

/** Resolve human-readable citation names for a set of raw chunks. */
async function nameChunks(orgId: string, rows: RawChunk[]): Promise<RetrievedChunk[]> {
  if (rows.length === 0) return [];
  const db = systemDb();
  const docIds = [...new Set(rows.filter((r) => r.sourceType === "document").map((r) => r.sourceId))];
  const factIds = [...new Set(rows.filter((r) => r.sourceType === "fact").map((r) => r.sourceId))];
  const [docs, facts] = await Promise.all([
    docIds.length
      ? db
          .select({ id: schema.documents.id, filename: schema.documents.filename })
          .from(schema.documents)
          .where(and(eq(schema.documents.orgId, orgId), inArray(schema.documents.id, docIds)))
      : Promise.resolve([]),
    factIds.length
      ? db
          .select({ id: schema.facts.id, title: schema.facts.title })
          .from(schema.facts)
          .where(and(eq(schema.facts.orgId, orgId), inArray(schema.facts.id, factIds)))
      : Promise.resolve([]),
  ]);
  const docName = new Map(docs.map((d) => [d.id, d.filename]));
  const factName = new Map(facts.map((f) => [f.id, f.title ?? "Company fact"]));

  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as { page?: number; heading?: string };
    return {
      chunkId: r.chunkId,
      text: r.text,
      similarity: Number(r.similarity),
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      sourceName:
        r.sourceType === "document"
          ? (docName.get(r.sourceId) ?? "Document")
          : (factName.get(r.sourceId) ?? "Company fact"),
      ...(meta.page ? { page: meta.page } : {}),
      ...(meta.heading ? { heading: meta.heading } : {}),
    };
  });
}

export type TieredInput = {
  orgId: string;
  question: string;
  /** documents attached to the current scene (retrieval tier 1) */
  sceneDocumentIds?: string[];
  /** the presentation being viewed — its scoped documents are tier 2 */
  presentationId?: string | null;
};

/**
 * Tiered retrieval: search scene → presentation → org-wide, returning the FIRST
 * tier whose best chunk clears GROUNDING_THRESHOLD. If no tier clears it, the
 * org-wide result is returned (its topSimilarity may still be below threshold —
 * qa.ts applies the final grounded/fallback decision). The query is embedded
 * once and reused across every tier.
 */
export async function retrieveTiered(input: TieredInput): Promise<RetrievalResult> {
  const { orgId, question } = input;
  if (!orgId) throw new Error("retrieveTiered() requires an orgId");

  const { embeddings, totalTokens, costUsd } = await embed([question], "query");
  const queryVector = embeddings[0];

  const finish = async (rows: RawChunk[], tier: RetrievalTier): Promise<RetrievalResult> => {
    const chunks = await nameChunks(orgId, rows);
    return {
      chunks,
      topSimilarity: chunks[0]?.similarity ?? 0,
      tier: chunks.length ? tier : "none",
      queryTokens: totalTokens,
      queryCostUsd: costUsd,
    };
  };

  const sceneDocIds = [...new Set(input.sceneDocumentIds ?? [])];

  // Tier 1 — documents attached to the current scene.
  if (sceneDocIds.length > 0) {
    const rows = await searchChunks(orgId, queryVector, { kind: "documents", documentIds: sceneDocIds });
    const top = rows[0] ? Number(rows[0].similarity) : 0;
    if (top >= GROUNDING_THRESHOLD) return finish(rows, "scene");
  }

  // Tier 2 — documents scoped to the current presentation (∪ the scene docs, so
  // the pool truly widens rather than dropping the tier-1 sources).
  if (input.presentationId) {
    const db = systemDb();
    const presDocs = await db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.orgId, orgId),
          eq(schema.documents.presentationId, input.presentationId),
        ),
      );
    const tier2Ids = [...new Set([...sceneDocIds, ...presDocs.map((d) => d.id)])];
    if (tier2Ids.length > 0) {
      const rows = await searchChunks(orgId, queryVector, { kind: "documents", documentIds: tier2Ids });
      const top = rows[0] ? Number(rows[0].similarity) : 0;
      if (top >= GROUNDING_THRESHOLD) return finish(rows, "presentation");
    }
  }

  // Tier 3 — org-wide (all indexed documents + facts). Final tier: returned
  // whether or not it clears the threshold.
  const rows = await searchChunks(orgId, queryVector, { kind: "org" });
  return finish(rows, "org");
}

/**
 * Org-wide retrieval (no scene/presentation scoping) — the widest tier on its
 * own. Kept for the Knowledge test console, which has no viewing context.
 */
export async function retrieve(orgId: string, question: string): Promise<RetrievalResult> {
  return retrieveTiered({ orgId, question });
}
