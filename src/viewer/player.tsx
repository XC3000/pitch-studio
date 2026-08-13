"use client";

/**
 * The viewer player — a React port of the prototype's beat engine.
 *
 * A 100ms clock advances through the deck's scenes ("beats"). Each beat mounts
 * its cue illustration, brings its focus metric cards forward (count-up on
 * entry), reveals the script word-by-word against beat progress, and pulses
 * the evidence badge late in the beat. Opening the doc panel or appendix
 * pauses the clock; Q&A interrupts, reuses the matching scene's cue, then the
 * walkthrough resumes at the paused beat. In M2 the avatar placeholder is
 * replaced by the keyed HeyGen video in the same slot.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AvatarPlaceholder } from "./avatar";
import { AvatarVideo } from "./avatar-video";
import { CueStage } from "./cues";
import { formatMetric } from "./format";
import { Tracker } from "./tracker";
import { DEFAULT_CUE_POS, DEFAULT_METRICS_POS, defaultMetricPos } from "./types";
import type { DeckData, DeckDoc, DeckMetric, DeckScene, QaCitation } from "./types";
import "./viewer.css";

type Phase = "present" | "qa" | "idle";

/**
 * Live RAG Q&A state (M3). `status` walks thinking → streaming → speaking →
 * the clock exits after a short linger. `speakT` only advances while
 * speaking; `d` is the no-audio duration estimate. When TTS audio plays,
 * `audioProg` (0..1) drives the word reveal and `audio === "ended"` ends the
 * answer instead of the timer.
 */
type ActiveQa = {
  q: string;
  a: string;
  citations: QaCitation[];
  status: "thinking" | "streaming" | "speaking" | "resuming";
  audio: "none" | "pending" | "playing" | "ended";
  audioProg: number;
  speakT: number;
  lingerT: number;
  d: number;
};

type DocPanel = { label: string; docs: DeckDoc[] };

type PlayerState = {
  t: number;
  now: number;
  phase: Phase;
  qa: ActiveQa | null;
  qaT: number;
  listening: boolean;
  listenUntil: number;
  docPanel: DocPanel | null;
  appendix: boolean;
};

const TICK = 0.1;
const CAPTION_LINE_WORDS = 11;
/** how long the "let's pick up where we left off" line holds before the deck resumes */
const RESUME_HOLD = 2.0;
const RESUME_CAPTION = "Now, let's pick up right where we left off.";
/** viewer playback-speed steps, cycled by the speed button */
const SPEEDS = [0.75, 1, 1.25, 1.5];
/** half-width (video-seconds) of the cross-dissolve at each scene boundary —
 *  the scene fades out over this, swaps, then fades in over this (~1.2s total) */
const SCENE_XITION = 0.6;

/** The white metric card (label · count-up value · sublabel). Positioned by its
 *  wrapper; `frac` drives the count-up. Shared by every placed metric. */
function MetricCard({ m, frac }: { m: DeckMetric; frac: number }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid rgba(61,91,245,.5)",
        borderRadius: 16,
        padding: "20px 26px",
        minWidth: 180,
        textAlign: "center",
        boxShadow: "0 24px 56px -18px rgba(61,91,245,.3)",
      }}
    >
      <div style={{ font: "600 10px Inter", letterSpacing: "1.5px", color: "#3D5BF5" }}>{m.label}</div>
      <div
        style={{
          font: "700 42px/1.1 Inter",
          fontVariantNumeric: "tabular-nums",
          color: "#3D5BF5",
          marginTop: 6,
        }}
      >
        {formatMetric(m.format, m.value, frac)}
      </div>
      {m.sublabel && (
        <div style={{ font: "400 11px Inter", color: "#94A3B8", marginTop: 4 }}>{m.sublabel}</div>
      )}
    </div>
  );
}

