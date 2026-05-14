import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { promises as fs } from "node:fs";
import path from "node:path";

type ParsedS3Location = {
  bucket: string;
  keyPrefix: string;
};

export type S3ConnectionStatus =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      bucket: string;
      keyPrefix: string;
      region: string;
      endpoint?: string;
    };

export type S3EnvironmentHealth = {
  primary: S3ConnectionStatus;
  deployed: S3ConnectionStatus;
  /** Where disk → S3 reconciliation uploads (deployed if set, otherwise primary). */
  syncTarget: "primary" | "deployed" | "none";
};

type S3PutResult = {
  bucket: string;
  key: string;
  uri: string;
};

type S3Runtime = {
  parsedS3Location: ParsedS3Location;
  s3Client: S3Client;
  region: string;
  endpoint?: string;
};

export type SynchronizeS3DiskResult = {
  startedAt: string;
  endedAt: string;
  target: "deployed" | "primary";
  uploaded: number;
  skippedExisting: number;
  scanned: number;
  errors: Array<{ key: string; message: string }>;
};

let isS3DiskSyncInProgress = false;

function trimEnv(value: string | undefined) {
  return (value ?? "").trim();
}

function parseS3Uri(rawUri: string): ParsedS3Location {
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    throw new Error("S3 URI must be a valid URI, for example: s3://my-bucket/my/prefix");
  }

  if (parsed.protocol !== "s3:") {
    throw new Error("S3 URI must use the s3:// scheme");
  }

  const bucket = parsed.hostname.trim();
  const keyPrefix = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

  if (!bucket) {
    throw new Error("S3 URI is missing bucket name");
  }

  return { bucket, keyPrefix };
}

function getAwsCredentialOptions(role: "default" | "deployed"): NonNullable<
  ConstructorParameters<typeof S3Client>[0]
>["credentials"] {
  if (role !== "deployed") {
    return undefined;
  }
  const accessKeyId = trimEnv(process.env.DEPLOYED_AWS_ACCESS_KEY_ID);
  const secretAccessKey = trimEnv(process.env.DEPLOYED_AWS_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }
  const sessionToken = trimEnv(process.env.DEPLOYED_AWS_SESSION_TOKEN);
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function buildRuntime(opts: {
  s3Uri: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentialRole: "default" | "deployed";
}): S3Runtime {
  const parsedS3Location = parseS3Uri(opts.s3Uri);
  const s3Client = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint || undefined,
    forcePathStyle: opts.forcePathStyle,
    credentials: getAwsCredentialOptions(opts.credentialRole),
  });

  return {
    parsedS3Location,
    s3Client,
    region: opts.region,
    endpoint: opts.endpoint || undefined,
  };
}

