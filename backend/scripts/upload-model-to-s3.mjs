/**
 * One-time (or CI): upload a local ONNX file to S3.
 * Usage: from backend/, with .env or env vars set:
 *   node scripts/upload-model-to-s3.mjs [path/to/best.onnx]
 * Requires MODEL_S3_URI=s3://bucket/path/to/best.onnx
 */
import "dotenv/config";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function trimEnv(value) {
  return (value ?? "").trim();
}

function parseModelS3Uri(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid MODEL_S3_URI: ${raw}`);
  }
  if (parsed.protocol !== "s3:") {
    throw new Error("MODEL_S3_URI must use the s3:// scheme");
  }
  const bucket = parsed.hostname.trim();
  const key = parsed.pathname.replace(/^\/+/, "");
  if (!bucket || !key) {
    throw new Error("MODEL_S3_URI must include bucket and object key");
  }
  return { bucket, key };
}

function buildS3Client() {
  const region =
    trimEnv(process.env.DEPLOYED_AWS_REGION) ||
    trimEnv(process.env.AWS_REGION) ||
    trimEnv(process.env.AWS_DEFAULT_REGION) ||
    "us-east-1";
  const endpoint =
    trimEnv(process.env.DEPLOYED_S3_ENDPOINT) || trimEnv(process.env.S3_ENDPOINT) || undefined;
  const deployForceRaw = trimEnv(process.env.DEPLOYED_S3_FORCE_PATH_STYLE);
  const forcePathStyle =
    deployForceRaw.toLowerCase() === "true" ||
    ((!deployForceRaw || deployForceRaw === "") &&
      trimEnv(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === "true");

  const accessKeyId = trimEnv(process.env.DEPLOYED_AWS_ACCESS_KEY_ID);
  const secretAccessKey = trimEnv(process.env.DEPLOYED_AWS_SECRET_ACCESS_KEY);
  const sessionToken = trimEnv(process.env.DEPLOYED_AWS_SESSION_TOKEN);
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
      : undefined;

  return new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle,
    credentials,
  });
}

const modelS3Uri = trimEnv(process.env.MODEL_S3_URI);
if (!modelS3Uri) {
  console.error("Set MODEL_S3_URI, e.g. s3://fydp-28/models/best.onnx");
  process.exit(1);
}

const localPath = path.resolve(process.cwd(), process.argv[2] || "best.onnx");
try {
  const st = await stat(localPath);
  if (!st.isFile() || st.size === 0) {
    console.error(`Not a non-empty file: ${localPath}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Cannot read local file: ${localPath}`, e.message);
  process.exit(1);
}

const { bucket, key } = parseModelS3Uri(modelS3Uri);
const client = buildS3Client();

console.log(`Uploading ${localPath} -> s3://${bucket}/${key}`);

await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(localPath),
    ContentType: "application/octet-stream",
  }),
);

console.log("Done.");
