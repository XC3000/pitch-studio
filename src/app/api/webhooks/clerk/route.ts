import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { schema, systemDb } from "@/db/system";

/**
 * Mirrors Clerk organizations + memberships into our tables so every tenant
 * row can FK to an organization. Configure in Clerk dashboard:
 * endpoint /api/webhooks/clerk, events: organization.*, organizationMembership.*
 */
export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook not configured" }, { status: 503 });

  const payload = await req.text();
  const h = await headers();
  let evt: { type: string; data: Record<string, unknown> };
  try {
    evt = new Webhook(secret).verify(payload, {
      "svix-id": h.get("svix-id") ?? "",
      "svix-timestamp": h.get("svix-timestamp") ?? "",
      "svix-signature": h.get("svix-signature") ?? "",
    }) as typeof evt;
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const db = systemDb();
  const data = evt.data;

  switch (evt.type) {
    case "organization.created":
    case "organization.updated": {
      const clerkOrgId = data.id as string;
      await db
        .insert(schema.organizations)
        .values({
          clerkOrgId,
          name: (data.name as string) ?? "Untitled",
          slug: (data.slug as string) ?? clerkOrgId,
          logoUrl: (data.image_url as string) ?? null,
        })
        .onConflictDoUpdate({
          target: schema.organizations.clerkOrgId,
          set: {
            name: (data.name as string) ?? "Untitled",
            slug: (data.slug as string) ?? clerkOrgId,
            logoUrl: (data.image_url as string) ?? null,
          },
        });
      break;
    }
    case "organization.deleted": {
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.clerkOrgId, data.id as string));
      break;
    }
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const orgData = data.organization as { id: string };
      const userData = data.public_user_data as {
        user_id: string;
        identifier?: string;
        first_name?: string;
        last_name?: string;
      };
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.clerkOrgId, orgData.id),
      });
      if (!org) break; // organization.created arrives first; retry-safe
      const role = (data.role as string) === "org:admin" ? "owner" : "editor";
      await db
        .insert(schema.memberships)
        .values({
          orgId: org.id,
          clerkUserId: userData.user_id,
          email: userData.identifier ?? null,
          name: [userData.first_name, userData.last_name].filter(Boolean).join(" ") || null,
          role,
        })
        .onConflictDoUpdate({
          target: [schema.memberships.orgId, schema.memberships.clerkUserId],
          set: { role, email: userData.identifier ?? null },
        });
      break;
    }
    case "organizationMembership.deleted": {
      const orgData = data.organization as { id: string };
      const userData = data.public_user_data as { user_id: string };
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.clerkOrgId, orgData.id),
      });
      if (org) {
        await db
          .delete(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, org.id),
              eq(schema.memberships.clerkUserId, userData.user_id),
            ),
          );
      }
      break;
    }
  }

  return NextResponse.json({ ok: true });
}
