import { asc } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import type { MetricFormat } from "@/viewer/types";
import { MetricsManager, type MetricRow } from "./metrics-manager";

export default async function MetricsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const items = await scope.db
    .select()
    .from(schema.metricLibraryItems)
    .where(scope.own(schema.metricLibraryItems))
    .orderBy(asc(schema.metricLibraryItems.label));

  const rows: MetricRow[] = items.map((m) => ({
    id: m.id,
    key: m.key,
    label: m.label,
    sublabel: m.sublabel,
    rawValue: m.rawValue == null ? null : String(m.rawValue),
    format: m.format as MetricFormat,
  }));

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-9">
      <div>
        <h2 className="text-2xl">Metric library</h2>
        <p className="mt-1.5 max-w-[560px] text-[13px] text-ink-2">
          Reusable, animated figures. Scenes reference these by key — edit a metric here and every
          scene that uses it updates. One formatter drives the count-ups in the viewer.
        </p>
      </div>
      <MetricsManager orgSlug={orgSlug} initial={rows} />
    </div>
  );
}
