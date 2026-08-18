/**
 * Raw database client. Do NOT import this outside `src/db` — all tenant data
 * access must go through `forOrg()` in `src/db/scoped.ts` so every query is
 * org-scoped. Enforced by eslint `no-restricted-imports`.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/env";
import * as schema from "./schema";

function createDb() {
  return drizzle(neon(env.DATABASE_URL), { schema, casing: "snake_case" });
}

let _db: ReturnType<typeof createDb> | undefined;

/** Lazy so `next build` succeeds without a database configured. */
export function rawDb() {
  _db ??= createDb();
  return _db;
}

export type Db = ReturnType<typeof rawDb>;
export { schema };
