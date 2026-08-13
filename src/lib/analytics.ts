/**
 * M6 analytics read layer. All reads are org-scoped (WHERE org_id = $1 first);
 * the public write paths (session/track/qa routes) already stamp org_id, so we
 * never trust a caller-supplied org here — the admin page passes the org it
 * already resolved via `requireOrg`.
 *
 * Volumes are modest (one org, a handful of links), so we fetch the scoped rows
 * and aggregate in JS rather than hand-rolling window-function SQL. If a tenant
 * ever grows hot, these become materialized rollups — the shapes stay the same.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, systemDb } from "@/db/system";

export type LinkStats = {
  linkId: string;
  code: string | null;
  isDefault: boolean;
  recipientName: string | null;
  presentationId: string;
  presentationName: string;
  status: "live" | "draft" | "revoked";
  /** view sessions opened on this link */
  opens: number;
  /** distinct hashed IPs (falls back to opens when IPs weren't captured) */
  uniqueViewers: number;
  /** grounded + fallback questions asked from this link's sessions */
  questions: number;
  fallbacks: number;
  /** mean deepest-scene-reached across sessions, 0–100 */
  avgWatchDepthPct: number;
  lastOpenedAt: string | null;
};

export type FallbackItem = {
  question: string;
  at: string;
  recipientName: string | null;
};

export type FallbackReport = {
  total: number;
  fallbacks: number;
  /** 0–100 */
  rate: number;
  recent: FallbackItem[];
};

export type UsageByKind = {
  kind: string;
  quantity: number;
  costUsd: number;
  events: number;
};

export type UsageSummary = {
  byKind: UsageByKind[];
  totalCostUsd: number;
};

export type Overview = {
  opens: number;
  uniqueViewers: number;
  questions: number;
  fallbackRate: number;
  avgWatchDepthPct: number;
  activeLinks: number;
};

