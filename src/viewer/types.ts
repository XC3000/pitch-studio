/**
 * The deck spec the viewer player consumes. Assembled server-side from DB rows
 * (presentation + scenes + metric library + documents) in `src/lib/viewer-data.ts`
 * and passed to the client player as plain JSON.
 */

export type MetricFormat =
  | { style: "number"; suffix?: string; decimals?: number }
  | { style: "percent"; decimals?: number }
  | { style: "rating"; outOf?: number; decimals?: number }
  | { style: "duration"; prefix?: string; unit?: string }
  | { style: "literal"; text: string };

export type DeckMetric = {
  key: string;
  label: string;
  sublabel: string | null;
  value: number | null;
  format: MetricFormat;
};

export type DeckDoc = { id: string; name: string };

/** How the rendered avatar video should be composited into the cutout slot. */
export type DeckVideoKind = "webm-alpha" | "chroma";

export type DeckWordTiming = { word: string; start: number; end: number };

/** A top-center anchor on the 1440×810 stage — the element's horizontal center
 *  is `x`, its top edge is `y`, and `scale` (default 1) sizes it up/down. Used
 *  to freely place & size each placeable element per scene. */
export type ScenePos = { x: number; y: number; scale?: number };

/** An extra visual-template instance placed on a scene, beyond the primary one
 *  (from `scene.templateId`). Stored raw in `templateParams.layout.extraCues`. */
export type SceneCueRef = {
  id: string;
  templateId: string;
  params?: Record<string, unknown>;
  pos: ScenePos;
};

/** An image or video placed on a scene canvas (public MEDIA-bucket URL). `w` is
 *  the base display width on the 1440×810 stage (height keeps aspect); `pos.scale`
 *  multiplies it. */
export type SceneMedia = {
  id: string;
  kind: "image" | "video";
  url: string;
  w: number;
  pos: ScenePos;
};

export type SceneLayout = {
  /** primary visual template placement + scale */
  cue?: ScenePos;
  /** row anchor for metrics that have no individual override (+ scale-all) */
  metrics?: ScenePos;
  /** per-metric placement + scale, keyed by metric id (builder) */
  metricItems?: Record<string, ScenePos>;
  /** additional visual templates on this scene */
  extraCues?: SceneCueRef[];
  /** images & videos placed on this scene */
  media?: SceneMedia[];
};

/** Defaults that reproduce the original fixed layout. */
export const DEFAULT_CUE_POS: ScenePos = { x: 720, y: 132 };
export const DEFAULT_METRICS_POS: ScenePos = { x: 720, y: 346 };

/** Deterministic row position for a metric that hasn't been individually placed,
 *  so N metrics fan out centered on the metrics anchor (matches the old row). */
export function defaultMetricPos(index: number, count: number, anchor: ScenePos): ScenePos {
  const CARD = 200;
  const GAP = 18;
  const total = count * CARD + (count - 1) * GAP;
  const firstCenter = anchor.x - total / 2 + CARD / 2;
  return { x: firstCenter + index * (CARD + GAP), y: anchor.y, scale: anchor.scale };
}

export type DeckScene = {
  id: string;
  /** stable scene key — used for cue lookup, avatar tilt and canned-QA mapping */
  key: string;
  title: string;
  subtitle: string;
  script: string;
  /** seconds this beat runs before the next scene starts */
  duration: number;
  /** metric keys whose cards sit forward during this scene */
  focus: string[];
  /** built-in visual template key (pillars | journey | network-map | …) */
  cueTemplate: string;
  cueParams: Record<string, unknown>;
  /** generated-template DSL layout (M5); set when the scene's template is a
   *  generated org template — the DSL renderer draws it instead of a built-in. */
  cueSpec?: import("@/lib/template-dsl").LayoutNode | null;
  /** avatar lean, degrees */
  tilt: number;
  evidenceLabel: string;
  docs: DeckDoc[];
  /** rendered HeyGen video for this scene (M2); null → illustrated placeholder */
  videoUrl: string | null;
  videoKind: DeckVideoKind | null;
  /** word-level caption timings from the render; null → beat-proportional reveal */
  captions: DeckWordTiming[] | null;
  /** per-scene free placement of the visual template + metric row (top-center
   *  anchors on the 1440×810 stage); missing keys fall back to the defaults. */
  layout?: SceneLayout | null;
  /** additional visual templates (resolved to render-ready key/spec/params). */
  extraCues?: DeckExtraCue[];
  /** per-metric placement + scale, keyed by metric KEY (resolved from ids). */
  metricLayout?: Record<string, ScenePos>;
  /** images & videos placed on this scene */
  media?: SceneMedia[];
};

/** A resolved extra visual on a scene — ready for the player to render. */
export type DeckExtraCue = {
  id: string;
  cueTemplate: string;
  cueParams: Record<string, unknown>;
  cueSpec?: import("@/lib/template-dsl").LayoutNode | null;
  pos: ScenePos;
};

/** A source the live RAG answer was grounded in (from /api/qa). */
export type QaCitation = {
  chunkId: string;
  sourceName: string;
  sourceType: "document" | "fact";
  page?: number;
};

export type DeckBranding = {
  brandMark?: string;
  brandName?: string;
  tagline?: string;
  badges?: string[];
  logoUrl?: string | null;
};

export type DeckData = {
  presentationId: string;
  recipientName: string | null;
  branding: DeckBranding;
  /** presenter idle/attentive loop, shown while Q&A answers play (M2) */
  idleVideoUrl: string | null;
  idleVideoKind: DeckVideoKind | null;
  metrics: DeckMetric[];
  scenes: DeckScene[];
  suggestedQuestions: string[];
  fallbackAnswer: string;
  endingCaption: string;
  appendixHeadline: string;
  appendixIntro: string;
};
