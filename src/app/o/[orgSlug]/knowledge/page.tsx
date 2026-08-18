import { asc, desc } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { forOrg, schema } from "@/db/scoped";
import { KnowledgeManager } from "./knowledge-manager";
import type { DocumentRow, FactRow, PresentationOption } from "./actions";

export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);

  const scope = forOrg(org.id);
  const [documents, facts, presentations] = await Promise.all([
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
    scope.db
      .select({ id: schema.presentations.id, name: schema.presentations.name })
      .from(schema.presentations)
      .where(scope.own(schema.presentations))
      .orderBy(asc(schema.presentations.name)),
  ]);

  const inngestConnected =
    process.env.NODE_ENV === "development" ||
    (Boolean(process.env.INNGEST_EVENT_KEY) && Boolean(process.env.INNGEST_SIGNING_KEY));

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-6 sm:px-7 sm:py-8">
      <div className="eyebrow">Live Q&amp;A</div>
      <h2 className="mt-1 text-2xl">Knowledge base</h2>
      <p className="mt-1.5 max-w-[620px] text-sm text-ink-2">
        When a viewer interrupts to ask a question, the avatar answers from this knowledge base —
        not the scripts. Add documents and facts here; we index them so answers are precise and
        cited.
      </p>

      <KnowledgeManager
        orgSlug={orgSlug}
        initialDocuments={documents as DocumentRow[]}
        initialFacts={facts as FactRow[]}
        presentations={presentations as PresentationOption[]}
        fallbackText={org.qaFallbackText}
        inngestConnected={inngestConnected}
      />
    </div>
  );
}
