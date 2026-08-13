import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; presentationId: string }>;
}) {
  const { orgSlug, presentationId } = await params;
  const { org } = await requireOrg(orgSlug);
  const scope = forOrg(org.id);

  const [presentation] = await scope.db
    .select()
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  if (!presentation) notFound();

  const presenters = await scope.db
    .select({ id: schema.presenters.id, name: schema.presenters.name })
    .from(schema.presenters)
    .where(scope.own(schema.presenters));

  const s = (presentation.settings ?? {}) as {
    branding?: { brandMark?: string; brandName?: string; tagline?: string; badges?: string[] };
    suggestedQuestions?: string[];
    endingCaption?: string;
    appendixHeadline?: string;
    appendixIntro?: string;
  };

  return (
    <div className="mx-auto max-w-[860px] px-7 py-8">
      <SettingsForm
        orgSlug={orgSlug}
        presentationId={presentationId}
        presenters={presenters}
        initial={{
          name: presentation.name,
          defaultLang: presentation.defaultLang,
          defaultPresenterId: presentation.defaultPresenterId,
          branding: {
            brandMark: s.branding?.brandMark ?? "",
            brandName: s.branding?.brandName ?? "",
            tagline: s.branding?.tagline ?? "",
            badges: s.branding?.badges ?? [],
          },
          suggestedQuestions: s.suggestedQuestions ?? [],
          endingCaption: s.endingCaption ?? "",
          appendixHeadline: s.appendixHeadline ?? "",
          appendixIntro: s.appendixIntro ?? "",
        }}
      />
    </div>
  );
}
