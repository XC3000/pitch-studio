import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { schema, systemDb } from "@/db/system";

/** Creates a ViewSession for a live share link. Public — called by the player on mount. */
export async function POST(req: Request) {
  let body: { linkId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!body.linkId || typeof body.linkId !== "string") {
    return NextResponse.json({ error: "linkId required" }, { status: 400 });
  }

  const db = systemDb();
  const [link] = await db
    .select()
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.id, body.linkId));
  if (!link || link.status !== "live") {
    return NextResponse.json({ error: "link unavailable" }, { status: 404 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const [session] = await db
    .insert(schema.viewSessions)
    .values({
      orgId: link.orgId,
      shareLinkId: link.id,
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      ipHash: ip ? createHash("sha256").update(ip).digest("hex").slice(0, 32) : null,
      country: req.headers.get("x-vercel-ip-country"),
    })
    .returning({ id: schema.viewSessions.id });

  return NextResponse.json({ sessionId: session.id });
}