function getPrimaryRuntimeConfig(): S3Runtime | null {
  const s3Uri = trimEnv(process.env.LOCAL_S3_URI) || trimEnv(process.env.S3_URI);
  const awsRegion =
    trimEnv(process.env.AWS_REGION) || trimEnv(process.env.AWS_DEFAULT_REGION) || "us-east-1";
  const s3Endpoint = trimEnv(process.env.S3_ENDPOINT);
  const forcePathStyle = trimEnv(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === "true";
  if (!s3Uri) {
    return null;
  }

  try {
    return buildRuntime({
      s3Uri,
      region: awsRegion,
      endpoint: s3Endpoint || undefined,
      forcePathStyle,
      credentialRole: "default",
    });
  } catch {
    return null;
  }
}

function getDeployedRuntimeConfig(): S3Runtime | null {
  const s3Uri = trimEnv(process.env.S3_URI);
  if (!s3Uri) {
    return null;
  }
  const awsRegion =
    trimEnv(process.env.DEPLOYED_AWS_REGION) ||
    trimEnv(process.env.AWS_REGION) ||
    trimEnv(process.env.AWS_DEFAULT_REGION) ||
    "us-east-1";
  const s3Endpoint =
    trimEnv(process.env.DEPLOYED_S3_ENDPOINT) || trimEnv(process.env.S3_ENDPOINT) || undefined;
  const deployForceRaw = trimEnv(process.env.DEPLOYED_S3_FORCE_PATH_STYLE);
  const deployForce =
    deployForceRaw.toLowerCase() === "true" ||
    ((!deployForceRaw || deployForceRaw === "") &&
      trimEnv(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === "true");

  try {
    return buildRuntime({
      s3Uri,
      region: awsRegion,
      endpoint: s3Endpoint,
      forcePathStyle: deployForce,
      credentialRole: "deployed",
    });
  } catch {
    return null;
  }
}

function joinS3KeyParts(parts: string[]) {
  return parts
    .map((part) => part.trim().replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean)
    .join("/");
}

export function runtimeToStatus(role: "primary" | "deployed", runtime: S3Runtime | null): S3ConnectionStatus {
  if (!runtime) {
    const reason =
      role === "deployed"
        ? "S3_URI is not configured"
        : "(LOCAL_)S3_URI is not configured";
    return {
      enabled: false,
      reason,
    };
  }

  const { parsedS3Location } = runtime;
  return {
    enabled: true,
    bucket: parsedS3Location.bucket,
    keyPrefix: parsedS3Location.keyPrefix,
    region: runtime.region,
    endpoint: runtime.endpoint,
  };
}

export function getS3EnvironmentHealth(): S3EnvironmentHealth {
  const primaryRuntime = getPrimaryRuntimeConfig();
  const deployedRuntime = getDeployedRuntimeConfig();
  const primary = runtimeToStatus("primary", primaryRuntime);
  const deployed = runtimeToStatus("deployed", deployedRuntime);
  let syncTarget: "primary" | "deployed" | "none";
  if (deployed.enabled) {
    syncTarget = "deployed";
  } else if (primary.enabled) {
    syncTarget = "primary";
  } else {
    syncTarget = "none";
  }

  return { primary, deployed, syncTarget };
}

/** Flat status: prefer primary bucket if configured, else deployed-only. */
export function getS3ConnectionStatus(): S3ConnectionStatus {
  const env = getS3EnvironmentHealth();
  if (env.primary.enabled) {
    return env.primary;
  }
  if (env.deployed.enabled) {
    return env.deployed;
  }
  return {
    enabled: false,
    reason: "(LOCAL_)S3_URI and S3_URI are not configured",
  };
}

function runtimesAreSamePhysical(a: S3Runtime, b: S3Runtime) {
  return (
    a.parsedS3Location.bucket === b.parsedS3Location.bucket &&
    a.parsedS3Location.keyPrefix === b.parsedS3Location.keyPrefix &&
    (a.endpoint || "") === (b.endpoint || "") &&
    a.region === b.region
  );
}

function buildObjectKey(runtime: S3Runtime, params: { keyPrefixes?: string[]; filename: string }) {
  return joinS3KeyParts([
    runtime.parsedS3Location.keyPrefix,
    ...(params.keyPrefixes ?? []),
    params.filename,
  ]);
}

async function sendPutObject(
  runtime: S3Runtime,
  params: {
    buffer: Buffer;
    filename: string;
    keyPrefixes?: string[];
    contentType?: string;
  },
): Promise<S3PutResult> {
  const Key = buildObjectKey(runtime, params);
  await runtime.s3Client.send(
    new PutObjectCommand({
      Bucket: runtime.parsedS3Location.bucket,
      Key,
      Body: params.buffer,
      ContentType: params.contentType || undefined,
    }),
  );
  return {
    bucket: runtime.parsedS3Location.bucket,
    key: Key,
    uri: `s3://${runtime.parsedS3Location.bucket}/${Key}`,
  };
}

async function sendDeleteObject(
  runtime: S3Runtime,
  params: { filename: string; keyPrefixes?: string[] },
) {
  const Key = buildObjectKey(runtime, params);
  await runtime.s3Client.send(
    new DeleteObjectCommand({
      Bucket: runtime.parsedS3Location.bucket,
      Key,
    }),
  );
  return {
    bucket: runtime.parsedS3Location.bucket,
    key: Key,
  };
}

async function headObjectExists(runtime: S3Runtime, key: string) {
  try {
    await runtime.s3Client.send(
      new HeadObjectCommand({
        Bucket: runtime.parsedS3Location.bucket,
        Key: key,
      }),
    );
    return true;
  } catch (error: unknown) {
    const statusCode =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
    const name =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: string }).name)
        : "";
    if (statusCode === 404 || name === "NotFound") {
      return false;
    }
    throw error;
  }
}

function parseS3ObjectUri(uri: string): { bucket: string; key: string } | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("s3://")) {
    return null;
  }
  try {
    const u = new URL(trimmed.replace(/^s3:/, "http:"));
    const bucket = u.hostname;
    const key = u.pathname.replace(/^\/+/, "");
    if (!bucket || !key) {
      return null;
    }
    return { bucket, key };
  } catch {
    return null;
  }
}

