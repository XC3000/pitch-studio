import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { schema, systemDb } from "@/db/system";

export type OrgContext = {
  org: typeof schema.organizations.$inferSelect;
  clerkUserId: string;
  role: "owner" | "admin" | "editor";
};

const ROLE_MAP: Record<string, OrgContext["role"]> = {
  "org:admin": "owner",
  "org:member": "editor",
};

/**
 * Resolve + authorize the org for an admin page/action.
 * Verifies the Clerk session, checks the user belongs to the org matching
 * `orgSlug`, and lazily mirrors the org into our DB on first touch (so local
 * dev works before the Clerk webhook is configured).
 */
export async function requireOrg(orgSlug: string): Promise<OrgContext> {
  const { userId, orgSlug: activeOrgSlug, orgId: clerkOrgId, orgRole } = await auth();
  if (!userId) redirect("/sign-in");

  // The URL org must be the user's active Clerk organization.
  if (!clerkOrgId || activeOrgSlug !== orgSlug) {
    const client = await clerkClient();
    const orgs = await client.users.getOrganizationMembershipList({ userId });
    const match = orgs.data.find((m) => m.organization.slug === orgSlug);
    if (!match) notFound();
    // Belongs, but not the active org — the org switcher sets it client-side.
    return contextFor(match.organization.id, match.organization.name, orgSlug, userId, match.role);
  }

  return contextFor(clerkOrgId, null, orgSlug, userId, orgRole ?? "org:member");
}

async function contextFor(
  clerkOrgId: string,
  knownName: string | null,
  slug: string,
  clerkUserId: string,
  clerkRole: string,
): Promise<OrgContext> {
  const db = systemDb();
  let org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.clerkOrgId, clerkOrgId),
  });

  if (!org) {
    // Lazy mirror (webhook is the primary sync; this covers first touch/local dev)
    let name = knownName;
    if (!name) {
      const client = await clerkClient();
      name = (await client.organizations.getOrganization({ organizationId: clerkOrgId })).name;
    }
    [org] = await db
      .insert(schema.organizations)
      .values({ clerkOrgId, name: name ?? slug, slug })
      .onConflictDoUpdate({
        target: schema.organizations.clerkOrgId,
        set: { slug, name: name ?? slug },
      })
      .returning();
  }

  return { org, clerkUserId, role: ROLE_MAP[clerkRole] ?? "editor" };
}
