import "dotenv/config";
import { execSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("No DATABASE_URL found, skipping build migration.");
    return;
  }

  console.log("==> [Migration] Ensuring pgvector extension in Neon Postgres...");
  try {
    const sql = neon(url);
    await sql`CREATE EXTENSION IF NOT EXISTS vector;`;
    console.log("==> [Migration] pgvector extension verified!");
  } catch (err) {
    console.warn("==> [Migration] Could not create extension automatically:", err);
  }

  console.log("==> [Migration] Pushing Drizzle database schema...");
  try {
    execSync("npx drizzle-kit push", {
      stdio: "inherit",
      env: { ...process.env },
    });
    console.log("==> [Migration] Database schema pushed successfully!");
  } catch (err) {
    console.error("==> [Migration] Failed to push database schema:", err);
    process.exit(1);
  }
}

main();
