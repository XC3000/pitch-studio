import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { schema, systemDb } from "@/db/system";

const EVENT_TYPES = new Set([
  "open",
  "scene_enter",
  "scene_complete",
  "evidence_open",
  "appendix_open",
  "question",
  "replay",
  "exit",
] as const);

type EventType = typeof EVENT_TYPES extends Set<infer T> ? T : never;

type IncomingEvent = {
  type: string;
  sceneId?: string | null;
  payload?: Record<string, unknown>;
  at?: string;
};

const MAX_EVENTS = 50;

/** Batched view events from the player (fetch keepalive / sendBeacon). Public. */
export async function POST(req: Request) {
  let body: { sessionId?: string; events?: IncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { sessionId } = body;
  const events = (body.events ?? []).slice(0, MAX_EVENTS);
  if (!sessionId || typeof sessionId !== "string" || events.length === 0) {
    return NextResponse.json({ error: "sessionId and events required" }, { status: 400 });
  }

  const db = systemDb();
  const [session] = await db
    .select({ id: schema.viewSessions.id, orgId: schema.viewSessions.orgId })
    .from(schema.viewSessions)
    .where(eq(schema.viewSessions.id, sessionId));
  if (!session) return NextResponse.json({ error: "unknown session" }, { status: 404 });

  const rows = events
    .filter((e) => EVENT_TYPES.has(e.type as EventType))
    .map((e) => ({
      orgId: session.orgId,
      sessionId: session.id,
      type: e.type as EventType,
      sceneId: typeof e.sceneId === "string" ? e.sceneId : null,
      ts: e.at ? new Date(e.at) : new Date(),
      payload: e.payload ?? {},
    }));
  if (rows.length > 0) await db.insert(schema.viewEvents).values(rows);

  await db
    .update(schema.viewSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.viewSessions.id, session.id));

  return NextResponse.json({ ok: true, recorded: rows.length });
}
