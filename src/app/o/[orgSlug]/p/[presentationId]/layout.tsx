import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { PublishButton } from "./publish-button";
import { PresentationSubtabs } from "./subtabs";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-warn-soft text-warn",
  live: "bg-ok-soft text-ok",
  archived: "bg-panel-2 text-ink-3",
};

export default async function PresentationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; presentationId: string }>;
}) {
  const { orgSlug, presentationId } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const [presentation] = await scope.db
    .select({
      id: schema.presentations.id,
      name: schema.presentations.name,
      slug: schema.presentations.slug,
      status: schema.presentations.status,
      defaultLang: schema.presentations.defaultLang,
    })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!presentation) notFound();

  const base = `/o/${orgSlug}/p/${presentationId}`;
  const viewerUrl = `/p/${presentation.slug}-${presentation.defaultLang}`;

  return (
    <div>
      <div className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-3 px-7 pt-6">
          <Link href={`/o/${orgSlug}`} className="text-[12px] font-semibold text-ink-3 hover:text-ink">
            ← Presentations
          </Link>
          <h2 className="text-xl">{presentation.name}</h2>
          <Badge
            className={`rounded-full border-none px-2.5 py-1 text-[10px] font-bold tracking-[.08em] uppercase ${STATUS_STYLE[presentation.status]}`}
          >
            {presentation.status}
          </Badge>
          <div className="ml-auto flex items-center gap-2.5">
            <a
              href={viewerUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-accent-line bg-accent-soft px-3.5 py-1.5 text-[11.5px] font-semibold text-accent"
            >
              Preview viewer ↗
            </a>
            <PublishButton orgSlug={orgSlug} presentationId={presentationId} status={presentation.status} />
          </div>
        </div>
        <div className="mx-auto max-w-[1360px] px-7">
          <PresentationSubtabs base={base} />
        </div>
      </div>
      {children}
    </div>
  );
}
