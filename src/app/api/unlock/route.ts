/**
 * Passcode unlock for a protected share link (M6). Public: verifies the
 * submitted passcode against the link's stored hash and, on success, sets a
 * short-lived HMAC-signed cookie so the viewer isn't re-prompted on reload.
 * The org is derived from the link, never from the caller.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { schema, systemDb } from "@/db/system";
import {
  UNLOCK_TTL_MS,
  cookieNameFor,
  mintUnlockToken,
  verifyPasscode,
} from "@/lib/passcode";

export async function POST(req: Request) {
  let body: { linkId?: string; passcode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { linkId, passcode } = body;
  if (!linkId || typeof linkId !== "string" || typeof passcode !== "string") {
    return NextResponse.json({ error: "linkId and passcode required" }, { status: 400 });
  }

  const db = systemDb();
  const [link] = await db
    .select({
      id: schema.shareLinks.id,
      status: schema.shareLinks.status,
      passcodeHash: schema.shareLinks.passcodeHash,
      expiresAt: schema.shareLinks.expiresAt,
    })
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.id, linkId));

  // Uniform response whether the link is missing, unavailable, or the passcode
  // is wrong — don't leak which links exist or are protected.
  const deny = () => NextResponse.json({ ok: false }, { status: 401 });
  if (!link || link.status !== "live" || !link.passcodeHash) return deny();
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return deny();
  if (!verifyPasscode(passcode, link.passcodeHash)) return deny();

  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieNameFor(link.id), mintUnlockToken(link.id, Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(UNLOCK_TTL_MS / 1000),
  });
  return res;
}