export type AnalyticsData = {
  overview: Overview;
  links: LinkStats[];
  fallback: FallbackReport;
  /** org-wide metering; only surfaced on the org dashboard */
  usage: UsageSummary | null;
};

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * Assemble the analytics for an org, optionally narrowed to one presentation.
 * `includeUsage` gates the org-wide usage rollup (org dashboard only — usage
 * records aren't attributed to a presentation).
 */
export async function loadAnalytics(
  orgId: string,
  opts: { presentationId?: string; includeUsage?: boolean } = {},
): Promise<AnalyticsData> {
  const db = systemDb();
  const { presentationId, includeUsage } = opts;

  // ── links in scope ─────────────────────────────────────────────────────
  const linkWhere = presentationId
    ? and(
        eq(schema.shareLinks.orgId, orgId),
        eq(schema.shareLinks.presentationId, presentationId),
      )
    : eq(schema.shareLinks.orgId, orgId);
  const links = await db.select().from(schema.shareLinks).where(linkWhere);
  const linkById = new Map(links.map((l) => [l.id, l]));
  const linkIds = links.map((l) => l.id);

  const presRows = await db
    .select({ id: schema.presentations.id, name: schema.presentations.name })
    .from(schema.presentations)
    .where(eq(schema.presentations.orgId, orgId));
  const presNameById = new Map(presRows.map((p) => [p.id, p.name]));

  // scene positions → watch-depth denominator per presentation
  const sceneRows = await db
    .select({
      id: schema.scenes.id,
      presentationId: schema.scenes.presentationId,
      position: schema.scenes.position,
    })
    .from(schema.scenes)
    .where(eq(schema.scenes.orgId, orgId));
  const scenePos = new Map(sceneRows.map((s) => [s.id, s.position]));
  const sceneCountByPres = new Map<string, number>();
  for (const s of sceneRows) {
    sceneCountByPres.set(s.presentationId, (sceneCountByPres.get(s.presentationId) ?? 0) + 1);
  }

  const empty: AnalyticsData = {
    overview: {
      opens: 0,
      uniqueViewers: 0,
      questions: 0,
      fallbackRate: 0,
      avgWatchDepthPct: 0,
      activeLinks: links.filter((l) => l.status === "live").length,
    },
    links: links.map((l) => ({
      linkId: l.id,
      code: l.code,
      isDefault: l.isDefault,
      recipientName: l.recipientName,
      presentationId: l.presentationId,
      presentationName: presNameById.get(l.presentationId) ?? "—",
      status: l.status,
      opens: 0,
      uniqueViewers: 0,
      questions: 0,
      fallbacks: 0,
      avgWatchDepthPct: 0,
      lastOpenedAt: null,
    })),
    fallback: { total: 0, fallbacks: 0, rate: 0, recent: [] },
    usage: includeUsage ? await loadUsage(orgId) : null,
  };
  if (linkIds.length === 0) return empty;

  // ── sessions on those links ────────────────────────────────────────────
  const sessions = await db
    .select({
      id: schema.viewSessions.id,
      shareLinkId: schema.viewSessions.shareLinkId,
      ipHash: schema.viewSessions.ipHash,
      startedAt: schema.viewSessions.startedAt,
    })
    .from(schema.viewSessions)
    .where(
      and(eq(schema.viewSessions.orgId, orgId), inArray(schema.viewSessions.shareLinkId, linkIds)),
    );
  const sessionLink = new Map(sessions.map((s) => [s.id, s.shareLinkId]));
  const sessionIds = sessions.map((s) => s.id);

  // deepest scene reached per session (from scene_enter/scene_complete events)
  const deepestBySession = new Map<string, number>();
  if (sessionIds.length > 0) {
    const events = await db
      .select({
        sessionId: schema.viewEvents.sessionId,
        type: schema.viewEvents.type,
        sceneId: schema.viewEvents.sceneId,
      })
      .from(schema.viewEvents)
      .where(
        and(
          eq(schema.viewEvents.orgId, orgId),
          inArray(schema.viewEvents.sessionId, sessionIds),
          inArray(schema.viewEvents.type, ["scene_enter", "scene_complete"]),
        ),
      );
    for (const e of events) {
      if (!e.sceneId) continue;
      const pos = scenePos.get(e.sceneId);
      if (pos == null) continue;
      const prev = deepestBySession.get(e.sessionId) ?? -1;
      if (pos > prev) deepestBySession.set(e.sessionId, pos);
    }
  }

  // Q&A exchanges tied to those sessions (source of truth for questions/fallback)
  const qa =
    sessionIds.length > 0
      ? await db
          .select({
            sessionId: schema.qaExchanges.sessionId,
            question: schema.qaExchanges.question,
            hitFallback: schema.qaExchanges.hitFallback,
            createdAt: schema.qaExchanges.createdAt,
          })
          .from(schema.qaExchanges)
          .where(
            and(
              eq(schema.qaExchanges.orgId, orgId),
              eq(schema.qaExchanges.isTest, false),
              inArray(schema.qaExchanges.sessionId, sessionIds),
            ),
          )
          .orderBy(desc(schema.qaExchanges.createdAt))
      : [];

  // ── per-link aggregation ───────────────────────────────────────────────
  type Acc = {
    opens: number;
    ips: Set<string>;
    depthSum: number;
    depthN: number;
    questions: number;
    fallbacks: number;
    lastOpened: number | null;
  };
  const acc = new Map<string, Acc>();
  const get = (linkId: string): Acc => {
    let a = acc.get(linkId);
    if (!a) {
      a = { opens: 0, ips: new Set(), depthSum: 0, depthN: 0, questions: 0, fallbacks: 0, lastOpened: null };
      acc.set(linkId, a);
    }
    return a;
  };

  for (const s of sessions) {
    const a = get(s.shareLinkId);
    a.opens += 1;
    if (s.ipHash) a.ips.add(s.ipHash);
    const startMs = s.startedAt?.getTime() ?? null;
    if (startMs != null && (a.lastOpened == null || startMs > a.lastOpened)) a.lastOpened = startMs;

    const deepest = deepestBySession.get(s.id);
    const link = linkById.get(s.shareLinkId);
    const total = link ? sceneCountByPres.get(link.presentationId) ?? 0 : 0;
    if (deepest != null && total > 0) {
      a.depthSum += Math.min(100, ((deepest + 1) / total) * 100);
      a.depthN += 1;
    }
  }
  for (const x of qa) {
    if (!x.sessionId) continue;
    const linkId = sessionLink.get(x.sessionId);
    if (!linkId) continue;
    const a = get(linkId);
    a.questions += 1;
    if (x.hitFallback) a.fallbacks += 1;
  }

  const linkStats: LinkStats[] = links.map((l) => {
    const a = acc.get(l.id);
    return {
      linkId: l.id,
      code: l.code,
      isDefault: l.isDefault,
      recipientName: l.recipientName,
      presentationId: l.presentationId,
      presentationName: presNameById.get(l.presentationId) ?? "—",
      status: l.status,
      opens: a?.opens ?? 0,
      uniqueViewers: a ? (a.ips.size > 0 ? a.ips.size : a.opens) : 0,
      questions: a?.questions ?? 0,
      fallbacks: a?.fallbacks ?? 0,
      avgWatchDepthPct: a && a.depthN > 0 ? Math.round((a.depthSum / a.depthN) * 10) / 10 : 0,
      lastOpenedAt: a?.lastOpened != null ? new Date(a.lastOpened).toISOString() : null,
    };
  });
  // busiest links first, default link kept visible near the top
  linkStats.sort((x, y) => y.opens - x.opens || Number(y.isDefault) - Number(x.isDefault));

  // ── overview + fallback report ─────────────────────────────────────────
  const totalOpens = linkStats.reduce((n, l) => n + l.opens, 0);
  const totalUnique = linkStats.reduce((n, l) => n + l.uniqueViewers, 0);
  const totalQ = qa.length;
  const totalFb = qa.filter((x) => x.hitFallback).length;
  const depthSessions = [...deepestBySession.keys()];
  let overallDepthSum = 0;
  let overallDepthN = 0;
  for (const sid of depthSessions) {
    const linkId = sessionLink.get(sid);
    const link = linkId ? linkById.get(linkId) : undefined;
    const total = link ? sceneCountByPres.get(link.presentationId) ?? 0 : 0;
    const deepest = deepestBySession.get(sid)!;
    if (total > 0) {
      overallDepthSum += Math.min(100, ((deepest + 1) / total) * 100);
      overallDepthN += 1;
    }
  }

  const recent: FallbackItem[] = qa
    .filter((x) => x.hitFallback)
    .slice(0, 12)
    .map((x) => {
      const linkId = x.sessionId ? sessionLink.get(x.sessionId) : undefined;
      const link = linkId ? linkById.get(linkId) : undefined;
      return {
        question: x.question,
        at: (x.createdAt ?? new Date()).toISOString(),
        recipientName: link?.isDefault ? "Default link" : link?.recipientName ?? null,
      };
    });

  return {
    overview: {
      opens: totalOpens,
      uniqueViewers: totalUnique,
      questions: totalQ,
      fallbackRate: pct(totalFb, totalQ),
      avgWatchDepthPct: overallDepthN > 0 ? Math.round((overallDepthSum / overallDepthN) * 10) / 10 : 0,
      activeLinks: links.filter((l) => l.status === "live").length,
    },
    links: linkStats,
    fallback: { total: totalQ, fallbacks: totalFb, rate: pct(totalFb, totalQ), recent },
    usage: includeUsage ? await loadUsage(orgId) : null,
  };
}

async function loadUsage(orgId: string): Promise<UsageSummary> {
  const db = systemDb();
  const rows = await db
    .select({
      kind: schema.usageRecords.kind,
      quantity: schema.usageRecords.quantity,
      costUsd: schema.usageRecords.costUsd,
    })
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.orgId, orgId));

  const byKind = new Map<string, UsageByKind>();
  for (const r of rows) {
    let e = byKind.get(r.kind);
    if (!e) {
      e = { kind: r.kind, quantity: 0, costUsd: 0, events: 0 };
      byKind.set(r.kind, e);
    }
    e.quantity += Number(r.quantity ?? 0);
    e.costUsd += Number(r.costUsd ?? 0);
    e.events += 1;
  }
  const list = [...byKind.values()].sort((a, b) => b.costUsd - a.costUsd);
  return {
    byKind: list,
    totalCostUsd: list.reduce((n, k) => n + k.costUsd, 0),
  };
}
