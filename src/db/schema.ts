import { createId } from "@paralleldrive/cuid2";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/** Embedding dimensions — Voyage voyage-3.5. Changing providers means a reindex. */
export const EMBEDDING_DIMS = 1024;

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => createId());

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ── Enums ──────────────────────────────────────────────────────────────────

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "editor"]);
export const documentStatus = pgEnum("document_status", [
  "uploaded",
  "parsing",
  "chunking",
  "embedding",
  "indexed",
  "failed",
  // store-only: shown as evidence, never chunked/embedded/searchable (ragEnabled=false)
  "stored",
]);
export const chunkSourceType = pgEnum("chunk_source_type", ["document", "fact"]);
export const presentationStatus = pgEnum("presentation_status", ["draft", "live", "archived"]);
export const sceneReadiness = pgEnum("scene_readiness", ["draft", "needs_review", "ready"]);
export const templateStatus = pgEnum("template_status", ["active", "retired"]);
export const templateSource = pgEnum("template_source", ["builtin", "generated"]);
export const proposalStatus = pgEnum("proposal_status", ["pending", "approved", "rejected"]);
export const shareLinkStatus = pgEnum("share_link_status", ["live", "draft", "revoked"]);
export const viewEventType = pgEnum("view_event_type", [
  "open",
  "scene_enter",
  "scene_complete",
  "evidence_open",
  "appendix_open",
  "question",
  "replay",
  "exit",
]);
export const renderJobStatus = pgEnum("render_job_status", [
  "queued",
  "rendering",
  "downloading",
  "done",
  "failed",
]);
export const usageKind = pgEnum("usage_kind", [
  "llm_generation",
  "qa",
  "embedding",
  "ocr",
  "render",
  "tts",
  "storage",
]);

// ── Tenancy ────────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: id(),
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  accentColor: text("accent_color"),
  qaFallbackText: text("qa_fallback_text")
    .notNull()
    .default(
      "That's the kind of question I'd take on a live call — let me connect you with our team.",
    ),
  settings: jsonb("settings").notNull().default({}),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email"),
    name: text("name"),
    role: membershipRole("role").notNull().default("editor"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_org_user_idx").on(t.orgId, t.clerkUserId),
    index("memberships_user_idx").on(t.clerkUserId),
  ],
);

export const presenters = pgTable(
  "presenters",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    headshotUrl: text("headshot_url"),
    heygenAvatarId: text("heygen_avatar_id"),
    supportsMatting: boolean("supports_matting").notNull().default(false),
    /** R2 key of the pre-rendered idle/attentive loop shown while Q&A answers play */
    idleVideoR2Key: text("idle_video_r2_key"),
    /** { [lang]: { heygenVoiceId, elevenVoiceId } } */
    voices: jsonb("voices").notNull().default({}),
    /** { speed?, pitch?, volume?, elevenlabs?: { stability?, similarityBoost?, style? } } — passed to HeyGen renders */
    voiceSettings: jsonb("voice_settings").notNull().default({}),
    ...timestamps,
  },
  (t) => [index("presenters_org_idx").on(t.orgId)],
);

// ── Knowledge base ─────────────────────────────────────────────────────────

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes").notNull().default(0),
    status: documentStatus("status").notNull().default("uploaded"),
    progressPct: integer("progress_pct").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    /** tiered-retrieval scope: null = org-wide (searchable from any presentation),
     *  else the presentation this doc belongs to (retrieval tier 2). Set null on
     *  delete so removing a presentation makes its docs org-wide, never destroys them. */
    presentationId: text("presentation_id").references(() => presentations.id, {
      onDelete: "set null",
    }),
    /** opt-in to RAG at upload; false = store-only (evidence, never chunked/embedded/searchable) */
    ragEnabled: boolean("rag_enabled").notNull().default(true),
    /** full extracted text (OCR or text-layer) — fed to deck generation, cached so
     *  RAG-ingest and the generation job don't re-extract the same file twice */
    extractedText: text("extracted_text"),
    error: text("error"),
    uploadedBy: text("uploaded_by"),
    ...timestamps,
  },
  (t) => [
    index("documents_org_idx").on(t.orgId),
    index("documents_presentation_idx").on(t.orgId, t.presentationId),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title"),
    body: text("body").notNull(),
    status: documentStatus("status").notNull().default("uploaded"),
    chunkCount: integer("chunk_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("facts_org_idx").on(t.orgId)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceType: chunkSourceType("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    embeddingModel: text("embedding_model"),
    /** { page?, heading? } */
    metadata: jsonb("metadata").notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("chunks_org_idx").on(t.orgId),
    index("chunks_source_idx").on(t.orgId, t.sourceType, t.sourceId),
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ── Metrics ────────────────────────────────────────────────────────────────

export const metricLibraryItems = pgTable(
  "metric_library_items",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    rawValue: numeric("raw_value"),
    /** { style: 'number'|'percent'|'duration'|'rating', suffix?, decimals?, unit? } */
    format: jsonb("format").notNull().default({ style: "number" }),
    sublabel: text("sublabel"),
    ...timestamps,
  },
  (t) => [uniqueIndex("metrics_org_key_idx").on(t.orgId, t.key)],
);

// ── Presentations & scenes ─────────────────────────────────────────────────

export const presentations = pgTable(
  "presentations",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: presentationStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    defaultLang: text("default_lang").notNull().default("en"),
    defaultPresenterId: text("default_presenter_id").references(() => presenters.id),
    baseDeckLabel: text("base_deck_label"),
    settings: jsonb("settings").notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("presentations_org_idx").on(t.orgId),
    uniqueIndex("presentations_org_slug_idx").on(t.orgId, t.slug),
  ],
);

