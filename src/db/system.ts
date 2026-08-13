/**
 * System-level (cross-tenant) database access. Reserved for code that runs
 * outside a tenant context: Clerk webhook mirroring, share-link resolution,
 * Inngest jobs before they resolve their org. Application/UI code must use
 * `forOrg()` from `./scoped` instead.
 */
export { rawDb as systemDb, schema } from "./client";
