import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generatePresentation } from "@/inngest/functions/generate-presentation";
import { ingestDocument, ingestFact } from "@/inngest/functions/ingest-document";
import { renderIdleLoop, renderScene } from "@/inngest/functions/render-scene";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ingestDocument, ingestFact, renderScene, renderIdleLoop, generatePresentation],
});
