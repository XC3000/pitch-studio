"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { docIngestEvent, factIngestEvent, inngest } from "@/inngest/client";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { llmKeyEnvVar } from "@/lib/llm";
import { qaConfigured } from "@/lib/qa";
import { answerQuestion, type QaOutcome } from "@/lib/qa";
import { deleteDoc, presignDocUpload } from "@/lib/r2";
import { ActionError, safeAction } from "@/lib/safe-action";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export type DocumentRow = {
  id: string;
  filename: string;
  status: string;
  progressPct: number;
  chunkCount: number;
  ragEnabled: boolean;
  /** retrieval scope: null = org-wide, else the presentation this doc is scoped to */
  presentationId: string | null;
  error: string | null;
};

export type PresentationOption = { id: string; name: string };

export type FactRow = {
  id: string;
  title: string | null;
  body: string;
  status: string;
  chunkCount: number;
};

/** Confirm a presentation id belongs to this org — else treat the doc as org-wide. */
async function resolvePresentationScope(
  scope: ReturnType<typeof forOrg>,
  presentationId: string | null | undefined,
): Promise<string | null> {
  if (!presentationId) return null;
  const [pres] = await scope.db
    .select({ id: schema.presentations.id })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!pres) throw new ActionError("Presentation not found");
  return pres.id;
}

/** Create the Document row + a presigned PUT so the browser uploads direct to R2. */
export async function startDocumentUpload(
  orgSlug: string,
  input: {
    filename: string;
    mime: string;
    bytes: number;
    ragEnabled?: boolean;
    /** null/omitted = org-wide; else scope the doc to this presentation (retrieval tier 2) */
    presentationId?: string | null;
  },
): Promise<ActionResult<{ documentId: string; uploadUrl: string }>> {
  return safeAction("startDocumentUpload", async () => {
    const { org, clerkUserId } = await requireOrg(orgSlug);
    const filename = input.filename.trim().slice(0, 200);
    if (!filename) throw new ActionError("Filename required");
    if (!ALLOWED_MIME.has(input.mime) && !/\.(pdf|docx|txt|md|csv)$/i.test(filename)) {
      throw new ActionError("Only PDF, DOCX, TXT, MD and CSV files are supported");
    }
    if (input.bytes > MAX_UPLOAD_BYTES) throw new ActionError("File too large (max 50 MB)");

    const scope = forOrg(org.id);
    const presentationId = await resolvePresentationScope(scope, input.presentationId);
    const [doc] = await scope.db
      .insert(schema.documents)
      .values(
        scope.stamp({
          filename,
          mime: input.mime || "application/octet-stream",
          r2Key: "", // set below once we know the id
          bytes: input.bytes,
          status: "uploaded" as const,
          ragEnabled: input.ragEnabled ?? true,
          presentationId,
          uploadedBy: clerkUserId,
        }),
      )
      .returning({ id: schema.documents.id });
    const r2Key = `docs/${org.id}/${doc.id}/${filename}`;
    await scope.db
      .update(schema.documents)
      .set({ r2Key })
      .where(scope.own(schema.documents, eq(schema.documents.id, doc.id)));

    try {
      const uploadUrl = await presignDocUpload(r2Key, input.mime || "application/octet-stream");
      return { documentId: doc.id, uploadUrl };
    } catch (e) {
      await scope.db.delete(schema.documents).where(scope.own(schema.documents, eq(schema.documents.id, doc.id)));
      throw new ActionError(e instanceof Error ? e.message : "R2 is not configured");
    }
  });
}

/**
 * Browser finished the PUT. If the doc opted into RAG, kick off
 * parse → chunk → embed → index; otherwise mark it store-only (evidence
 * that's never chunked/embedded/searchable).
 */
