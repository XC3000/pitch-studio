/**
 * Word-level caption timings for a rendered scene (spike S3).
 *
 * Preferred source: HeyGen's caption asset (WebVTT) — cue-level timings that
 * we spread across each cue's words. Fallback: distribute the script's words
 * proportionally (by character weight) over the video duration, which matches
 * the prototype's beat-proportional reveal closely enough to ship.
 */

export type WordTiming = { word: string; start: number; end: number };

/** `00:01:02.345` | `01:02.345` → seconds */
function vttTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function spreadWords(text: string, start: number, end: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTiming[] = [];
  let t = start;
  for (let i = 0; i < words.length; i++) {
    const d = ((end - start) * weights[i]) / total;
    out.push({ word: words[i], start: t, end: t + d });
    t += d;
  }
  return out;
}

/** Parse a WebVTT caption asset into word timings (cue text spread per cue). */
export function parseVttToWords(vtt: string): WordTiming[] {
  const out: WordTiming[] = [];
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx === -1) continue;
    const [rawStart, rawEnd] = lines[timeLineIdx].split("-->");
    const start = vttTime(rawStart);
    const end = vttTime(rawEnd.split(" ")[1] ?? rawEnd);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    const text = lines
      .slice(timeLineIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) out.push(...spreadWords(text, start, end));
  }
  return out;
}

/** Fallback: no caption asset — estimate timings from the script + duration. */
export function estimateWordTimings(script: string, durationSec: number): WordTiming[] {
  // Leave a little lead-in/out silence, as renders usually have some.
  const lead = Math.min(0.4, durationSec * 0.04);
  return spreadWords(script, lead, Math.max(lead + 0.5, durationSec - lead));
}
