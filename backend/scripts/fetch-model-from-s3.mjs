/**
 * Optional: download ONNX from S3 to a local path (e.g. for offline tools).
 * The server normally loads the model from MODEL_S3_URI in memory — this script is not required to start the API.
 */
import "dotenv/config";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

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
    throw new Error("MODEL_S3_URI must use the s3:// scheme, e.g. s3://my-bucket/models/best.onnx");
  }
  const bucket = parsed.hostname.trim();
  const key = parsed.pathname.replace(/^\/+/, "");
  if (!bucket || !key) {
    throw new Error("MODEL_S3_URI must include bucket and object key (e.g. s3://bucket/models/best.onnx)");
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

async function fileExistsNonEmpty(filePath) {
  try {
    const st = await stat(filePath);
    return st.size > 0;
  } catch {
    return false;
  }
}

try {
  const modelS3Uri = trimEnv(process.env.MODEL_S3_URI);
  if (!modelS3Uri) {
    console.log("[model] MODEL_S3_URI not set; skipping (server loads ONNX from S3 in memory).");
    process.exit(0);
  }

  const destRaw = trimEnv(process.env.MODEL_ONNX_PATH) || "best.onnx";
  const dest = path.isAbsolute(destRaw) ? destRaw : path.join(process.cwd(), destRaw);
  const force = trimEnv(process.env.MODEL_S3_FORCE_DOWNLOAD).toLowerCase() === "true";

  if (!force && (await fileExistsNonEmpty(dest))) {
    console.log(
      `[model] File already present (${dest}); skip download. Set MODEL_S3_FORCE_DOWNLOAD=true to replace.`,
    );
    process.exit(0);
  }

  const { bucket, key } = parseModelS3Uri(modelS3Uri);
  const client = buildS3Client();

  console.log(`[model] Downloading s3://${bucket}/${key} -> ${dest}`);

  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) {
    console.error("[model] S3 GetObject returned empty body");
    process.exit(1);
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const buf = await out.Body.transformToByteArray();
  await writeFile(dest, buf);

  console.log(`[model] Saved ${dest}`);
} catch (err) {
  console.error("[model] Download failed:", err.message || err);
  process.exit(1);
}
