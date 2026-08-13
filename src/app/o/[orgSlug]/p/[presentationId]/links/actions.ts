"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { forOrg, schema } from "@/db/scoped";
import { requireOrg } from "@/lib/auth";
import { type ActionResult } from "@/lib/action-result";
import { ActionError, safeAction } from "@/lib/safe-action";
import { hashPasscode } from "@/lib/passcode";
import { shareCode } from "@/lib/slug";

async function ownsPresentation(orgId: string, presentationId: string) {
  const scope = forOrg(orgId);
  const [pres] = await scope.db
    .select({ id: schema.presentations.id, defaultLang: schema.presentations.defaultLang })
    .from(schema.presentations)
    .where(scope.own(schema.presentations, eq(schema.presentations.id, presentationId)));
  return { scope, pres };
}

async function freshCode(orgId: string): Promise<string> {
  const scope = forOrg(orgId);
  for (let i = 0; i < 20; i++) {
    const code = shareCode();
    const [clash] = await scope.db
      .select({ id: schema.shareLinks.id })
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.code, code));
    if (!clash) return code;
  }
  throw new Error("Could not allocate a unique share code");
}

export type CreateLinkInput = {
  recipientName?: string;
  langOverride?: string;
  presenterOverrideId?: string;
  expiresAt?: string | null;
  /** optional passcode set at creation; hashed before storage */
  passcode?: string | null;
};

export async function createShareLink(
  orgSlug: string,
  presentationId: string,
  input: CreateLinkInput,
): Promise<ActionResult<{ id: string; code: string | null }>> {
  return safeAction("createShareLink", async () => {
    const { org } = await requireOrg(orgSlug);
    const { scope, pres } = await ownsPresentation(org.id, presentationId);
    if (!pres) throw new ActionError("Presentation not found");

    const code = await freshCode(org.id);
    const [row] = await scope.db
      .insert(schema.shareLinks)
      .values(
        scope.stamp({
          presentationId,
          code,
          isDefault: false,
          recipientName: input.recipientName?.trim() || null,
          langOverride: input.langOverride?.trim() || null,
          presenterOverrideId: input.presenterOverrideId || null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          passcodeHash: input.passcode?.trim() ? hashPasscode(input.passcode.trim()) : null,
          status: "live" as const,
        }),
      )
      .returning({ id: schema.shareLinks.id, code: schema.shareLinks.code });
    revalidatePath(`/o/${orgSlug}/p/${presentationId}/links`);
    return { id: row.id, code: row.code };
  });
}

export async function updateShareLink(
  orgSlug: string,
  presentationId: string,
  linkId: string,
  input: CreateLinkInput,
): Promise<ActionResult> {
  return safeAction("updateShareLink", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const updated = await scope.db
      .update(schema.shareLinks)
      .set({
        recipientName: input.recipientName?.trim() || null,
        langOverride: input.langOverride?.trim() || null,
        presenterOverrideId: input.presenterOverrideId || null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .where(scope.own(schema.shareLinks, eq(schema.shareLinks.id, linkId)))
      .returning({ id: schema.shareLinks.id });
    if (updated.length === 0) throw new ActionError("Link not found");
    revalidatePath(`/o/${orgSlug}/p/${presentationId}/links`);
  });
}

export async function setShareLinkStatus(
  orgSlug: string,
  presentationId: string,
  linkId: string,
  status: "live" | "revoked" | "draft",
): Promise<ActionResult> {
  return safeAction("setShareLinkStatus", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const updated = await scope.db
      .update(schema.shareLinks)
      .set({ status })
      .where(scope.own(schema.shareLinks, eq(schema.shareLinks.id, linkId)))
      .returning({ id: schema.shareLinks.id });
    if (updated.length === 0) throw new ActionError("Link not found");
    revalidatePath(`/o/${orgSlug}/p/${presentationId}/links`);
  });
}

/** Set (non-empty) or clear (null/empty) a link's passcode. */
export async function setLinkPasscode(
  orgSlug: string,
  presentationId: string,
  linkId: string,
  passcode: string | null,
): Promise<ActionResult> {
  return safeAction("setLinkPasscode", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    const value = passcode?.trim() ? hashPasscode(passcode.trim()) : null;
    const updated = await scope.db
      .update(schema.shareLinks)
      .set({ passcodeHash: value })
      .where(scope.own(schema.shareLinks, eq(schema.shareLinks.id, linkId)))
      .returning({ id: schema.shareLinks.id });
    if (updated.length === 0) throw new ActionError("Link not found");
    revalidatePath(`/o/${orgSlug}/p/${presentationId}/links`);
  });
}

export async function deleteShareLink(
  orgSlug: string,
  presentationId: string,
  linkId: string,
): Promise<ActionResult> {
  return safeAction("deleteShareLink", async () => {
    const { org } = await requireOrg(orgSlug);
    const scope = forOrg(org.id);
    // Never delete the codeless default link — the /p/{slug}-{lang} URL depends on it.
    const [link] = await scope.db
      .select({ id: schema.shareLinks.id, isDefault: schema.shareLinks.isDefault })
      .from(schema.shareLinks)
      .where(scope.own(schema.shareLinks, eq(schema.shareLinks.id, linkId)));
    if (!link) throw new ActionError("Link not found");
    if (link.isDefault)
      throw new ActionError("The default link can't be deleted — revoke it instead");
    await scope.db
      .delete(schema.shareLinks)
      .where(scope.own(schema.shareLinks, eq(schema.shareLinks.id, linkId)));
    revalidatePath(`/o/${orgSlug}/p/${presentationId}/links`);
  });
}
