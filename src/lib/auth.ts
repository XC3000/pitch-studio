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

  // Fast path: active Clerk org matches URL slug
  if (clerkOrgId && activeOrgSlug === orgSlug) {
    return contextFor(clerkOrgId, null, orgSlug, userId, orgRole ?? "org:member");
  }

  // Fast DB path: org already exists in system database
  const db = systemDb();
  const [localOrg] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug))
    .limit(1);

  if (localOrg) {
    return contextFor(localOrg.clerkOrgId, localOrg.name, localOrg.slug, userId, orgRole ?? "org:admin");
  }

  // Fallback to Clerk API lookup if org not yet mirrored in local DB
  const client = await clerkClient();
  const orgs = await client.users.getOrganizationMembershipList({ userId });
  const match = orgs.data.find((m) => m.organization.slug === orgSlug);
  if (!match) notFound();

  return contextFor(match.organization.id, match.organization.name, orgSlug, userId, match.role);
}

async function contextFor(
  clerkOrgId: string,
  knownName: string | null,
  slug: string,
  clerkUserId: string,
  clerkRole: string,
): Promise<OrgContext> {
  const db = systemDb();
  const [existing] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.clerkOrgId, clerkOrgId))
    .limit(1);

  let org = existing;

  if (!org) {
    // Lazy mirror (webhook is primary sync; this covers first touch/local dev)
    let name = knownName;
    if (!name) {
      try {
        const client = await clerkClient();
        name = (await client.organizations.getOrganization({ organizationId: clerkOrgId })).name;
      } catch {
        name = slug;
      }
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
