# Pitch Studio

Multi-tenant SaaS that turns a company's sales pitch into an interactive, avatar-led web
presentation. An organization uploads its documents and numbers, builds a scene-by-scene pitch in
a studio, and sends prospects personalized share links — a virtual avatar of the founder presents
the pitch, metrics animate as they're mentioned, and viewers can interrupt to ask questions
answered by RAG grounded only in that org's knowledge.

- **Design references**: [design-reference/](design-reference/) — open the HTML files in a browser

## Stack

Next.js (App Router) · Neon Postgres + pgvector (Drizzle) · Clerk (auth + orgs) · Inngest (jobs) ·
Cloudflare R2 (storage) · Anthropic (generation + Q&A) · Voyage (embeddings) · HeyGen (avatar
renders) · ElevenLabs (Q&A TTS)

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in real keys — see comments in .env.example
npm run db:push              # push schema to Neon (needs DATABASE_URL; enable pgvector first)
npm run dev                  # http://localhost:3000
npx inngest-cli@latest dev   # local job runner (separate terminal)
```

Minimum to click around: Clerk keys + `DATABASE_URL`. R2/HeyGen/Anthropic/Voyage/ElevenLabs keys
are needed from M2/M3 features on.

## Layout

- `src/app/o/[orgSlug]/…` — admin studio (auth required): Presentations, Template Queue, Knowledge
- `src/app/p/[slug]` — public viewer, opened via share links
- `src/db/schema.ts` — full data model; `src/db/scoped.ts` — **the only sanctioned way to query
  tenant data** (`forOrg(orgId)`); importing the raw client elsewhere is a lint error
- `src/inngest/` — background jobs (document ingestion, scene rendering)

## Tenant isolation

Every tenant table carries `org_id`; all access goes through `forOrg()` which pins the org filter;
retrieval queries filter by org **before** any vector search. Do not import `@/db/client` outside
`src/db` — use `@/db/scoped` (app code) or `@/db/system` (webhooks/jobs, cross-tenant by design).