export function Player({ deck, linkId }: { deck: DeckData; linkId: string }) {
  const [state, setState] = useState<PlayerState>({
    t: 0,
    now: 0,
    phase: "present",
    qa: null,
    qaT: 0,
    listening: false,
    listenUntil: 0,
    docPanel: null,
    appendix: false,
  });

  // Rendered scenes carry the presenter's voice — audio can't autoplay, so a
  // deck with videos waits for one tap before the clock starts.
  const hasVideo = deck.scenes.some((s) => s.videoUrl) || !!deck.idleVideoUrl;
  const [started, setStarted] = useState(!hasVideo);
  const onAutoplayBlocked = useCallback(() => setStarted(false), []);

  // viewer-controlled playback: pause freezes the beat clock + presenter video;
  // mute silences the presenter voice and any live Q&A answer audio.
  const [userPaused, setUserPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  // speed applies to both the presenter video and live Q&A audio; the beat clock
  // scales to match so captions/metrics track the sped-up/slowed presenter.
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const speedRef = useRef(1);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const beats = useMemo(() => {
    const out: { start: number; scene: DeckScene }[] = [];
    let start = 0;
    for (const scene of deck.scenes) {
      out.push({ start, scene });
      start += scene.duration;
    }
    return out;
  }, [deck.scenes]);
  const endT = beats.length ? beats[beats.length - 1].start + beats[beats.length - 1].scene.duration : 0;

  // A rendered scene to freeze as a still presenter during Q&A when the org has
  // no idle-loop render — better than the illustrated cartoon.
  const stillScene = useMemo(() => deck.scenes.find((s) => s.videoUrl) ?? null, [deck.scenes]);

  // ── tracking ──────────────────────────────────────────────────────────────
  const trackerRef = useRef<Tracker | null>(null);
  useEffect(() => {
    const tracker = new Tracker(linkId);
    trackerRef.current = tracker;
    tracker.start();
    tracker.track("open");
    return () => {
      tracker.flush(true);
      tracker.stop();
    };
  }, [linkId]);

  // ── the clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!started || userPaused) return;
    const iv = setInterval(() => {
      setState((s) => {
        if (s.docPanel || s.appendix) return s; // paused
        const ns = { ...s, now: s.now + TICK };
        if (s.listening && ns.now > s.listenUntil) ns.listening = false;
        if (s.phase === "qa" && s.qa) {
          ns.qaT = s.qaT + TICK;
          const qa = { ...s.qa };
          if (qa.status === "resuming") {
            // brief "picking up where we left off" beat, then unfreeze the deck
            qa.lingerT += TICK;
            ns.qa = qa;
            if (qa.lingerT > RESUME_HOLD) {
              ns.phase = s.t >= endT ? "idle" : "present";
              ns.qa = null;
              ns.qaT = 0;
            }
          } else {
            if (qa.status === "speaking" && qa.audio !== "ended") qa.speakT += TICK;
            const spoken =
              qa.status === "speaking" &&
              (qa.audio === "ended" ||
                (qa.audio === "none" && qa.speakT > qa.d) ||
                // audio never arrived / never finished buffering — don't hang
                (qa.audio === "pending" && qa.speakT > qa.d + 6));
            if (spoken) qa.lingerT += TICK;
            ns.qa = qa;
            if (qa.lingerT > 1.2) {
              // answer's done — show the resume line before continuing the scene
              qa.status = "resuming";
              qa.audio = "ended";
              qa.lingerT = 0;
              ns.qa = qa;
            }
          }
        } else if (s.phase === "present") {
          // advance in video-seconds: at 1.5× the presenter plays faster, so the
          // beat clock (and thus captions/count-ups/duration) must keep pace.
          ns.t = s.t + TICK * speedRef.current;
          if (ns.t >= endT) {
            ns.phase = "idle";
            ns.appendix = true;
          }
        }
        return ns;
      });
    }, 100);
    return () => clearInterval(iv);
  }, [endT, started, userPaused]);

  const { t, now, phase, qa, qaT, listening, docPanel, appendix } = state;

  const beat =
    phase === "present" ? (beats.find((b) => t >= b.start && t < b.start + b.scene.duration) ?? null) : null;
  // Live answers aren't tied to a scene — the idle avatar takes the stage.
  const cueScene: DeckScene | null = phase === "qa" ? null : (beat?.scene ?? null);
  const focus = phase === "qa" ? [] : (beat?.scene.focus ?? []);
  const sceneIndex = beat ? beats.indexOf(beat) : -1;
  // The scene we're paused on during Q&A — `t` is frozen while answering, so
  // this resolves the scene we left off on (regardless of phase) to freeze it.
  const pausedBeat = beats.find((b) => t >= b.start && t < b.start + b.scene.duration) ?? null;

  // Cross-dissolve between scenes: the scene-visual layer's opacity dips to 0
  // exactly at each boundary. React swaps the scene content at that dip, so the
  // outgoing scene fades out → swaps hidden → incoming fades in (through the
  // stage background). Skipped at the deck's very open and close.
  let sceneOpacity = 1;
  if (phase === "present" && beat) {
    const fromStart = t - beat.start;
    const toEnd = beat.start + beat.scene.duration - t;
    const atStart = fromStart <= toEnd;
    const skip = (atStart && sceneIndex === 0) || (!atStart && sceneIndex === beats.length - 1);
    if (!skip) sceneOpacity = Math.min(fromStart, toEnd) / SCENE_XITION;
    sceneOpacity = Math.max(0, Math.min(1, sceneOpacity));
  }

  // ── scene enter/complete events ───────────────────────────────────────────
  const lastIndexRef = useRef<number>(-1);
  // The scene the viewer was last watching — sent to /api/qa so a live question
  // searches that scene's attached documents first (retrieval tier 1). Survives
  // the switch to the Q&A phase (where sceneIndex goes -1).
  const watchedSceneIdRef = useRef<string | null>(null);
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (phase === "present" && sceneIndex >= 0 && sceneIndex !== lastIndexRef.current) {
      const last = lastIndexRef.current;
      if (last >= 0 && sceneIndex === last + 1) tracker.track("scene_complete", beats[last].scene.id);
      tracker.track("scene_enter", beats[sceneIndex].scene.id, { position: sceneIndex });
      lastIndexRef.current = sceneIndex;
      watchedSceneIdRef.current = beats[sceneIndex].scene.id;
    }
    if (phase === "idle" && lastIndexRef.current === beats.length - 1) {
      tracker.track("scene_complete", beats[beats.length - 1].scene.id);
      lastIndexRef.current = -1;
    }
  }, [phase, sceneIndex, beats]);

  // ── count-up age: when did the active cue last change? ────────────────────
  const activeKey = phase === "qa" ? `qa:${qa?.q ?? ""}` : (cueScene?.key ?? "idle");
  // render-phase derived-state adjustment (react.dev pattern for prior-render values)
  const [active, setActive] = useState({ key: "", at: -10 });
  if (active.key !== activeKey) setActive({ key: activeKey, at: now });
  const cueAge = now - active.at;

  const metricsByKey = useMemo(() => new Map(deck.metrics.map((m) => [m.key, m])), [deck.metrics]);

  // ── captions: word-timed from the render when available, else beat-proportional ──
  let caption = deck.endingCaption;
  let prog = 1;
  let speaking = false;
  let words: string[];
  let revealed: number;
  if (listening) {
    caption = "Listening… voice capture arrives later — tap a suggested question, or type below.";
  } else if (phase === "qa" && qa) {
    if (qa.status === "thinking") {
      caption = "One moment — let me check that…";
      prog = 0.01;
      speaking = true;
    } else if (qa.status === "streaming") {
      caption = qa.a;
      prog = 1; // reveal everything received so far; more arrives per delta
      speaking = true;
    } else if (qa.status === "resuming") {
      caption = RESUME_CAPTION;
      prog = 1;
      speaking = true;
    } else {
      caption = qa.a;
      prog =
        qa.audio === "playing" && qa.audioProg > 0
          ? qa.audioProg
          : qa.audio === "ended"
            ? 1
            : Math.min(1, qa.speakT / Math.max(0.1, qa.d * 0.85));
      speaking = qa.audio === "playing" || (qa.audio !== "ended" && qa.speakT < qa.d);
    }
  } else if (beat) {
    caption = beat.scene.script;
    prog = (t - beat.start) / (beat.scene.duration * 0.82);
    speaking = true;
  }
  const beatCaptions = !listening && phase === "present" ? (beat?.scene.captions ?? null) : null;
  if (beatCaptions && beatCaptions.length > 0 && beat) {
    const sceneT = t - beat.start;
    words = beatCaptions.map((c) => c.word);
    // count-up of words whose spoken start has passed (timings are sorted)
    let n = 0;
    while (n < beatCaptions.length && beatCaptions[n].start <= sceneT) n++;
    revealed = n;
    speaking = sceneT <= beatCaptions[beatCaptions.length - 1].end + 0.2;
  } else {
    words = caption.split(" ");
    revealed = Math.max(0, Math.min(words.length, Math.ceil(prog * words.length)));
  }
  const line = Math.min(
    Math.floor(Math.max(0, revealed - 1) / CAPTION_LINE_WORDS),
    Math.floor((words.length - 1) / CAPTION_LINE_WORDS),
  );
  const chunk = words.slice(line * CAPTION_LINE_WORDS, (line + 1) * CAPTION_LINE_WORDS);
  const doneCount = Math.max(0, Math.min(chunk.length, revealed - line * CAPTION_LINE_WORDS));
  const capDone = chunk.slice(0, doneCount).join(" ") + (doneCount > 0 ? " " : "");
  const capRest = chunk.slice(doneCount).join(" ");

  // ── evidence badge ────────────────────────────────────────────────────────
  const evScene = cueScene;
  const evDocs = evScene?.docs ?? [];
  const beatProg = beat ? (t - beat.start) / beat.scene.duration : qa ? qaT / qa.d : 0;
  const evVisible = evDocs.length > 0 && !docPanel && !appendix;
  const evPulsing = beatProg > 0.62 && !docPanel && !appendix;

  // ── live Q&A (M3): stream the RAG answer, then speak it via TTS ───────────
  const askIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // keep live Q&A answer audio in sync with the mute / volume / speed controls
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // patch the active answer only if this ask is still the live one
  const patchQa = useCallback((askId: number, patch: (qa: ActiveQa) => ActiveQa) => {
    if (askIdRef.current !== askId) return;
    setState((s) => (s.phase === "qa" && s.qa ? { ...s, qa: patch(s.qa) } : s));
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
    },
    [],
  );

  const speakDuration = (text: string) => 1.2 + text.split(/\s+/).filter(Boolean).length * 0.34;

  const startAudio = useCallback(
    (askId: number, exchangeId: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      patchQa(askId, (qa) => ({ ...qa, audio: "pending" }));
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.playbackRate = speed;
      audio.src = `/api/qa/audio?exchange=${encodeURIComponent(exchangeId)}&link=${encodeURIComponent(linkId)}`;
      audio.onplaying = () => patchQa(askId, (qa) => ({ ...qa, audio: "playing" }));
      audio.ontimeupdate = () => {
        const frac =
          Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
        patchQa(askId, (qa) => ({ ...qa, audioProg: frac }));
      };
      audio.onended = () => patchQa(askId, (qa) => ({ ...qa, audio: "ended", audioProg: 1 }));
      audio.onerror = () => patchQa(askId, (qa) => ({ ...qa, audio: "none" })); // captions-only degrade
      audio.play().catch(() => patchQa(askId, (qa) => ({ ...qa, audio: "none" })));
    },
    [linkId, patchQa, volume, speed],
  );

  const ask = (question: string) => {
    const askId = ++askIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    audioRef.current?.pause();

    trackerRef.current?.track("question", null, { question });
    setState((s) => ({
      ...s,
      phase: "qa",
      qa: {
        q: question,
        a: "",
        citations: [],
        status: "thinking",
        audio: "none",
        audioProg: 0,
        speakT: 0,
        lingerT: 0,
        d: 3,
      },
      qaT: 0,
      listening: false,
    }));

    const fail = () =>
      patchQa(askId, (qa) => ({
        ...qa,
        a: qa.a || deck.fallbackAnswer,
        status: "speaking",
        d: speakDuration(qa.a || deck.fallbackAnswer),
      }));

    void (async () => {
      try {
        const res = await fetch("/api/qa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            linkId,
            sessionId: trackerRef.current?.getSessionId() ?? undefined,
            question,
            sceneId: watchedSceneIdRef.current ?? undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          fail();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // parse complete SSE frames: "event: x\ndata: {…}\n\n"
          for (;;) {
            const sep = buffer.indexOf("\n\n");
            if (sep === -1) break;
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const eventMatch = /^event: (.+)$/m.exec(frame);
            const dataMatch = /^data: (.+)$/m.exec(frame);
            if (!eventMatch || !dataMatch) continue;
            const event = eventMatch[1];
            const data = JSON.parse(dataMatch[1]) as Record<string, unknown>;
            if (event === "citations") {
              patchQa(askId, (qa) => ({ ...qa, citations: data as unknown as QaCitation[] }));
            } else if (event === "delta") {
              const text = String(data.t ?? "");
              patchQa(askId, (qa) => {
                const a = qa.a + text;
                return { ...qa, a, status: "streaming", d: speakDuration(a) };
              });
            } else if (event === "done") {
              const answer = String(data.answer ?? "");
              patchQa(askId, (qa) => ({
                ...qa,
                a: answer || qa.a,
                status: "speaking",
                speakT: 0,
                d: speakDuration(answer || qa.a),
              }));
              if (data.voice && typeof data.exchangeId === "string") {
                startAudio(askId, data.exchangeId);
              }
            } else if (event === "error") {
              fail();
            }
          }
        }
        // stream closed without a done frame — make sure we exit cleanly
        patchQa(askId, (qa) => (qa.status === "speaking" ? qa : { ...qa, status: "speaking", d: speakDuration(qa.a || deck.fallbackAnswer), a: qa.a || deck.fallbackAnswer }));
      } catch {
        if (!controller.signal.aborted) fail();
      }
    })();
  };

  const openDocs = () => {
    if (!evScene) return;
    trackerRef.current?.track("evidence_open", evScene.id);
    setState((s) => ({ ...s, docPanel: { label: evScene.evidenceLabel, docs: evScene.docs } }));
  };

  const replay = () => {
    trackerRef.current?.track("replay");
    lastIndexRef.current = -1;
    setState((s) => ({
      ...s,
      t: 0,
      phase: "present",
      qa: null,
      qaT: 0,
      listening: false,
      docPanel: null,
      appendix: false,
    }));
  };

  const appendixGroups = deck.scenes
    .filter((s) => s.docs.length > 0)
    .map((s) => ({ label: s.evidenceLabel, docs: s.docs }));

  const stageScale = "min(100vw / 1440, 100vh / 810)" as const;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: "#E9F1FA",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#334155",
      }}
    >
      <div style={{ flex: "none", width: 1440, height: 810, transform: `scale(${stageScale})`, transformOrigin: "center" }}>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            background: "linear-gradient(180deg,#F8FBFF 0%,#EFF5FC 60%,#E9F1FA 100%)",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "radial-gradient(1100px 640px at 50% 118%,rgba(61,91,245,.10),transparent 62%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "radial-gradient(circle,rgba(61,91,245,.10) 1px,transparent 1.4px)",
              backgroundSize: "30px 30px",
              opacity: 0.5,
            }}
          />

          {/* header: brand + prepared-for + badges */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "22px 48px",
              zIndex: 5,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                {deck.branding.brandMark && (
                  <div style={{ font: "italic 800 18px Georgia,serif", color: "#E24545" }}>
                    {deck.branding.brandMark}
                  </div>
                )}
                <div style={{ font: "700 15px Inter", color: "#1E293B", letterSpacing: 3 }}>
                  {deck.branding.brandName}
                </div>
              </div>
              {deck.branding.tagline && (
                <div style={{ font: "600 8.5px Inter", letterSpacing: "2.6px", color: "#E24545", marginTop: 4 }}>
                  {deck.branding.tagline}
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {deck.recipientName && (
                <div style={{ font: "400 12px Inter", color: "#64748B" }}>
                  Prepared for <span style={{ color: "#1E293B", fontWeight: 600 }}>{deck.recipientName}</span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                {(deck.branding.badges ?? []).map((b) => (
                  <div
                    key={b}
                    style={{
                      font: "600 9px Inter",
                      letterSpacing: "1.2px",
                      color: "#64748B",
                      border: "1px solid #DBE4F0",
                      background: "#fff",
                      borderRadius: 999,
                      padding: "5px 10px",
                    }}
                  >
                    {b}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* scene-visual layer — one wrapper so the cross-dissolve fades the
              whole scene (title · cue · metrics · presenter) out and in as one */}
          <div style={{ opacity: sceneOpacity, transition: "opacity .12s linear" }}>

          {/* scene title */}
          <div
            style={{
              position: "absolute",
              top: 64,
              left: "50%",
              transform: "translateX(-50%)",
              textAlign: "center",
              opacity: cueScene && !appendix ? 1 : 0,
              transition: "opacity .5s",
              zIndex: 5,
              width: 760,
            }}
          >
            <div style={{ font: "700 22px Inter", color: "#1E293B", letterSpacing: "-.2px" }}>
              {cueScene?.title ?? ""}
            </div>
            <div style={{ marginTop: 5, font: "500 13px Inter", color: "#64748B" }}>
              {cueScene?.subtitle ?? ""}
            </div>
          </div>

          {/* cue stage — freely placed & sized per scene (top-center anchor) */}
          <div
            style={{
              position: "absolute",
              top: cueScene?.layout?.cue?.y ?? DEFAULT_CUE_POS.y,
              left: cueScene?.layout?.cue?.x ?? DEFAULT_CUE_POS.x,
              transform: `translateX(-50%) scale(${cueScene?.layout?.cue?.scale ?? 1})`,
              transformOrigin: "top center",
              height: 196,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 3,
            }}
          >
            {cueScene && (
              <CueStage
                key={cueScene.key}
                template={cueScene.cueTemplate}
                params={cueScene.cueParams}
                spec={cueScene.cueSpec}
              />
            )}
          </div>

          {/* additional visual templates */}
          {cueScene?.extraCues?.map((ec) => (
            <div
              key={ec.id}
              style={{
                position: "absolute",
                top: ec.pos.y,
                left: ec.pos.x,
                transform: `translateX(-50%) scale(${ec.pos.scale ?? 1})`,
                transformOrigin: "top center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 3,
              }}
            >
              <CueStage template={ec.cueTemplate} params={ec.cueParams} spec={ec.cueSpec} />
            </div>
          ))}

          {/* images & videos placed on the scene */}
          {cueScene?.media?.map((md) => (
            <div
              key={md.id}
              style={{
                position: "absolute",
                top: md.pos.y,
                left: md.pos.x,
                width: md.w,
                transform: `translateX(-50%) scale(${md.pos.scale ?? 1})`,
                transformOrigin: "top center",
                zIndex: 2,
              }}
            >
              {md.kind === "video" ? (
                <video
                  src={md.url}
                  style={{ width: "100%", height: "auto", borderRadius: 14, display: "block" }}
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={md.url}
                  alt=""
                  style={{ width: "100%", height: "auto", borderRadius: 14, display: "block" }}
                />
              )}
            </div>
          ))}

          {/* focus metric cards — each freely placed & sized per scene */}
          {focus.map((key, i) => {
            const m = metricsByKey.get(key);
            if (!m) return null;
            const counting = m.format.style !== "literal" && cueAge < 1.25;
            const frac = counting ? 1 - Math.pow(1 - Math.min(1, cueAge / 1.2), 3) : 1;
            const anchor = cueScene?.layout?.metrics ?? DEFAULT_METRICS_POS;
            const pos = cueScene?.metricLayout?.[key] ?? defaultMetricPos(i, focus.length, anchor);
            return (
              <div
                key={`${activeKey}:${key}`}
                style={{
                  position: "absolute",
                  top: pos.y,
                  left: pos.x,
                  transform: `translateX(-50%) scale(${pos.scale ?? 1})`,
                  transformOrigin: "top center",
                  zIndex: 3,
                  animation: `cardin .55s cubic-bezier(.22,1,.36,1) ${i * 0.1}s both`,
                }}
              >
                <MetricCard m={m} frac={frac} />
              </div>
            );
          })}

          {/* presenter cutout — the keyed HeyGen render, idle loop during Q&A,
              illustrated placeholder when a scene has no render yet */}
          {(() => {
            const paused = !!docPanel || appendix || !started || userPaused;
            const tilt = phase === "qa" ? 0 : (cueScene?.tilt ?? 0);
            // Q&A: freeze the current scene's real presenter exactly where we
            // left off, so the answer plays as a caption over the paused
            // presenter and the deck resumes seamlessly. Same key as the present
            // path → the video element is reused and simply pauses (no reload).
            if (phase === "qa" && pausedBeat?.scene.videoUrl) {
              return (
                <AvatarVideo
                  key={pausedBeat.scene.id}
                  src={pausedBeat.scene.videoUrl}
                  kind={pausedBeat.scene.videoKind ?? "chroma"}
                  tilt={0}
                  playing={false}
                  targetTime={t - pausedBeat.start}
                  muted={muted}
                />
              );
            }
            const inQa = phase === "qa" || phase === "idle" || listening;
            if (inQa && deck.idleVideoUrl) {
              return (
                <AvatarVideo
                  src={deck.idleVideoUrl}
                  kind={deck.idleVideoKind ?? "chroma"}
                  tilt={0}
                  playing={!paused}
                  loop
                  muted={muted}
                  volume={volume}
                  speed={speed}
                  onAutoplayBlocked={onAutoplayBlocked}
                />
              );
            }
            const videoScene = phase === "present" ? beat?.scene : cueScene;
            if (videoScene?.videoUrl) {
              return (
                <AvatarVideo
                  key={videoScene.id}
                  src={videoScene.videoUrl}
                  kind={videoScene.videoKind ?? "chroma"}
                  tilt={tilt}
                  playing={phase === "present" && !paused}
                  targetTime={phase === "present" && beat ? t - beat.start : null}
                  muted={muted}
                  volume={volume}
                  speed={speed}
                  onAutoplayBlocked={onAutoplayBlocked}
                />
              );
            }
            // No live scene video for this phase. During Q&A / idle, freeze the
            // real presenter on a still frame rather than dropping to the cartoon.
            if ((phase === "qa" || phase === "idle") && stillScene?.videoUrl) {
              return (
                <AvatarVideo
                  key={`still:${stillScene.id}`}
                  src={stillScene.videoUrl}
                  kind={stillScene.videoKind ?? "chroma"}
                  tilt={0}
                  playing={false}
                  targetTime={0}
                  muted
                />
              );
            }
            return <AvatarPlaceholder speaking={speaking && started} tilt={tilt} />;
          })()}

          </div>
          {/* end scene-visual layer */}

          {/* preload the next scene's render while the current one plays —
              crossOrigin MUST match how AvatarVideo will request it (chroma =
              CORS, webm-alpha = none), or the cached response is opaque to the
              player and the scene renders blank. */}
          {phase === "present" && sceneIndex >= 0 && beats[sceneIndex + 1]?.scene.videoUrl && (
            <video
              src={beats[sceneIndex + 1].scene.videoUrl!}
              preload="auto"
              muted
              crossOrigin={beats[sceneIndex + 1].scene.videoKind === "chroma" ? "anonymous" : undefined}
              style={{ display: "none" }}
            />
          )}

          {/* TTS audio for live answers (idle loop is visual-only) */}
          <audio ref={audioRef} style={{ display: "none" }} />

          {/* Q&A question bubble */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 166,
              transform: "translateX(-50%)",
              opacity: phase === "qa" && qa ? 1 : 0,
              transition: "opacity .5s",
              font: "500 12px Inter",
              color: "#fff",
              background: "#3D5BF5",
              borderRadius: 999,
              padding: "7px 14px",
              maxWidth: 640,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              boxShadow: "0 10px 26px -10px rgba(61,91,245,.55)",
              zIndex: 6,
            }}
          >
            {qa ? `You · “${qa.q}”` : ""}
          </div>

          {/* citation chips — the sources grounding the live answer */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 78,
              transform: "translateX(-50%)",
              display: "flex",
              gap: 8,
              opacity: phase === "qa" && (qa?.citations.length ?? 0) > 0 ? 1 : 0,
              transition: "opacity .5s",
              zIndex: 6,
              pointerEvents: "none",
            }}
          >
            {[...new Map((qa?.citations ?? []).map((c) => [c.sourceName, c])).values()]
              .slice(0, 3)
              .map((c) => (
                <span
                  key={c.chunkId}
                  style={{
                    font: "600 10px Inter",
                    color: "#64748B",
                    background: "rgba(255,255,255,.85)",
                    border: "1px solid rgba(226,232,240,.9)",
                    borderRadius: 999,
                    padding: "4px 10px",
                    backdropFilter: "blur(8px)",
                  }}
                >
                  📄 {c.sourceName}
                  {c.page ? ` · p.${c.page}` : ""}
                </span>
              ))}
          </div>

          {/* captions */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 108,
              transform: "translateX(-50%)",
              textAlign: "center",
              transition: "opacity .4s",
              zIndex: 6,
              whiteSpace: "nowrap",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "rgba(255,255,255,.3)",
                border: "1px solid rgba(226,232,240,.35)",
                borderRadius: 999,
                padding: "10px 20px",
                backdropFilter: "blur(10px)",
                boxShadow: "0 14px 38px -16px rgba(30,58,138,.25)",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "flex-end",
                  gap: 3,
                  height: 11,
                  marginRight: 9,
                  opacity: speaking ? 1 : 0,
                  transition: "opacity .4s",
                }}
              >
                {[0, 0.22, 0.44].map((d) => (
                  <span
                    key={d}
                    style={{
                      display: "block",
                      width: 3,
                      height: 11,
                      borderRadius: 2,
                      background: "#3D5BF5",
                      transformOrigin: "bottom",
                      animation: "eq .8s ease-in-out infinite",
                      animationDelay: `${d}s`,
                    }}
                  />
                ))}
              </span>
              <span style={{ font: "500 14px/1.4 Inter", color: "#1E293B" }}>{capDone}</span>
              <span style={{ font: "500 14px/1.4 Inter", color: "#AEBACB" }}>{capRest}</span>
            </div>
          </div>

          {/* suggested questions */}
          <div style={{ position: "absolute", left: 44, bottom: 40, display: "flex", gap: 10, zIndex: 7 }}>
            {deck.suggestedQuestions.map((q) => (
              <button key={q} className="viewer-ask-chip" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>

          {/* playback controls — pause the walkthrough / mute the presenter */}
          {hasVideo && started && (
            <div
              style={{
                position: "absolute",
                left: 44,
                bottom: 36,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(255,255,255,.92)",
                border: "1px solid #DCE5F2",
                borderRadius: 999,
                padding: 7,
                backdropFilter: "blur(14px)",
                boxShadow: "0 22px 50px -18px rgba(30,58,138,.30)",
                zIndex: 7,
              }}
            >
              <PlaybackButton
                onClick={() => setUserPaused((p) => !p)}
                label={userPaused ? "Play" : "Pause"}
              >
                {userPaused ? <PlayIcon /> : <PauseIcon />}
              </PlaybackButton>
              <PlaybackButton
                onClick={() =>
                  setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1)
                }
                label={`Speed ${speed}×`}
              >
                <span style={{ font: "700 12px Inter", letterSpacing: "-.3px" }}>{speed}×</span>
              </PlaybackButton>
              <PlaybackButton onClick={() => setMuted((m) => !m)} label={muted ? "Unmute" : "Mute"}>
                {muted ? <MutedIcon /> : <SoundIcon />}
              </PlaybackButton>
              <div
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 0 4px" }}
                title={`Volume ${Math.round(volume * 100)}%`}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  aria-label="Volume"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    if (v > 0 && muted) setMuted(false);
                  }}
                  style={{ width: 74, accentColor: "#3D5BF5", cursor: "pointer" }}
                />
              </div>
            </div>
          )}

          {/* ask bar */}
          <AskBar
            listening={listening}
            isIdle={phase === "idle"}
            onAsk={ask}
            onMic={() =>
              setState((s) => ({ ...s, listening: !s.listening, listenUntil: s.now + 4.5 }))
            }
            onReplay={replay}
          />

          {/* evidence badge */}
          <div
            onClick={openDocs}
            style={{
              position: "absolute",
              right: 32,
              top: 68,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: evVisible ? 1 : 0,
              pointerEvents: evVisible ? "auto" : "none",
              transition: "opacity .5s",
              cursor: "pointer",
              background: "#fff",
              border: "1px solid rgba(61,91,245,.35)",
              borderRadius: 999,
              padding: "7px 14px 7px 12px",
              boxShadow: "0 10px 26px -12px rgba(30,58,138,.3)",
              animation: evPulsing ? "evbadge 1.4s ease-in-out infinite" : "none",
              zIndex: 10,
            }}
          >
            <span style={{ fontSize: 13 }}>📄</span>
            <span style={{ font: "600 11px Inter", color: "#3D5BF5" }}>
              {evDocs.length === 1 ? "1 document" : `${evDocs.length} documents`} — backed by evidence
            </span>
            <span
              style={{
                font: "600 10px Inter",
                color: "#94A3B8",
                borderLeft: "1px solid #E2E8F0",
                paddingLeft: 8,
              }}
            >
              View
            </span>
          </div>

          {/* doc panel scrim + slide-out */}
          {docPanel && (
            <div
              onClick={() => setState((s) => ({ ...s, docPanel: null }))}
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(15,23,42,.28)",
                backdropFilter: "blur(2px)",
                zIndex: 14,
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 400,
              background: "#fff",
              boxShadow: "-30px 0 70px -30px rgba(15,23,42,.4)",
              transform: `translateX(${docPanel ? "0" : "104%"})`,
              transition: "transform .5s cubic-bezier(.22,1,.36,1)",
              zIndex: 15,
              padding: "32px 30px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div>
                <div style={{ font: "600 9px Inter", letterSpacing: 2, color: "#3D5BF5" }}>
                  SUPPORTING DOCUMENTS
                </div>
                <div style={{ font: "700 20px Inter", color: "#1E293B", marginTop: 6 }}>
                  {docPanel?.label ?? ""}
                </div>
              </div>
              <button
                onClick={() => setState((s) => ({ ...s, docPanel: null }))}
                style={{
                  flex: "none",
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  border: "1px solid #E2E8F0",
                  background: "#F8FAFC",
                  color: "#64748B",
                  cursor: "pointer",
                  font: "400 16px Inter",
                }}
              >
                ×
              </button>
            </div>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
              {(docPanel?.docs ?? []).map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 16px",
                    border: "1px solid #E8EEF7",
                    borderRadius: 12,
                    background: "#FBFCFE",
                  }}
                >
                  <div
                    style={{
                      flex: "none",
                      width: 36,
                      height: 44,
                      borderRadius: 5,
                      background: "linear-gradient(160deg,#EEF3FF,#DCE6FF)",
                      border: "1px solid rgba(61,91,245,.25)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                    }}
                  >
                    📄
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        font: "600 13px Inter",
                        color: "#1E293B",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.name}
                    </div>
                    <div style={{ font: "500 11px Inter", color: "#94A3B8", marginTop: 2 }}>
                      Provided for your review
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: "auto",
                font: "400 11px/1.6 Inter",
                color: "#94A3B8",
                borderTop: "1px solid #EEF2F7",
                paddingTop: 16,
              }}
            >
              The full supporting documents are provided separately with this review. Every figure is
              fully auditable.
            </div>
          </div>

          {/* evidence appendix */}
          {appendix && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(180deg,#F8FBFF,#E9F1FA)",
                zIndex: 18,
                padding: "56px 64px",
                overflow: "auto",
                boxSizing: "border-box",
              }}
            >
              <div style={{ maxWidth: 1100, margin: "0 auto" }}>
                <div style={{ font: "600 10px Inter", letterSpacing: 3, color: "#3D5BF5" }}>
                  EVIDENCE APPENDIX
                </div>
                <div style={{ font: "700 34px/1.25 Inter", color: "#1E293B", marginTop: 12, maxWidth: 760 }}>
                  {deck.appendixHeadline}
                </div>
                <div style={{ font: "400 14px/1.6 Inter", color: "#64748B", marginTop: 12, maxWidth: 680 }}>
                  {deck.appendixIntro}
                </div>
                <div
                  style={{
                    marginTop: 36,
                    display: "grid",
                    gridTemplateColumns: "repeat(3,1fr)",
                    gap: 18,
                  }}
                >
                  {appendixGroups.map((g) => (
                    <div
                      key={g.label}
                      style={{
                        background: "#fff",
                        border: "1px solid #E2E8F0",
                        borderRadius: 14,
                        padding: 20,
                        boxShadow: "0 20px 50px -30px rgba(30,58,138,.25)",
                      }}
                    >
                      <div style={{ font: "600 9px Inter", letterSpacing: "1.6px", color: "#3D5BF5" }}>
                        {g.label.toUpperCase()}
                      </div>
                      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                        {g.docs.map((d) => (
                          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            <span style={{ fontSize: 13 }}>📄</span>
                            <span style={{ font: "500 12px Inter", color: "#334155" }}>{d.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 36, display: "flex", gap: 12 }}>
                  <button
                    onClick={() => setState((s) => ({ ...s, appendix: false }))}
                    style={{
                      font: "600 12px Inter",
                      color: "#fff",
                      background: "#3D5BF5",
                      border: "none",
                      borderRadius: 999,
                      padding: "12px 26px",
                      cursor: "pointer",
                      boxShadow: "0 14px 30px -12px rgba(61,91,245,.6)",
                    }}
                  >
                    Back to dashboard
                  </button>
                  <button
                    onClick={replay}
                    style={{
                      font: "600 12px Inter",
                      letterSpacing: 1,
                      color: "#3D5BF5",
                      background: "#fff",
                      border: "1px solid rgba(61,91,245,.35)",
                      borderRadius: 999,
                      padding: "12px 26px",
                      cursor: "pointer",
                    }}
                  >
                    REPLAY WALKTHROUGH
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* start gate — one tap unlocks the presenter's audio */}
          {!started && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 18,
                background: "rgba(233,241,250,.72)",
                backdropFilter: "blur(6px)",
                zIndex: 30,
              }}
            >
              <div style={{ font: "700 26px Inter", color: "#1E293B", letterSpacing: "-.3px" }}>
                {deck.branding.brandName ?? "Your walkthrough is ready"}
              </div>
              <div style={{ font: "400 14px Inter", color: "#64748B" }}>
                {deck.recipientName ? `Prepared for ${deck.recipientName} — ` : ""}
                the presenter speaks, so press play to begin.
              </div>
              <button
                onClick={() => setStarted(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  font: "600 15px Inter",
                  color: "#fff",
                  background: "linear-gradient(140deg,#4C6FFF,#3D5BF5)",
                  border: "none",
                  borderRadius: 999,
                  padding: "16px 34px",
                  cursor: "pointer",
                  boxShadow: "0 20px 44px -14px rgba(61,91,245,.65)",
                }}
              >
                <span style={{ fontSize: 13 }}>▶</span> Start the walkthrough
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaybackButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        flex: "none",
        width: 40,
        height: 40,
        borderRadius: "50%",
        border: "1px solid #DCE5F2",
        background: "#fff",
        color: "#3D5BF5",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
    </svg>
  );
}

function SoundIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}

function AskBar({
  listening,
  isIdle,
  onAsk,
  onMic,
  onReplay,
}: {
  listening: boolean;
  isIdle: boolean;
  onAsk: (q: string) => void;
  onMic: () => void;
  onReplay: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        right: 44,
        bottom: 36,
        width: 430,
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(255,255,255,.92)",
        border: "1px solid #DCE5F2",
        borderRadius: 999,
        padding: "9px 16px 9px 9px",
        backdropFilter: "blur(14px)",
        boxShadow: "0 22px 50px -18px rgba(30,58,138,.30)",
        zIndex: 7,
      }}
    >
      <button
        onClick={onMic}
        aria-label="Speak to the presenter"
        style={{
          position: "relative",
          flex: "none",
          width: 46,
          height: 46,
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          background: "linear-gradient(140deg,#4C6FFF,#3D5BF5)",
          boxShadow: listening
            ? "0 0 0 8px rgba(61,91,245,.15), 0 0 0 1px rgba(61,91,245,.85)"
            : "0 10px 24px -8px rgba(61,91,245,.55)",
          transition: "box-shadow .4s",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "1px solid rgba(61,91,245,.7)",
            animation: "micpulse 1.6s ease-out infinite",
            opacity: listening ? 1 : 0,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 11, height: 16, borderRadius: 6, background: "#fff" }} />
          <div
            style={{
              width: 19,
              height: 9,
              border: "2px solid #fff",
              borderTop: "none",
              borderRadius: "0 0 10px 10px",
              marginTop: -6,
            }}
          />
          <div style={{ width: 2, height: 4, background: "#fff" }} />
        </div>
      </button>
      <input
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = e.currentTarget.value.trim();
            if (v) {
              e.currentTarget.value = "";
              onAsk(v);
            }
          }
        }}
        placeholder="Interrupt me — ask anything…"
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "#1E293B",
          font: "400 13.5px Inter",
        }}
      />
      {isIdle && (
        <button
          onClick={onReplay}
          style={{
            flex: "none",
            font: "600 10.5px Inter",
            letterSpacing: "1.4px",
            color: "#3D5BF5",
            background: "#EEF3FF",
            border: "1px solid rgba(61,91,245,.35)",
            borderRadius: 999,
            padding: "9px 14px",
            cursor: "pointer",
          }}
        >
          REPLAY
        </button>
      )}
    </div>
  );
}
