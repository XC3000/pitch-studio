/**
 * Document parsing for ingestion (S4): pdf-parse v2 for PDFs (per-page text →
 * chunks carry page numbers), mammoth for DOCX, passthrough for txt/md. When a
 * PDF has no text layer (scanned/image PDF) — or the file is an image — it falls
 * back to the managed OCR service (src/lib/ocr.ts) if configured.
 */

import { extractDocumentText, ocrConfigured } from "@/lib/ocr";

export type ParsedDoc = {
  /** ordered blocks of text; page is set for PDFs */
  blocks: { text: string; page?: number }[];
};

export async function parseDocument(bytes: Uint8Array, mime: string, filename: string): Promise<ParsedDoc> {
  const lower = filename.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return parsePdf(bytes, mime, filename);
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    return parseDocx(bytes);
  }
  if (mime.startsWith("text/") || /\.(txt|md|markdown|csv)$/.test(lower)) {
    return { blocks: [{ text: new TextDecoder().decode(bytes) }] };
  }
  // Images have no text layer at all — OCR is the only path.
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|tiff?)$/.test(lower)) {
    return ocrFallback(bytes, mime, filename);
  }
  throw new Error(`Unsupported document type: ${mime || filename}`);
}

async function parsePdf(bytes: Uint8Array, mime: string, filename: string): Promise<ParsedDoc> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const pages = (result.pages ?? []).filter((p) => p.text.trim());
    if (pages.length > 0) {
      return { blocks: pages.map((p) => ({ text: p.text, page: p.num })) };
    }
    const text = (result as unknown as { text?: string }).text ?? "";
    if (text.trim()) return { blocks: [{ text }] };
    // No embedded text layer — likely a scanned/image PDF. OCR it if we can.
    if (ocrConfigured()) return ocrFallback(bytes, mime, filename);
    throw new Error("PDF contained no extractable text (no text layer; set MISTRAL_API_KEY to OCR scanned PDFs)");
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function ocrFallback(bytes: Uint8Array, mime: string, filename: string): Promise<ParsedDoc> {
  if (!ocrConfigured()) throw new Error("Scanned/image documents need OCR — set MISTRAL_API_KEY");
  const { pages, text } = await extractDocumentText(bytes, mime, filename);
  if (pages.length > 0) return { blocks: pages.map((p) => ({ text: p.text, page: p.page })) };
  if (text.trim()) return { blocks: [{ text }] };
  throw new Error("OCR returned no text");
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDoc> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  if (!result.value.trim()) throw new Error("DOCX contained no extractable text");
  return { blocks: [{ text: result.value }] };
}
