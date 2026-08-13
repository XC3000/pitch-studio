# ElevenLabs spoken Q&A answers — activation runbook

**Status:** the pipeline is fully built. Today Q&A answers are **captions-only** because
no `ELEVENLABS_API_KEY` is set. When the key lands, activation is config only — **no code
change required**. Everything below already exists in the repo.

## What's already wired

| Piece | Location | Behavior |
|---|---|---|
| TTS client | [src/lib/tts.ts](../src/lib/tts.ts) | `ttsStream(voiceId, text)` → ElevenLabs streaming REST; `ttsConfigured()` gates on the key; cost metered per 1k chars |
| Audio route | [src/app/api/qa/audio/route.ts](../src/app/api/qa/audio/route.ts) | `GET /api/qa/audio?exchange=…&link=…` → streams `audio/mpeg`. **204** = degrade (no key / no presenter voice / expired / replay). Speaks only the *stored* answer of a recent exchange for the link's org — never caller text |
| Voice resolution | `resolveQaContext()` in [src/lib/viewer-data.ts](../src/lib/viewer-data.ts) | Picks the link's presenter's `voices[lang].elevenVoiceId` |
| Player playback | `startAudio()` in [src/viewer/player.tsx](../src/viewer/player.tsx) | Fetches `/api/qa/audio` after each answer; respects the mute + volume + speed controls |
| Voice-id admin | "ElevenLabs voice ID (Q&A voice)" field, [presenters/presenter-manager.tsx](../src/app/o/[orgSlug]/presenters/presenter-manager.tsx) → `voices.{lang}.elevenVoiceId` | Per-presenter, per-language |
| Usage metering | `usageRecords(kind: "tts")` written by the audio route | quantity = characters, cost via `ttsCostUsd` |

## Activation steps (when the key is available)

1. **Set the key** in `.env.local`:
   ```
   ELEVENLABS_API_KEY=sk_...
   # optional: ELEVENLABS_MODEL=eleven_turbo_v2_5   (default)
   # optional: ELEVENLABS_USD_PER_1K_CHARS=0.05      (metering only)
   ```
   Restart `next dev` so the server picks up the env.

2. **Give the presenter a voice.** Admin → **Presenters** → edit the presenter used by the
   share link → **ElevenLabs voice ID (Q&A voice)** → paste the ElevenLabs voice id
   (from the ElevenLabs Voices dashboard, or clone the presenter's voice there first).
   This writes `voices.en.elevenVoiceId`. Each language needs its own voice id.

3. **Verify.** Open the share link (`/p/{slug}-en`), interrupt with a question. The answer
   should stream as captions **and** play in the presenter's voice. Confirm the network tab
   shows `/api/qa/audio` returning `200 audio/mpeg` (not `204`).

## Degrade matrix (all already handled — no crashes when unconfigured)

- No `ELEVENLABS_API_KEY` → route returns **204**, player shows captions only.
- Presenter has no `elevenVoiceId` for the link's language → **204**, captions only.
- Exchange older than 10 min, or replayed → **204** (anti-abuse; each answer voiced once).
- ElevenLabs API error → **204** (caught), captions only.

## Notes / gotchas

- The **Q&A "resuming" caption** ("Now, let's pick up right where we left off.") is a caption
  only by design — it is *not* sent to ElevenLabs.
- Voice is chosen by the link's **language** (`langOverride ?? defaultLang`), so a multi-lang
  presenter needs `elevenVoiceId` under each `voices.{lang}`.
- Cost is metered but **not quota-enforced** yet (billing is a later milestone).
