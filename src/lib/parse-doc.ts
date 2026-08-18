/**
 * Document parsing for ingestion (S4): pdf-parse v2 for PDFs (per-page text →
 * chunks carry page numbers), mammoth for DOCX, passthrough for txt/md. When a
 * PDF has no text layer (scanned/image PDF) — or the file is an image — it falls
 * back to the managed OCR service (src/lib/ocr.ts) if configured.
 */

import fs from "node:fs/promises";
import path from "node:path";
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



import { pathToFileURL } from "node:url";

let cachedWorkerUrl: string | null = null;

function getWorkerUrl(): string {
  if (cachedWorkerUrl) return cachedWorkerUrl;
  const workerFilePath = path.resolve(
    process.cwd(),
    "node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs",
  );
  cachedWorkerUrl = pathToFileURL(workerFilePath).href;
  return cachedWorkerUrl;
}

async function parsePdf(bytes: Uint8Array, mime: string, filename: string): Promise<ParsedDoc> {
  if (typeof globalThis.self === "undefined") {
    (globalThis as unknown as { self: typeof globalThis }).self = globalThis;
  }
  if (typeof globalThis.DOMMatrix === "undefined") {
    class DOMMatrixPolyfill {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true;
      isIdentity = true;
      constructor(init?: string | number[]) {
        if (Array.isArray(init) && init.length >= 6) {
          this.a = init[0]; this.b = init[1]; this.c = init[2];
          this.d = init[3]; this.e = init[4]; this.f = init[5];
          this.m11 = init[0]; this.m12 = init[1]; this.m21 = init[2];
          this.m22 = init[3]; this.m41 = init[4]; this.m42 = init[5];
        }
      }
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
      inverse() { return this; }
      transformPoint(pt?: unknown) { return pt || { x: 0, y: 0 }; }
    }
    (globalThis as unknown as { DOMMatrix: typeof DOMMatrixPolyfill }).DOMMatrix = DOMMatrixPolyfill as unknown as typeof DOMMatrix;
  }
  if (typeof globalThis.Path2D === "undefined") {
    (globalThis as unknown as { Path2D: unknown }).Path2D = class Path2D {};
  }
  if (typeof globalThis.ImageData === "undefined") {
    (globalThis as unknown as { ImageData: unknown }).ImageData = class ImageData {};
  }
  const { PDFParse } = await import("pdf-parse");
  try {
    PDFParse.setWorker(getWorkerUrl());
  } catch {
    // fallback if node_modules path is unavailable
  }
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
