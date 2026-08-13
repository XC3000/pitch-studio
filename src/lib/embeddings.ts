/**
 * Embeddings — Voyage `voyage-3.5` (1024-dim, multilingual), REST via fetch
 * (Voyage has no official Node SDK). Falls back to OpenAI
 * `text-embedding-3-small` at dimensions=1024 behind the same interface when
 * only OPENAI_API_KEY is configured. The chunk row records which model
 * produced each vector so a provider swap forces a visible reindex.
 */

import { EMBEDDING_DIMS } from "@/db/schema";

export const VOYAGE_MODEL = "voyage-3.5";
const OPENAI_MODEL = "text-embedding-3-small";

/** USD per 1M tokens — voyage-3.5 list price; override if pricing shifts. */
const VOYAGE_USD_PER_MTOK = Number(process.env.VOYAGE_USD_PER_MTOK ?? "0.06");

export type EmbedInputType = "document" | "query";

export type EmbedResult = {
  embeddings: number[][];
  totalTokens: number;
  costUsd: number;
  model: string;
};

export function embeddingsConfigured() {
  return !!process.env.VOYAGE_API_KEY || !!process.env.OPENAI_API_KEY;
}

/** Embed up to 128 texts per call (Voyage batch limit). */
export async function embed(texts: string[], inputType: EmbedInputType): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0, costUsd: 0, model: "none" };
  if (process.env.VOYAGE_API_KEY) return embedVoyage(texts, inputType);
  if (process.env.OPENAI_API_KEY) return embedOpenAI(texts);
  throw new Error("No embeddings provider configured — set VOYAGE_API_KEY (or OPENAI_API_KEY)");
}

async function embedVoyage(texts: string[], inputType: EmbedInputType): Promise<EmbedResult> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMS,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  const byIndex = [...data.data].sort((a, b) => a.index - b.index);
  const totalTokens = data.usage?.total_tokens ?? 0;
  return {
    embeddings: byIndex.map((d) => d.embedding),
    totalTokens,
    costUsd: (totalTokens / 1_000_000) * VOYAGE_USD_PER_MTOK,
    model: VOYAGE_MODEL,
  };
}

async function embedOpenAI(texts: string[]): Promise<EmbedResult> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: texts, dimensions: EMBEDDING_DIMS }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  const byIndex = [...data.data].sort((a, b) => a.index - b.index);
  const totalTokens = data.usage?.total_tokens ?? 0;
  return {
    embeddings: byIndex.map((d) => d.embedding),
    totalTokens,
    costUsd: (totalTokens / 1_000_000) * 0.02,
    model: OPENAI_MODEL,
  };
}