export async function finishDocumentUpload(
  orgSlug: string,
  documentId: string,
): Promise<ActionResult> {
  return safeAction("finishDocumentUpload", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [doc] = await scope.db
      .select({ id: schema.documents.id, ragEnabled: schema.documents.ragEnabled })
      .from(schema.documents)
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    if (!doc) throw new ActionError("Document not found");
    if (!doc.ragEnabled) {
      await scope.db
        .update(schema.documents)
        .set({ status: "stored", progressPct: 100, error: null })
        .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
      revalidatePath(`/o/${orgSlug}/knowledge`);
      return;
    }
    await scope.db
      .update(schema.documents)
      .set({ status: "uploaded", progressPct: 0, error: null })
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    await inngest.send(docIngestEvent.create({ orgId: org.id, documentId }));
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

/** Reindex re-runs ingestion; only valid for RAG-enabled docs. */
export async function reindexDocument(orgSlug: string, documentId: string): Promise<ActionResult> {
  return finishDocumentUpload(orgSlug, documentId);
}

/** Flip a document between store-only and RAG-searchable, (re)ingesting as needed. */
export async function setDocumentRag(
  orgSlug: string,
  documentId: string,
  ragEnabled: boolean,
): Promise<ActionResult> {
  return safeAction("setDocumentRag", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [doc] = await scope.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    if (!doc) throw new ActionError("Document not found");

    if (!ragEnabled) {
      // Going store-only: drop any chunks and mark stored.
      await scope.db
        .delete(schema.chunks)
        .where(
          scope.own(
            schema.chunks,
            and(eq(schema.chunks.sourceType, "document"), eq(schema.chunks.sourceId, documentId)),
          ),
        );
      await scope.db
        .update(schema.documents)
        .set({ status: "stored", progressPct: 100, chunkCount: 0, ragEnabled: false })
        .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
      revalidatePath(`/o/${orgSlug}/knowledge`);
      return;
    }

    await scope.db
      .update(schema.documents)
      .set({ ragEnabled: true, status: "uploaded", progressPct: 0 })
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    await inngest.send(docIngestEvent.create({ orgId: org.id, documentId }));
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

/** Change a document's retrieval scope: null = org-wide, else a presentation (tier 2). */
export async function setDocumentScope(
  orgSlug: string,
  documentId: string,
  presentationId: string | null,
): Promise<ActionResult> {
  return safeAction("setDocumentScope", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const resolved = await resolvePresentationScope(scope, presentationId);
    const updated = await scope.db
      .update(schema.documents)
      .set({ presentationId: resolved })
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)))
      .returning({ id: schema.documents.id });
    if (updated.length === 0) throw new ActionError("Document not found");
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

export async function deleteDocument(orgSlug: string, documentId: string): Promise<ActionResult> {
  return safeAction("deleteDocument", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const [doc] = await scope.db
      .select({ id: schema.documents.id, r2Key: schema.documents.r2Key })
      .from(schema.documents)
      .where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    if (!doc) throw new ActionError("Document not found");
    await scope.db
      .delete(schema.chunks)
      .where(
        scope.own(
          schema.chunks,
          and(eq(schema.chunks.sourceType, "document"), eq(schema.chunks.sourceId, documentId)),
        ),
      );
    await scope.db.delete(schema.documents).where(scope.own(schema.documents, eq(schema.documents.id, documentId)));
    if (doc.r2Key) await deleteDoc(doc.r2Key).catch(() => {});
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

export async function saveFact(
  orgSlug: string,
  input: { id?: string; title: string; body: string },
): Promise<ActionResult<{ factId: string }>> {
  return safeAction("saveFact", async () => {
    const { org } = await requireOrg(orgSlug);
    const body = input.body.trim();
    if (!body) throw new ActionError("Fact text is required");
    const title = input.title.trim() || null;
    const scope = forOrg(org.id);

    let factId = input.id ?? null;
    if (factId) {
      const updated = await scope.db
        .update(schema.facts)
        .set({ title, body, status: "uploaded", chunkCount: 0 })
        .where(scope.own(schema.facts, eq(schema.facts.id, factId)))
        .returning({ id: schema.facts.id });
      if (updated.length === 0) throw new ActionError("Fact not found");
    } else {
      const [fact] = await scope.db
        .insert(schema.facts)
        .values(scope.stamp({ title, body }))
        .returning({ id: schema.facts.id });
      factId = fact.id;
    }
    await inngest.send(factIngestEvent.create({ orgId: org.id, factId }));
    revalidatePath(`/o/${orgSlug}/knowledge`);
    return { factId };
  });
}

export async function deleteFact(orgSlug: string, factId: string): Promise<ActionResult> {
  return safeAction("deleteFact", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    await scope.db
      .delete(schema.chunks)
      .where(
        scope.own(schema.chunks, and(eq(schema.chunks.sourceType, "fact"), eq(schema.chunks.sourceId, factId))),
      );
    await scope.db.delete(schema.facts).where(scope.own(schema.facts, eq(schema.facts.id, factId)));
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

/** Edit the org's verbatim below-threshold fallback answer. */
export async function updateFallbackText(orgSlug: string, text: string): Promise<ActionResult> {
  return safeAction("updateFallbackText", async () => {
    const { org } = await requireOrg(orgSlug);
    const trimmed = text.trim();
    if (!trimmed) throw new ActionError("Fallback text cannot be empty");
    const scope = forOrg(org.id);
    await scope.db
      .update(schema.organizations)
      .set({ qaFallbackText: trimmed.slice(0, 500) })
      .where(eq(schema.organizations.id, org.id));
    revalidatePath(`/o/${orgSlug}/knowledge`);
  });
}

/** Polling endpoint for the indexing-status UI. Read-only: returns data, not an ActionResult. */
export async function getKnowledgeStatus(orgSlug: string) {
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);
  const inngestConnected =
    process.env.NODE_ENV === "development" ||
    (Boolean(process.env.INNGEST_EVENT_KEY) && Boolean(process.env.INNGEST_SIGNING_KEY));

  const [documents, facts] = await Promise.all([
    scope.db
      .select({
        id: schema.documents.id,
        filename: schema.documents.filename,
        status: schema.documents.status,
        progressPct: schema.documents.progressPct,
        chunkCount: schema.documents.chunkCount,
        ragEnabled: schema.documents.ragEnabled,
        presentationId: schema.documents.presentationId,
        error: schema.documents.error,
      })
      .from(schema.documents)
      .where(scope.own(schema.documents))
      .orderBy(desc(schema.documents.createdAt)),
    scope.db
      .select({
        id: schema.facts.id,
        title: schema.facts.title,
        body: schema.facts.body,
        status: schema.facts.status,
        chunkCount: schema.facts.chunkCount,
      })
      .from(schema.facts)
      .where(scope.own(schema.facts))
      .orderBy(desc(schema.facts.createdAt)),
  ]);
  return { documents, facts, inngestConnected };
}

export type TestAnswer = Pick<
  QaOutcome,
  "answer" | "citations" | "confidence" | "hitFallback" | "latencyMs"
>;

/** The Knowledge test console — same retrieval + answer path as /api/qa. */
export async function testQuestion(
  orgSlug: string,
  question: string,
): Promise<ActionResult<TestAnswer>> {
  return safeAction("testQuestion", async () => {
    const { org } = await requireOrg(orgSlug);
    const q = question.trim();
    if (!q) throw new ActionError("Ask something first");
    if (!qaConfigured()) {
      throw new ActionError(
        `Q&A keys missing — set ${llmKeyEnvVar()} and VOYAGE_API_KEY in .env.local`,
      );
    }
    let outcome: QaOutcome;
    try {
      outcome = await answerQuestion({
        orgId: org.id,
        question: q,
        fallbackText: org.qaFallbackText,
        isTest: true,
      });
    } catch (e) {
      throw new ActionError(e instanceof Error ? e.message : "Q&A failed");
    }
    return {
      answer: outcome.answer,
      citations: outcome.citations,
      confidence: outcome.confidence,
      hitFallback: outcome.hitFallback,
      latencyMs: outcome.latencyMs,
    };
  });
}