export const visualTemplates = pgTable(
  "visual_templates",
  {
    id: id(),
    /** null = built-in library template available to every org */
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** { paramSchema, layout } — primitive DSL, rendered by a fixed component set */
    spec: jsonb("spec").notNull(),
    previewParams: jsonb("preview_params").notNull().default({}),
    status: templateStatus("status").notNull().default("active"),
    source: templateSource("source").notNull().default("builtin"),
    ...timestamps,
  },
  (t) => [index("visual_templates_org_idx").on(t.orgId)],
);

export const scenes = pgTable(
  "scenes",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    presentationId: text("presentation_id")
      .notNull()
      .references(() => presentations.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    intent: text("intent").notNull().default(""),
    templateId: text("template_id").references(() => visualTemplates.id),
    templateParams: jsonb("template_params").notNull().default({}),
    title: text("title"),
    subtitle: text("subtitle"),
    script: text("script"),
    scriptWordCount: integer("script_word_count").notNull().default(0),
    estSeconds: real("est_seconds").notNull().default(0),
    metricIds: jsonb("metric_ids").notNull().default([]),
    documentIds: jsonb("document_ids").notNull().default([]),
    readiness: sceneReadiness("readiness").notNull().default("draft"),
    /** { model?, costUsd?, promptHash?, edited? } */
    generationMeta: jsonb("generation_meta").notNull().default({}),
    ...timestamps,
  },
  (t) => [index("scenes_presentation_idx").on(t.presentationId, t.position)],
);

export const sceneVersions = pgTable(
  "scene_versions",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("scene_versions_idx").on(t.sceneId, t.version)],
);

export const templateProposals = pgTable(
  "template_proposals",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sceneId: text("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    proposedSpec: jsonb("proposed_spec").notNull(),
    reason: text("reason").notNull(),
    model: text("model"),
    status: proposalStatus("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("template_proposals_org_idx").on(t.orgId, t.status)],
);

// ── Share links & viewing ──────────────────────────────────────────────────

export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    presentationId: text("presentation_id")
      .notNull()
      .references(() => presentations.id, { onDelete: "cascade" }),
    /** globally unique short code; null on the per-language default link */
    code: text("code").unique(),
    isDefault: boolean("is_default").notNull().default(false),
    recipientName: text("recipient_name"),
    langOverride: text("lang_override"),
    presenterOverrideId: text("presenter_override_id").references(() => presenters.id),
    status: shareLinkStatus("status").notNull().default("draft"),
    passcodeHash: text("passcode_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("share_links_presentation_idx").on(t.presentationId)],
);

export const viewSessions = pgTable(
  "view_sessions",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    shareLinkId: text("share_link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    country: text("country"),
  },
  (t) => [index("view_sessions_link_idx").on(t.shareLinkId)],
);

export const viewEvents = pgTable(
  "view_events",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => viewSessions.id, { onDelete: "cascade" }),
    type: viewEventType("type").notNull(),
    sceneId: text("scene_id"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [index("view_events_session_idx").on(t.sessionId)],
);

export const qaExchanges = pgTable(
  "qa_exchanges",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => viewSessions.id, { onDelete: "set null" }),
    /** true when asked from the admin Knowledge test console */
    isTest: boolean("is_test").notNull().default(false),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    /** [{ chunkId, sourceName }] */
    citations: jsonb("citations").notNull().default([]),
    confidence: real("confidence"),
    hitFallback: boolean("hit_fallback").notNull().default(false),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd"),
    ...timestamps,
  },
  (t) => [index("qa_exchanges_org_idx").on(t.orgId, t.hitFallback)],
);

// ── Rendering & usage ──────────────────────────────────────────────────────

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    lang: text("lang").notNull(),
    presenterId: text("presenter_id")
      .notNull()
      .references(() => presenters.id),
    status: renderJobStatus("status").notNull().default("queued"),
    heygenVideoId: text("heygen_video_id"),
    r2Key: text("r2_key"),
    durationSec: real("duration_sec"),
    costUsd: numeric("cost_usd"),
    /** hash of (script, lang, presenter) — unchanged hash = skip re-render */
    scriptHash: text("script_hash").notNull(),
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    ...timestamps,
  },
  (t) => [index("render_jobs_scene_idx").on(t.sceneId, t.lang)],
);

export const sceneAudios = pgTable(
  "scene_audios",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    renderJobId: text("render_job_id")
      .notNull()
      .references(() => renderJobs.id, { onDelete: "cascade" }),
    /** [{ word, start, end }] — word-level timings for caption sync */
    captions: jsonb("captions").notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("scene_audios_job_idx").on(t.renderJobId)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: usageKind("kind").notNull(),
    quantity: numeric("quantity").notNull(),
    unit: text("unit").notNull(),
    costUsd: numeric("cost_usd").notNull().default("0"),
    /** id of the job/exchange/document this usage belongs to */
    ref: text("ref"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_records_org_idx").on(t.orgId, t.kind, t.recordedAt)],
);
