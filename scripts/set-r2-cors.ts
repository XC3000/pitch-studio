/**
 * Apply a CORS policy to the R2 DOCS bucket so the browser can PUT (upload) and
 * GET (view) presigned documents directly. Run once per bucket / when origins change.
 *
 *   npm run r2:cors
 *
 * Origins: http://localhost:3000 by default, plus any comma-separated list in
 * R2_CORS_ORIGINS (e.g. "https://app.example.com,https://staging.example.com").
 */
import { readFileSync } from "node:fs";

// Load .env.local (same tiny parser the seed script uses).
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { PutBucketCorsCommand, GetBucketCorsCommand, S3Client } = await import("@aws-sdk/client-s3");

  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error("R2_ACCOUNT_ID is not set");
  const bucket = process.env.R2_DOCS_BUCKET ?? "pitch-studio-docs";

  const origins = [
    "http://localhost:3000",
    ...(process.env.R2_CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  ];

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );

  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log(`CORS applied to "${bucket}" for origins:`, origins);
  console.log(JSON.stringify(check.CORSRules, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
