import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

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
