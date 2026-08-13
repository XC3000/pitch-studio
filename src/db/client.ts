/**
 * Raw database client. Do NOT import this outside `src/db` — all tenant data
 * access must go through `forOrg()` in `src/db/scoped.ts` so every query is
 * org-scoped. Enforced by eslint `no-restricted-imports`.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

function createDb() {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — add it to .env.local (see .env.example)");
  }
  return drizzle(neon(connectionString), { schema, casing: "snake_case" });
}

let _db: ReturnType<typeof createDb> | undefined;

/** Lazy so `next build` succeeds without a database configured. */
export function rawDb() {
  _db ??= createDb();
  return _db;
}

export type Db = ReturnType<typeof rawDb>;
export { schema };
