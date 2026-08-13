/**
 * ElevenLabs streaming TTS — the presenter's cloned voice speaks Q&A answers.
 * REST via fetch; the response body is proxied straight to the viewer.
 * Degrades gracefully: no key or no voice → captions-only (caller returns 204).
 */

const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";
/** rough list price for turbo tier, USD per 1k characters */
const USD_PER_1K_CHARS = Number(process.env.ELEVENLABS_USD_PER_1K_CHARS ?? "0.05");

export function ttsConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

export function ttsCostUsd(text: string) {
  return (text.length / 1000) * USD_PER_1K_CHARS;
}

/** Start a streaming TTS render; returns the raw audio/mpeg stream. */
export async function ttsStream(voiceId: string, text: string): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=2`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.body;
}
