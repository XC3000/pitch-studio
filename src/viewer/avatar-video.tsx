"use client";

/**
 * The rendered HeyGen presenter in the cutout slot (replaces AvatarPlaceholder
 * when a scene has a render).
 *
 * - `webm-alpha`: the browser composites the transparent video directly.
 * - `chroma`: green-screen mp4 keyed out in a WebGL fragment shader (spike S7
 *   path) — YCbCr chroma distance with a despill pass, so edges stay clean
 *   over the gradient stage.
 *
 * The beat clock stays the master: `targetTime` is where the video should be;
 * we reseek only when drift exceeds 0.4s so normal playback is never choppy.
 */

import { useEffect, useRef } from "react";
import type { DeckVideoKind } from "./types";

const SLOT_W = 640;
const SLOT_H = 640;
/** how far the video may run AHEAD of the beat before we pull it back */
const DRIFT_TOLERANCE = 0.4;
/** only skip the video forward to catch up on a big jump (replay/seek), never
 *  for ordinary start-up lag — that's what was clipping the opening words */
const HARD_RESYNC = 2.5;

export function AvatarVideo({
  src,
  kind,
  tilt,
  playing,
  loop = false,
  muted = false,
  volume = 1,
  speed = 1,
  targetTime = null,
  onAutoplayBlocked,
}: {
  src: string;
  kind: DeckVideoKind;
  tilt: number;
  playing: boolean;
  loop?: boolean;
  /** mute the audio track — used by the Scene Builder preview */
  muted?: boolean;
  /** presenter-voice volume 0–1 (viewer volume control) */
  volume?: number;
  /** playback rate (viewer speed control) — the beat clock scales to match */
  speed?: number;
  /** seconds into the video the beat clock expects; null = free-running (loops) */
  targetTime?: number | null;
  onAutoplayBlocked?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // play/pause follows the clock
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.play().catch((err: unknown) => {
        // Only a genuine autoplay policy block should send the viewer back to
        // the start gate. A pending play() interrupted by pause() (scene
        // change, deck end, doc panel) rejects with AbortError — that's benign
        // and must NOT reset `started`, or the deck bounces to the gate whenever
        // playback pauses.
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          onAutoplayBlocked?.();
        }
      });
    } else {
      video.pause();
    }
  }, [playing, src, onAutoplayBlocked]);

  // volume + playback rate follow the viewer controls
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.volume = Math.max(0, Math.min(1, volume));
  }, [volume, src]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
  }, [speed, src]);

  // drift correction against the beat clock. `drift > 0` = video ahead of the
  // beat; pull it back so captions stay aligned. `drift < 0` = video behind
  // (start-up lag) — do NOT seek forward for that, or we skip the opening words;
  // only hard-resync on a large jump (replay / manual seek).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || targetTime == null) return;
    const drift = video.currentTime - targetTime;
    if (drift > DRIFT_TOLERANCE || drift < -HARD_RESYNC) {
      video.currentTime = Math.max(0, targetTime);
    }
  }, [targetTime]);

  // chroma path: key the green render out in WebGL
  useEffect(() => {
    if (kind !== "chroma") return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const stop = startChromaKey(video, canvas);
    return stop;
  }, [kind, src]);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: "50%",
        marginLeft: -SLOT_W / 2,
        width: SLOT_W,
        height: SLOT_H,
        transformOrigin: "50% 100%",
        transform: `rotate(${tilt}deg)`,
        transition: "transform .9s cubic-bezier(.22,1,.36,1)",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: -6,
          transform: "translateX(-50%)",
          width: 520,
          height: 52,
          background: "radial-gradient(closest-side,rgba(30,58,138,.22),transparent)",
        }}
      />
      <video
        ref={videoRef}
        src={src}
        loop={loop}
        muted={muted}
        playsInline
        // CORS is only needed for the chroma path (WebGL reads the frame back,
        // which taints the canvas without it). webm-alpha just displays the
        // video, so requesting CORS there is not only unnecessary — it poisons
        // the shared cache against the CORS-less preload sibling (player.tsx),
        // and Chrome then serves an opaque cached response that renders blank.
        crossOrigin={kind === "chroma" ? "anonymous" : undefined}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "bottom",
          display: kind === "chroma" ? "none" : "block",
        }}
      />
      {kind === "chroma" && (
        <canvas
          ref={canvasRef}
          width={720}
          height={720}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            objectPosition: "bottom",
          }}
        />
      )}
    </div>
  );
}

// ── WebGL chroma key ────────────────────────────────────────────────────────

const VERT = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = vec2(pos.x * .5 + .5, .5 - pos.y * .5);
  gl_Position = vec4(pos, 0., 1.);
}`;

const FRAG = `
precision mediump float;
varying vec2 uv;
uniform sampler2D tex;

vec2 toCC(vec3 c) {
  return vec2(
    -0.169 * c.r - 0.331 * c.g + 0.5 * c.b,
     0.5   * c.r - 0.419 * c.g - 0.081 * c.b
  );
}

void main() {
  vec3 rgb = texture2D(tex, uv).rgb;
  vec3 key = vec3(0., 1., 0.);
  float d = distance(toCC(rgb), toCC(key));
  float alpha = smoothstep(0.11, 0.26, d);
  // despill: pull green down toward the other channels near the edge
  float spill = clamp(rgb.g - max(rgb.r, rgb.b), 0., 1.);
  rgb.g -= spill * (1. - alpha * alpha);
  gl_FragColor = vec4(rgb * alpha, alpha);
}`;

function startChromaKey(video: HTMLVideoElement, canvas: HTMLCanvasElement): () => void {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true });
  if (!gl) return () => {};

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let raf = 0;
  const draw = () => {
    if (video.readyState >= 2) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } catch {
        // tainted frame (missing CORS headers on the bucket) — stop keying
        cancelAnimationFrame(raf);
        return;
      }
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}
