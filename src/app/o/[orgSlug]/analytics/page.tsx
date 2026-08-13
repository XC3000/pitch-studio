import { requireOrg } from "@/lib/auth";
import { loadAnalytics } from "@/lib/analytics";
import { AnalyticsView } from "./analytics-view";

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrg(orgSlug);
  const data = await loadAnalytics(org.id, { includeUsage: true });

  return (
    <div className="mx-auto max-w-[1180px] px-7 py-8">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-ink">Analytics</h2>
        <p className="mt-1 text-[13px] text-ink-2">
          Engagement across every share link, the Q&A fallback rate, and metered usage for this
          organization.
        </p>
      </div>
      <AnalyticsView data={data} scope="org" />
    </div>
  );
}
