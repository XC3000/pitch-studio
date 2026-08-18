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



function safeDecodeUriComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    try {
      return decodeURIComponent(str.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
    } catch {
      return str;
    }
  }
}

async function parsePdf(bytes: Uint8Array, mime: string, filename: string): Promise<ParsedDoc> {
  const PDFParser = (await import("pdf2json")).default;

  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, true);

    pdfParser.on("pdfParser_dataError", (errData) => {
      const errMessage = typeof errData === "object" && errData && "parserError" in errData
        ? String(errData.parserError)
        : "PDF parsing failed";
      
      if (ocrConfigured()) {
        ocrFallback(bytes, mime, filename).then(resolve).catch(reject);
      } else {
        reject(new Error(errMessage));
      }
    });

    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      const blocks: { text: string; page?: number }[] = [];

      (pdfData.Pages ?? []).forEach((page, index) => {
        const pageText = (page.Texts ?? [])
          .map((t) => (t.R ?? []).map((r) => safeDecodeUriComponent(r.T)).join(" "))
          .join(" ")
          .trim();

        if (pageText) {
          blocks.push({ text: pageText, page: index + 1 });
        }
      });

      if (blocks.length > 0) {
        return resolve({ blocks });
      }

      if (ocrConfigured()) {
        ocrFallback(bytes, mime, filename).then(resolve).catch(reject);
      } else {
        reject(
          new Error(
            "PDF contained no extractable text (no text layer; set MISTRAL_API_KEY to OCR scanned PDFs)",
          ),
        );
      }
    });

    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pdfParser.parseBuffer(buffer);
  });
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
