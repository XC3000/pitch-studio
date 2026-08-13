/**
 * Upstash rate limiting for /api/qa (cost protection):
 * - per IP: 10 questions/minute
 * - per link: 100 questions/day
 * - per session: 20 questions/session-day
 * Without Upstash credentials (early local dev) every check allows — the
 * public route still requires a live share link, so exposure is bounded.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

type Limiters = { perIp: Ratelimit; perLink: Ratelimit; perSession: Ratelimit };

let limiters: Limiters | null | undefined;

function getLimiters(): Limiters | null {
  if (limiters !== undefined) return limiters;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    limiters = null;
    return limiters;
  }
  const redis = Redis.fromEnv();
  limiters = {
    perIp: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "1 m"), prefix: "qa:ip" }),
    perLink: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, "1 d"), prefix: "qa:link" }),
    perSession: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 d"), prefix: "qa:session" }),
  };
  return limiters;
}

export type QaRateResult = { allowed: true } | { allowed: false; reason: string };

export async function checkQaRateLimit(opts: {
  ipHash: string;
  linkId: string;
  sessionId?: string | null;
}): Promise<QaRateResult> {
  const l = getLimiters();
  if (!l) return { allowed: true };
  const checks = await Promise.all([
    l.perIp.limit(opts.ipHash),
    l.perLink.limit(opts.linkId),
    opts.sessionId ? l.perSession.limit(opts.sessionId) : Promise.resolve({ success: true }),
  ]);
  if (!checks[0].success) return { allowed: false, reason: "Too many questions — give it a minute." };
  if (!checks[1].success || !checks[2].success) {
    return { allowed: false, reason: "Question limit reached for this link today." };
  }
  return { allowed: true };
}
