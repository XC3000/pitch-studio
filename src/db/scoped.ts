/**
 * Org-scoped data access — the only sanctioned way to touch tenant data.
 *
 * Layer 2 of the tenant-isolation strategy: every read/write goes through
 * `forOrg(orgId)`, which pins the WHERE org_id filter so a missing filter is
 * a type error at the call site, not a data leak in production.
 */
import { and, eq, SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { rawDb, schema, type Db } from "./client";

/** Any schema table carrying an org_id column. */
type OrgTable = { orgId: AnyPgColumn };

export class OrgScope {
  constructor(
    readonly orgId: string,
    readonly db: Db,
  ) {}

  /** `where` for this org, optionally AND-ed with more conditions. */
  own(table: OrgTable, ...conditions: (SQL | undefined)[]): SQL {
    return and(eq(table.orgId, this.orgId), ...conditions)!;
  }

  /** Spread into inserts so org_id can never be forgotten or spoofed. */
  stamp<T extends Record<string, unknown>>(values: T): T & { orgId: string } {
    return { ...values, orgId: this.orgId };
  }
}

/**
 * Entry point for all tenant queries:
 *
 *   const org = forOrg(orgId);
 *   await org.db.select().from(schema.documents).where(org.own(schema.documents));
 *   await org.db.insert(schema.facts).values(org.stamp({ body }));
 */
export function forOrg(orgId: string): OrgScope {
  if (!orgId) throw new Error("forOrg() called without an orgId");
  return new OrgScope(orgId, rawDb());
}

export { schema };
