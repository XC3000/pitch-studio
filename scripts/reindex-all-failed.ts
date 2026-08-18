import "dotenv/config";
import { eq, like } from "drizzle-orm";

async function main() {
  const { systemDb, schema } = await import("../src/db/system");
  const { inngest, docIngestEvent } = await import("../src/inngest/client");

  const db = systemDb();

  // Find documents with status 'failed' or old error string
  const failedDocs = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.status, "failed"));

  console.log(`Found ${failedDocs.length} failed documents.`);

  for (const d of failedDocs) {
    console.log(`Resetting and re-ingesting document ${d.id} (${d.filename})...`);
    await db
      .update(schema.documents)
      .set({ status: "uploaded", progressPct: 0, error: null })
      .where(eq(schema.documents.id, d.id));

    await inngest.send(docIngestEvent.create({ orgId: d.orgId, documentId: d.id }));
    console.log(`Queued docIngestEvent for ${d.id}`);
  }

  console.log("Done! Check Inngest server or refresh Knowledge base page.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
