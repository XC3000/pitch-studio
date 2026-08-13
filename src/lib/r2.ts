import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible).
 * - DOCS bucket: private; source documents, presigned access only.
 * - MEDIA bucket: public behind the CDN; rendered avatar videos.
 */
function r2() {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error("R2_ACCOUNT_ID is not set (see .env.example)");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // The SDK's default (WHEN_SUPPORTED) bakes a CRC32 of an EMPTY body into
    // presigned PUT URLs (x-amz-checksum-crc32/x-amz-sdk-checksum-algorithm);
    // the browser then uploads real bytes and R2 400s on the mismatch. R2
    // doesn't require these, so only send a checksum when a command explicitly asks.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export const DOCS_BUCKET = process.env.R2_DOCS_BUCKET ?? "pitch-studio-docs";
export const MEDIA_BUCKET = process.env.R2_MEDIA_BUCKET ?? "pitch-studio-media";

/** Presigned PUT for direct browser upload of a source document. */
export async function presignDocUpload(key: string, contentType: string) {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: DOCS_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 600 },
  );
}

/** Presigned PUT for direct browser upload of public scene media (image/video). */
export async function presignMediaUpload(key: string, contentType: string) {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 600 },
  );
}

/** Remove an object from the MEDIA bucket. */
export async function deleteMedia(key: string) {
  await r2().send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
}

/** Presigned GET for an org member to view a private source document. */
export async function presignDocDownload(key: string) {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: key }), {
    expiresIn: 3600,
  });
}

/** Fetch a source document's bytes for server-side parsing (ingestion). */
export async function getDocBytes(key: string): Promise<Uint8Array> {
  const res = await r2().send(new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`R2 object has no body: ${key}`);
  return res.Body.transformToByteArray();
}

/** Remove a source document from the DOCS bucket. */
export async function deleteDoc(key: string) {
  await r2().send(new DeleteObjectCommand({ Bucket: DOCS_BUCKET, Key: key }));
}

/** Store a rendered video (or other public media) in the MEDIA bucket. */
export async function putMedia(key: string, body: Uint8Array, contentType: string) {
  await r2().send(
    new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

/** Public CDN URL for rendered media (videos, idle loops). */
export function mediaUrl(key: string) {
  const base = process.env.R2_MEDIA_PUBLIC_URL;
  if (!base) throw new Error("R2_MEDIA_PUBLIC_URL is not set (see .env.example)");
  return `${base.replace(/\/$/, "")}/${key}`;
}
