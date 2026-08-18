import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generatePresentation } from "@/inngest/functions/generate-presentation";
import { ingestDocument, ingestFact } from "@/inngest/functions/ingest-document";
import { renderIdleLoop, renderScene } from "@/inngest/functions/render-scene";

const serveOrigin =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ingestDocument, ingestFact, renderScene, renderIdleLoop, generatePresentation],
  ...(serveOrigin ? { serveOrigin } : {}),
});

