/**
 * Share-link passcode protection (M6). Two concerns:
 *
 *  1. Hashing the passcode at rest — scrypt with a per-passcode random salt,
 *     stored in `shareLinks.passcodeHash` as `scrypt$<saltHex>$<hashHex>`.
 *  2. A short-lived, HMAC-signed unlock cookie so a viewer who has entered the
 *     passcode once isn't re-prompted on every reload. The public viewer is
 *     unauthenticated, so this cookie is the whole session — it proves nothing
 *     but "this browser cleared the gate for this link before <exp>".
 *
 * Signing key: `VIEWER_UNLOCK_SECRET` if set, else derived from
 * `CLERK_SECRET_KEY` (always present). Never the raw passcode.
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEYLEN = 32;
/** Unlock cookies live this long before the viewer must re-enter the passcode. */
export const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export function cookieNameFor(linkId: string): string {
  return `pv_${linkId}`;
}

function signingKey(): string {
  return (
    process.env.VIEWER_UNLOCK_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    "pitch-studio-dev-unlock-secret"
  );
}

// ── Passcode hashing ───────────────────────────────────────────────────────

export function hashPasscode(passcode: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passcode.normalize("NFKC"), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(passcode.normalize("NFKC"), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Unlock-cookie minting / verification ────────────────────────────────────

function sign(linkId: string, exp: number): string {
  return createHmac("sha256", signingKey())
    .update(`${linkId}.${exp}`)
    .digest("hex");
}

/** Cookie value granting access to `linkId` until now + UNLOCK_TTL_MS. */
export function mintUnlockToken(linkId: string, now: number): string {
  const exp = now + UNLOCK_TTL_MS;
  return `${exp}.${sign(linkId, exp)}`;
}

/** True when `token` is a valid, unexpired unlock for `linkId`. */
export function verifyUnlockToken(
  linkId: string,
  token: string | undefined,
  now: number,
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < now) return false;
  const expected = sign(linkId, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
