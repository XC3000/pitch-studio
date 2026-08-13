import { desc, sql } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { PresentationsBoard, type PresentationRow } from "./presentations-board";

export default async function PresentationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const presentations = await scope.db
    .select()
    .from(schema.presentations)
    .where(scope.own(schema.presentations))
    .orderBy(desc(schema.presentations.createdAt));

  const sceneCounts = await scope.db
    .select({ presentationId: schema.scenes.presentationId, n: sql<number>`count(*)::int` })
    .from(schema.scenes)
    .where(scope.own(schema.scenes))
    .groupBy(schema.scenes.presentationId);
  const linkCounts = await scope.db
    .select({ presentationId: schema.shareLinks.presentationId, n: sql<number>`count(*)::int` })
    .from(schema.shareLinks)
    .where(scope.own(schema.shareLinks))
    .groupBy(schema.shareLinks.presentationId);
  const [{ views }] = await scope.db
    .select({ views: sql<number>`count(*)::int` })
    .from(schema.viewSessions)
    .where(scope.own(schema.viewSessions));

  const sceneById = new Map(sceneCounts.map((r) => [r.presentationId, r.n]));
  const linkById = new Map(linkCounts.map((r) => [r.presentationId, r.n]));

  const rows: PresentationRow[] = presentations.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    sceneCount: sceneById.get(p.id) ?? 0,
    linkCount: linkById.get(p.id) ?? 0,
  }));

  const langs = new Set(presentations.map((p) => p.defaultLang));
  const stats = [
    { label: "PRESENTATIONS", value: presentations.length },
    { label: "LIVE", value: presentations.filter((p) => p.status === "live").length },
    { label: "TOTAL VIEWS", value: views },
    { label: "LANGUAGES", value: langs.size || 1 },
  ];

  return (
    <div className="mx-auto max-w-[1360px] px-7 py-9">
      <div className="mb-5 grid grid-cols-2 gap-3.5 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[14px] border border-line bg-panel px-4.5 py-4">
            <div className="text-[10px] font-semibold tracking-[.12em] text-ink-3">{s.label}</div>
            <div className="mt-1.5 text-[26px] font-bold tabular-nums text-ink">{s.value}</div>
          </div>
        ))}
      </div>

      <PresentationsBoard orgSlug={orgSlug} initial={rows} />
    </div>
  );
}
