import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { loadAnalytics } from "@/lib/analytics";
import { AnalyticsView } from "../../../analytics/analytics-view";

export default async function PresentationAnalyticsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; presentationId: string }>;
}) {
  const { orgSlug, presentationId } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const [presentation] = await scope.db
    .select({ id: schema.presentations.id })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!presentation) notFound();

  const data = await loadAnalytics(org.id, { presentationId });

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-8">
      <div className="mb-6">
        <h3 className="text-lg font-bold text-ink">Analytics</h3>
        <p className="mt-1 text-[13px] text-ink-2">
          Per-link engagement and the Q&A fallback rate for this presentation.
        </p>
      </div>
      <AnalyticsView data={data} scope="presentation" />
    </div>
  );
}
