/**
 * Heading-aware chunking: ~500-token chunks with ~15% overlap.
 * Token counts are estimated at ~4 chars/token — good enough for sizing
 * (retrieval quality, not billing, is the goal here).
 */

export type Chunk = {
  text: string;
  tokenCount: number;
  metadata: { heading?: string; page?: number };
};

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 75; // ~15%

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

/** Split parsed text (markdown-ish or plain) into overlapping chunks. */
export function chunkText(raw: string): Chunk[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  // Split into heading-scoped sections so a chunk never straddles headings.
  const sections: { heading?: string; body: string }[] = [];
  let current: { heading?: string; body: string } = { body: "" };
  for (const line of text.split("\n")) {
    const h = /^(#{1,4})\s+(.+)$/.exec(line.trim());
    if (h) {
      if (current.body.trim()) sections.push(current);
      current = { heading: h[2].trim(), body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.body.trim()) sections.push(current);
  if (sections.length === 0) sections.push({ body: text });

  const chunks: Chunk[] = [];
  for (const section of sections) {
    // Paragraph-first packing; long paragraphs fall back to sentence splits.
    const paragraphs = section.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => (estimateTokens(p) > TARGET_TOKENS ? splitLong(p) : [p]));

    let buf: string[] = [];
    let bufTokens = 0;
    const flush = () => {
      if (buf.length === 0) return;
      const body = buf.join("\n\n");
      chunks.push({
        text: section.heading ? `${section.heading}\n\n${body}` : body,
        tokenCount: estimateTokens(body),
        metadata: section.heading ? { heading: section.heading } : {},
      });
      // keep a trailing-overlap window for continuity
      let keep: string[] = [];
      let keepTokens = 0;
      for (let i = buf.length - 1; i >= 0 && keepTokens < OVERLAP_TOKENS; i--) {
        keep = [buf[i], ...keep];
        keepTokens += estimateTokens(buf[i]);
      }
      buf = keep.length < buf.length ? keep : [];
      bufTokens = buf.reduce((n, p) => n + estimateTokens(p), 0);
    };

    for (const p of paragraphs) {
      const t = estimateTokens(p);
      if (bufTokens + t > TARGET_TOKENS && buf.length > 0) flush();
      buf.push(p);
      bufTokens += t;
    }
    if (buf.length > 0 && bufTokens > OVERLAP_TOKENS / 2) flush();
    else if (buf.length > 0 && chunks.length === 0) flush(); // tiny sources still index
  }
  return chunks;
}

function splitLong(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (estimateTokens(buf) + estimateTokens(s) > TARGET_TOKENS && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += (buf ? " " : "") + s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
