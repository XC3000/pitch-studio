"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { ActionError, safeAction } from "@/lib/safe-action";

export type SettingsInput = {
  name: string;
  defaultLang: string;
  defaultPresenterId: string | null;
  branding: {
    brandMark?: string;
    brandName?: string;
    tagline?: string;
    badges?: string[];
  };
  suggestedQuestions: string[];
  endingCaption: string;
  appendixHeadline: string;
  appendixIntro: string;
};

export async function savePresentationSettings(
  orgSlug: string,
  presentationId: string,
  input: SettingsInput,
): Promise<ActionResult> {
  return safeAction("savePresentationSettings", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const name = input.name.trim();
    if (!name) throw new ActionError("Name is required");
    const lang = (input.defaultLang.trim() || "en").toLowerCase().slice(0, 2);

    const [pres] = await scope.db
      .select({ settings: schema.presentations.settings })
      .from(schema.presentations)
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
    if (!pres) throw new ActionError("Presentation not found");

    const settings = {
      ...(pres.settings as Record<string, unknown>),
      branding: {
        brandMark: input.branding.brandMark?.trim() || undefined,
        brandName: input.branding.brandName?.trim() || undefined,
        tagline: input.branding.tagline?.trim() || undefined,
        badges: (input.branding.badges ?? []).map((b) => b.trim()).filter(Boolean),
      },
      suggestedQuestions: input.suggestedQuestions.map((q) => q.trim()).filter(Boolean).slice(0, 6),
      endingCaption: input.endingCaption.trim(),
      appendixHeadline: input.appendixHeadline.trim(),
      appendixIntro: input.appendixIntro.trim(),
    };

    await scope.db
      .update(schema.presentations)
      .set({ name: name.slice(0, 120), defaultLang: lang, defaultPresenterId: input.defaultPresenterId || null, settings })
      .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));

    revalidatePath(`/o/${orgSlug}/p/${presentationId}`, "layout");
  });
}
