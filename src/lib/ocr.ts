/**
 * Document OCR / text extraction — provider-abstracted, mirroring src/lib/llm.ts.
 * OCR_PROVIDER picks the backend (only "mistral" today). Used for two things:
 *   1. a fallback in parse-doc.ts when a PDF has no text layer (scanned/image PDFs), and
 *   2. extracting the full text of every uploaded doc to feed deck generation.
 *
 * Returns the same block shape parse-doc.ts emits, so page metadata flows
 * downstream unchanged. Degrades: no key → ocrConfigured() is false and callers
 * fall back to the text-layer parser.
 */

export type OcrProvider = "mistral";

const OCR_PROVIDER: OcrProvider = (process.env.OCR_PROVIDER as OcrProvider | undefined) || "mistral";

/** Env var name for the active provider's key — used in user-facing copy. */
export function ocrKeyEnvVar(): string {
  return "MISTRAL_API_KEY";
}

export function ocrConfigured(): boolean {
  return !!process.env.MISTRAL_API_KEY;
}

export type OcrResult = {
  /** full extracted text (markdown), pages joined */
  text: string;
  /** per-page blocks; page is 1-based to match parse-doc.ts */
  pages: { page: number; text: string }[];
  costUsd: number;
};

/** Mistral OCR: ~$1 / 1000 pages. */
const MISTRAL_PER_PAGE_USD = 0.001;

function isImage(mime: string, filename: string): boolean {
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(filename);
}

/**
 * Extract text from a document via the managed OCR service. Throws if OCR is
 * not configured (callers gate on ocrConfigured() first) or the API errors.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  mime: string,
  filename: string,
): Promise<OcrResult> {
  if (OCR_PROVIDER !== "mistral") throw new Error(`Unsupported OCR provider: ${OCR_PROVIDER}`);
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY is not set");

  const base64 = Buffer.from(bytes).toString("base64");
  const image = isImage(mime, filename);
  const contentType = mime || (image ? "image/png" : "application/pdf");
  const dataUri = `data:${contentType};base64,${base64}`;

  const document = image
    ? { type: "image_url" as const, image_url: dataUri }
    : { type: "document_url" as const, document_url: dataUri };

  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "mistral-ocr-latest", document }),
  });
  if (!res.ok) {
    throw new Error(`Mistral OCR failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    pages?: { index?: number; markdown?: string }[];
    usage_info?: { pages_processed?: number };
  };

  const pages = (data.pages ?? [])
    .map((p, i) => ({ page: (p.index ?? i) + 1, text: (p.markdown ?? "").trim() }))
    .filter((p) => p.text);
  const text = pages.map((p) => p.text).join("\n\n");
  const pagesProcessed = data.usage_info?.pages_processed ?? pages.length;

  return { text, pages, costUsd: pagesProcessed * MISTRAL_PER_PAGE_USD };
}