async function readS3ObjectBuffer(runtime: S3Runtime, key: string): Promise<Buffer> {
  const response = await runtime.s3Client.send(
    new GetObjectCommand({
      Bucket: runtime.parsedS3Location.bucket,
      Key: key,
    }),
  );
  const body = response.Body;
  if (!body) {
    throw new Error("S3 GetObject returned empty body");
  }
  const transform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transform.transformToByteArray === "function") {
    const bytes = await transform.transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function uniqueS3Runtimes(...candidates: Array<S3Runtime | null | undefined>): S3Runtime[] {
  const out: S3Runtime[] = [];
  for (const r of candidates) {
    if (!r) continue;
    if (!out.some((o) => runtimesAreSamePhysical(o, r))) {
      out.push(r);
    }
  }
  return out;
}

/**
 * Load prediction image bytes from S3 only (by stored URI or by filename under pending/NRDR/RDR).
 */
export async function downloadPredictionImageBuffer(params: {
  imageStorageUri?: string | null;
  filename: string;
}): Promise<Buffer> {
  const { imageStorageUri, filename } = params;
  if (!filename) {
    throw new Error("Image filename is required");
  }

  const parsed = imageStorageUri ? parseS3ObjectUri(imageStorageUri) : null;
  if (parsed) {
    const candidates = uniqueS3Runtimes(
      getDeployedRuntimeConfig(),
      getPrimaryRuntimeConfig(),
      getSyncTargetRuntime(),
    );
    for (const runtime of candidates) {
      if (runtime.parsedS3Location.bucket !== parsed.bucket) {
        continue;
      }
      try {
        return await readS3ObjectBuffer(runtime, parsed.key);
      } catch (error) {
        console.error(
          "S3 GetObject by URI failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }
    throw new Error(`S3 object not readable: ${imageStorageUri}`);
  }

  const runtimes = uniqueS3Runtimes(
    getSyncTargetRuntime(),
    getDeployedRuntimeConfig(),
    getPrimaryRuntimeConfig(),
  );
  if (runtimes.length === 0) {
    throw new Error("S3 is not configured");
  }

  for (const runtime of runtimes) {
    for (const prefix of ["pending", "NRDR", "RDR"]) {
      const key = buildObjectKey(runtime, { filename, keyPrefixes: [prefix] });
      if (await headObjectExists(runtime, key)) {
        return await readS3ObjectBuffer(runtime, key);
      }
    }
  }

  throw new Error(`Image not found in S3 for filename: ${filename}`);
}

export async function uploadImageToS3(params: {
  buffer: Buffer;
  filename: string;
  keyPrefixes?: string[];
  contentType?: string;
}) {
  const primary = getPrimaryRuntimeConfig();
  const deployed = getDeployedRuntimeConfig();

  if (!primary && !deployed) {
    return null;
  }

  let primaryResult: S3PutResult | null = null;
  let deployedResult: S3PutResult | null = null;

  if (primary) {
    try {
      primaryResult = await sendPutObject(primary, params);
    } catch (error) {
      console.error(
        "Primary S3 upload failed:",
        error instanceof Error ? error.message : "Unknown S3 error",
      );
    }
  }

  if (deployed) {
    const skipDuplicate = primary && runtimesAreSamePhysical(primary, deployed);
    if (!skipDuplicate) {
      try {
        deployedResult = await sendPutObject(deployed, params);
      } catch (error) {
        console.error(
          "Deployed S3 upload failed (will retry on sync):",
          error instanceof Error ? error.message : "Unknown S3 error",
        );
      }
    } else if (primaryResult) {
      deployedResult = primaryResult;
    }
  }

  return deployedResult ?? primaryResult;
}

export async function deleteImageFromS3(params: {
  filename: string;
  keyPrefixes?: string[];
}) {
  const primary = getPrimaryRuntimeConfig();
  const deployed = getDeployedRuntimeConfig();
  if (!primary && !deployed) {
    return null;
  }

  const runDelete = async (runtime: S3Runtime) => {
    try {
      return await sendDeleteObject(runtime, params);
    } catch (error) {
      console.error(
        "S3 delete failed:",
        error instanceof Error ? error.message : "Unknown S3 error",
      );
      return null;
    }
  };

  let last: { bucket: string; key: string } | null = null;
  if (primary) {
    last = (await runDelete(primary)) ?? last;
  }
  if (deployed && (!primary || !runtimesAreSamePhysical(primary, deployed))) {
    last = (await runDelete(deployed)) ?? last;
  }

  return last;
}

function getSyncTargetRuntime(): S3Runtime | null {
  const deployed = getDeployedRuntimeConfig();
  if (deployed) {
    return deployed;
  }
  return getPrimaryRuntimeConfig();
}

function guessContentTypeFromFilename(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return undefined;
}

async function listFlatImageFilenames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function verifyS3Connectivity(): Promise<S3EnvironmentHealth> {
  const health = getS3EnvironmentHealth();
  const primary = getPrimaryRuntimeConfig();
  const deployed = getDeployedRuntimeConfig();

  if (primary) {
    await primary.s3Client.send(
      new HeadBucketCommand({ Bucket: primary.parsedS3Location.bucket }),
    );
  }
  if (deployed && (!primary || !runtimesAreSamePhysical(primary, deployed))) {
    await deployed.s3Client.send(
      new HeadBucketCommand({ Bucket: deployed.parsedS3Location.bucket }),
    );
  }

  return health;
}

export async function synchronizeS3ImagesFromDisk(params: {
  uploadsDir: string;
  imagesNrdrDir: string;
  imagesRdrDir: string;
  batchLimit: number;
}): Promise<SynchronizeS3DiskResult | null> {
  const target = getSyncTargetRuntime();
  if (!target) {
    return null;
  }
  if (isS3DiskSyncInProgress) {
    return null;
  }

  isS3DiskSyncInProgress = true;
  const startedAt = new Date().toISOString();
  const targetLabel: "deployed" | "primary" = getDeployedRuntimeConfig() ? "deployed" : "primary";

  let uploaded = 0;
  let skippedExisting = 0;
  let scanned = 0;
  const errors: Array<{ key: string; message: string }> = [];
  let budget = Math.max(0, params.batchLimit);

  const roots: Array<{ dir: string; prefix: string }> = [
    { dir: params.uploadsDir, prefix: "pending" },
    { dir: params.imagesNrdrDir, prefix: "NRDR" },
    { dir: params.imagesRdrDir, prefix: "RDR" },
  ];

  try {
    for (const { dir, prefix } of roots) {
      if (budget <= 0) {
        break;
      }
      const names = await listFlatImageFilenames(dir);
      for (const filename of names) {
        if (budget <= 0) {
          break;
        }
        scanned += 1;
        const key = buildObjectKey(target, { keyPrefixes: [prefix], filename });
        try {
          const exists = await headObjectExists(target, key);
          if (exists) {
            skippedExisting += 1;
            continue;
          }
          const abs = path.join(dir, filename);
          const buffer = await fs.readFile(abs);
          const contentType = guessContentTypeFromFilename(filename);
          await target.s3Client.send(
            new PutObjectCommand({
              Bucket: target.parsedS3Location.bucket,
              Key: key,
              Body: buffer,
              ContentType: contentType,
            }),
          );
          uploaded += 1;
          budget -= 1;
        } catch (error) {
          errors.push({
            key,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    return {
      startedAt,
      endedAt: new Date().toISOString(),
      target: targetLabel,
      uploaded,
      skippedExisting,
      scanned,
      errors,
    };
  } finally {
    isS3DiskSyncInProgress = false;
  }
}

function parseS3ObjectLocation(uri: string): { bucket: string; key: string } | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "s3:") {
      return null;
    }
    const bucket = parsed.hostname.trim();
    const key = parsed.pathname.replace(/^\/+/, "");
    if (!bucket || !key) {
      return null;
    }
    return { bucket, key };
  } catch {
    return null;
  }
}

function getRuntimeForObjectBucket(bucket: string): S3Runtime | null {
  const deployed = getDeployedRuntimeConfig();
  const primary = getPrimaryRuntimeConfig();
  if (deployed?.parsedS3Location.bucket === bucket) {
    return deployed;
  }
  if (primary?.parsedS3Location.bucket === bucket) {
    return primary;
  }
  return null;
}

function getAnyS3RuntimeForGetObject(): S3Runtime | null {
  return getPrimaryRuntimeConfig() ?? getDeployedRuntimeConfig();
}

/**
 * Download a full object (e.g. ONNX weights) from S3. Uses the same clients/credentials as image storage.
 */
export async function downloadBytesFromS3ObjectUri(objectUri: string): Promise<Buffer> {
  const loc = parseS3ObjectLocation(objectUri.trim());
  if (!loc || !loc.key) {
    throw new Error(
      "MODEL_S3_URI must be a full object URI including key, e.g. s3://my-bucket/models/best.onnx",
    );
  }
  const runtime = getRuntimeForObjectBucket(loc.bucket) ?? getAnyS3RuntimeForGetObject();
  if (!runtime) {
    throw new Error(
      "Cannot load model from S3: set S3_URI (or LOCAL_S3_URI) and AWS credentials so GetObject is allowed.",
    );
  }
  const out = await runtime.s3Client.send(
    new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }),
  );
  if (!out.Body) {
    throw new Error("S3 GetObject returned an empty body for the model object");
  }
  return Buffer.from(await out.Body.transformToByteArray());
}

/**
 * Turn s3://bucket/key into a time-limited HTTPS URL for use in browsers (img src, etc.).
 */
export async function presignS3ObjectReadUrl(
  s3Uri: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const loc = parseS3ObjectLocation(s3Uri);
  if (!loc) {
    return null;
  }
  const runtime = getRuntimeForObjectBucket(loc.bucket);
  if (!runtime) {
    console.warn("presignS3ObjectReadUrl: no S3 client configured for bucket", loc.bucket);
    return null;
  }
  try {
    const command = new GetObjectCommand({
      Bucket: loc.bucket,
      Key: loc.key,
    });
    return await getSignedUrl(runtime.s3Client, command, { expiresIn: expiresInSeconds });
  } catch (error) {
    console.error(
      "presignS3ObjectReadUrl failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
