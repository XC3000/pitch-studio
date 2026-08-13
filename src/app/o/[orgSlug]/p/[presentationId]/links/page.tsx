import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { LinksManager, type LinkRow } from "./links-manager";

/** Kept out of the render body so the react purity lint doesn't flag Date.now. */
function isExpired(at: Date | null): boolean {
  return !!(at && at.getTime() < Date.now());
}

export default async function ShareLinksPage({
  params,
}: {
  params: Promise<{ orgSlug: string; presentationId: string }>;
}) {
  const { orgSlug, presentationId } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const [presentation] = await scope.db
    .select({
      id: schema.presentations.id,
      slug: schema.presentations.slug,
      defaultLang: schema.presentations.defaultLang,
    })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!presentation) notFound();

  const links = await scope.db
    .select()
    .from(schema.shareLinks)
    .where(scope.own(schema.shareLinks, eq(schema.shareLinks.presentationId, presentationId)))
    .orderBy(desc(schema.shareLinks.isDefault), desc(schema.shareLinks.createdAt));

  const presenters = await scope.db
    .select({ id: schema.presenters.id, name: schema.presenters.name })
    .from(schema.presenters)
    .where(scope.own(schema.presenters));

  const sessionCounts = await scope.db
    .select({ shareLinkId: schema.viewSessions.shareLinkId })
    .from(schema.viewSessions)
    .where(scope.own(schema.viewSessions));
  const viewsByLink = new Map<string, number>();
  for (const s of sessionCounts) viewsByLink.set(s.shareLinkId, (viewsByLink.get(s.shareLinkId) ?? 0) + 1);

  const rows: LinkRow[] = links.map((l) => ({
    id: l.id,
    code: l.code,
    isDefault: l.isDefault,
    recipientName: l.recipientName,
    langOverride: l.langOverride,
    presenterOverrideId: l.presenterOverrideId,
    status: l.status,
    expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
    expired: isExpired(l.expiresAt),
    hasPasscode: !!l.passcodeHash,
    views: viewsByLink.get(l.id) ?? 0,
  }));

  return (
    <div className="mx-auto max-w-[1080px] px-7 py-8">
      <LinksManager
        orgSlug={orgSlug}
        presentationId={presentationId}
        presSlug={presentation.slug}
        defaultLang={presentation.defaultLang}
        presenters={presenters}
        initial={rows}
      />
    </div>
  );
}
