import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import pg from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  deleteImageFromS3,
  downloadBytesFromS3ObjectUri,
  getS3EnvironmentHealth,
  presignS3ObjectReadUrl,
  downloadPredictionImageBuffer,
  uploadImageToS3,
  verifyS3Connectivity,
} from "./s3.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const PRESIGNED_IMAGE_URL_TTL_SECONDS = Math.max(
  60,
  Number(process.env.PRESIGNED_IMAGE_URL_TTL_SECONDS || 3600) || 3600,
);
const explicitDatabaseUrl = (process.env.DATABASE_URL || "").trim();
const localDatabaseUrl = (process.env.LOCAL_DATABASE_URL || "").trim();
const deployedDatabaseUrl = (process.env.DEPLOYED_DATABASE_URL || "").trim();

/** True when host is loopback — unusable from Docker for Postgres on the host machine. */
function postgresUrlLooksLikeLoopback(url: string): boolean {
  if (!url) return false;
  return (
    /@(localhost|127\.0\.0\.1)\b/i.test(url) ||
    /[?&]host=(localhost|127\.0\.0\.1)\b/i.test(url)
  );
}

function resolvePrimaryDatabaseUrl(): string {
  if (explicitDatabaseUrl) {
    if (postgresUrlLooksLikeLoopback(explicitDatabaseUrl) && deployedDatabaseUrl) {
      return deployedDatabaseUrl;
    }
    return explicitDatabaseUrl;
  }
  if (localDatabaseUrl && !postgresUrlLooksLikeLoopback(localDatabaseUrl)) {
    return localDatabaseUrl;
  }
  if (deployedDatabaseUrl) {
    return deployedDatabaseUrl;
  }
  return localDatabaseUrl;
}

const DATABASE_URL = resolvePrimaryDatabaseUrl();
const DEPLOYED_DATABASE_URL = deployedDatabaseUrl;

if (
  deployedDatabaseUrl &&
  DATABASE_URL === deployedDatabaseUrl &&
  ((localDatabaseUrl && postgresUrlLooksLikeLoopback(localDatabaseUrl)) ||
    (explicitDatabaseUrl && postgresUrlLooksLikeLoopback(explicitDatabaseUrl)))
) {
  console.log(
    "Primary DB: using DEPLOYED_DATABASE_URL (DATABASE_URL / LOCAL_DATABASE_URL use loopback and are not reachable from this runtime).",
  );
}
/** Ephemeral TensorRT runner input only (not used for storing prediction images). */
const TENSORRT_WORK_DIR = tmpdir();
const MODEL_ENGINE_PATH = path.resolve(
  process.cwd(),
  process.env.MODEL_ENGINE_PATH || "best.engine",
);
const MODEL_ONNX_PATH = path.resolve(
  process.cwd(),
  process.env.MODEL_ONNX_PATH || "best.onnx",
);
/** Required: ONNX session is built from bytes loaded from this S3 object (in memory). TensorRT engine is not used. */
const MODEL_S3_URI = (process.env.MODEL_S3_URI || "").trim();
const TENSORRT_RUNNER_PATH = path.resolve(
  process.cwd(),
  process.env.TENSORRT_RUNNER_PATH || "tensorrt_inference.py",
);
const MODEL_INPUT_SIZE = Number(process.env.MODEL_INPUT_SIZE || 256);
const MODEL_CLASS_LABELS = (
  process.env.MODEL_CLASS_LABELS || "Nrdr,Rdr"
)
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
const MODEL_NORMALIZATION = (process.env.MODEL_NORMALIZATION || "none").toLowerCase();
const MODEL_OUTPUT_KIND = (process.env.MODEL_OUTPUT_KIND || "auto").toLowerCase();
const MODEL_CONFIDENCE_THRESHOLD = Number(process.env.MODEL_CONFIDENCE_THRESHOLD || 0.5);
const ALLOW_ONNX_FALLBACK = (process.env.ALLOW_ONNX_FALLBACK || "true").toLowerCase() !== "false";
const DATABASE_SSL = (process.env.DATABASE_SSL || "").toLowerCase();
const SHOULD_USE_DATABASE_SSL =
  DATABASE_SSL === "true" ||
  DATABASE_SSL === "require" ||
  DATABASE_URL.includes("sslmode=require") ||
  DATABASE_URL.includes("amazonaws.com");
const DEPLOYED_DATABASE_SSL = (process.env.DEPLOYED_DATABASE_SSL || "").toLowerCase();
const SHOULD_USE_DEPLOYED_DATABASE_SSL =
  DEPLOYED_DATABASE_SSL === "true" ||
  DEPLOYED_DATABASE_SSL === "require" ||
  DEPLOYED_DATABASE_URL.includes("sslmode=require") ||
  DEPLOYED_DATABASE_URL.includes("amazonaws.com");
const DB_SYNC_INTERVAL_MS = Number(process.env.DB_SYNC_INTERVAL_MS || 60000);
const DB_SYNC_BATCH_SIZE = Number(process.env.DB_SYNC_BATCH_SIZE || 100);
const S3_SYNC_INTERVAL_MS = Number(process.env.S3_SYNC_INTERVAL_MS || 60000);
const S3_SYNC_BATCH_SIZE = Number(process.env.S3_SYNC_BATCH_SIZE || 50);
const ALLOWED_ORIGINS = (
  process.env.FRONTEND_URL || "http://localhost:3000,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const { Pool } = pg;
const localPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: SHOULD_USE_DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

/** Some schemas use `review_status_val`; others only have `review_status`. */
type PredictionsReviewStatusColumnName = "review_status_val" | "review_status";
let cachedPredictionsReviewStatusColumn: PredictionsReviewStatusColumnName | null = null;

async function getPredictionsReviewStatusColumn(): Promise<PredictionsReviewStatusColumnName> {
  if (cachedPredictionsReviewStatusColumn) {
    return cachedPredictionsReviewStatusColumn;
  }
  if (!DATABASE_URL) {
    cachedPredictionsReviewStatusColumn = "review_status_val";
    return cachedPredictionsReviewStatusColumn;
  }
  const { rows } = await localPool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'predictions'
        AND column_name IN ('review_status_val', 'review_status')
    `,
  );
  const names = new Set(rows.map((r) => r.column_name));
  if (names.has("review_status_val")) {
    cachedPredictionsReviewStatusColumn = "review_status_val";
  } else if (names.has("review_status")) {
    cachedPredictionsReviewStatusColumn = "review_status";
    console.log(
      "Using column predictions.review_status (review_status_val not present). Matches many legacy / RDS schemas.",
    );
  } else {
    cachedPredictionsReviewStatusColumn = "review_status_val";
    console.warn(
      "predictions: neither review_status_val nor review_status found in information_schema; defaulting to review_status_val.",
    );
  }
  return cachedPredictionsReviewStatusColumn;
}

const deployedPool = DEPLOYED_DATABASE_URL
  ? new Pool({
      connectionString: DEPLOYED_DATABASE_URL,
      ssl: SHOULD_USE_DEPLOYED_DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    })
  : null;

void (async () => {
  if (!DATABASE_URL) {
    console.warn(
      "DATABASE_URL / LOCAL_DATABASE_URL / DEPLOYED_DATABASE_URL is not configured. Starting backend in degraded mode without primary database connectivity.",
    );
  } else {
    try {
      const dbResult = await localPool.query("SELECT 1");
      if (dbResult.rowCount !== null) {
        console.log("Primary database connected successfully.");
      }
    } catch (dbError) {
      console.error(
        "Primary database connection check failed. Backend will continue running in degraded mode:",
        dbError instanceof Error ? dbError.message : "Unknown database error",
      );
    }
  }

  if (!deployedPool) {
    console.warn(
      "DEPLOYED_DATABASE_URL is not configured. Remote synchronization is disabled.",
    );
  } else {
    try {
      const remoteDbResult = await deployedPool.query("SELECT 1");
      if (remoteDbResult.rowCount !== null) {
        console.log("Deployed database connected successfully.");
      }
    } catch (dbError) {
      console.error(
        "Deployed database connection check failed. Sync will retry on interval:",
        dbError instanceof Error ? dbError.message : "Unknown database error",
      );
    }
  }

  try {
    const s3Status = await verifyS3Connectivity();
    console.log("S3 connection check", s3Status);
  } catch (s3Error) {
    console.error(
      "S3 connection check failed. Backend will continue running:",
      s3Error instanceof Error ? s3Error.message : "Unknown S3 error",
    );
  }

  try {
    const modelAvailability = await getModelAvailability();
    console.log("Model availability check", modelAvailability);
  } catch (modelError) {
    console.error(
      "Model availability check failed:",
      modelError instanceof Error ? modelError.message : "Unknown model error",
    );
  }
})();

async function getDatabaseConnectionState() {
  if (!DATABASE_URL) {
    return "not_configured" as const;
  }

  try {
    const dbResult = await localPool.query("SELECT 1");
    if (dbResult.rowCount !== null) {
      return "connected" as const;
    }
    return "disconnected" as const;
  } catch {
    return "disconnected" as const;
  }
}

async function getDeployedDatabaseConnectionState() {
  if (!deployedPool) {
    return "not_configured" as const;
  }

  try {
    const dbResult = await deployedPool.query("SELECT 1");
    if (dbResult.rowCount !== null) {
      return "connected" as const;
    }
    return "disconnected" as const;
  } catch {
    return "disconnected" as const;
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/jpg"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG and PNG images are allowed"));
    }
  },
});

interface DbUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  role: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface PredictionHistoryRow {
  prediction_id: string;
  patient_id: string;
  patient_name: string;
  cnic: string;
  phone: string;
  image_data_url: string | null;
  image_filename?: string | null;
  mime_type?: string | null;
  severity: string;
  screening_outcome: "NRDR" | "RDR" | null;
  confidence: string;
  recommendation: string | null;
  model_version: string | null;
  jetson_inference_time: number | null;
  created_at: string;
  review_status: "pending" | "accepted" | "rejected";
  clinician_comment: string | null;
  reviewed_at: string | null;
}

interface AuthRequest extends Request {
  userId?: string;
  user?: DbUserRow;
  file?: Express.Multer.File;
}

interface LocalInferenceResult {
  predictedLabel: string;
  confidence: number;
  recommendation: string;
  modelVersion: string;
}

function mapUserForResponse(user: DbUserRow) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.full_name || user.username,
    role: user.role,
  };
}

const ALLOW_LEGACY_PLAINTEXT_PASSWORD =
  (process.env.ALLOW_LEGACY_PLAINTEXT_PASSWORD || "").toLowerCase() === "true";

/** bcrypt hashes start with $2a$ / $2b$ / $2y$; optional plaintext match when ALLOW_LEGACY_PLAINTEXT_PASSWORD=true. */
async function verifyStoredPassword(plain: string, stored: string): Promise<boolean> {
  const s = (stored || "").trim();
  if (!s) return false;
  if (/^\$2[aby]\$\d{2}\$/.test(s)) {
    try {
      return await bcryptjs.compare(plain, s);
    } catch {
      return false;
    }
  }
  if (ALLOW_LEGACY_PLAINTEXT_PASSWORD && plain === s) {
    return true;
  }
  return false;
}

async function resolveBrowserImageUrl(
  uri: string | null | undefined,
): Promise<string | undefined> {
  if (uri == null) {
    return undefined;
  }
  const trimmed = uri.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) {
    return trimmed;
  }
  if (trimmed.startsWith("s3://")) {
    const signed = await presignS3ObjectReadUrl(trimmed, PRESIGNED_IMAGE_URL_TTL_SECONDS);
    return signed ?? undefined;
  }
  return trimmed;
}

async function mapPredictionForResponse(row: PredictionHistoryRow) {
  const image_data_url = await resolveBrowserImageUrl(row.image_data_url);
  return {
    prediction_id: row.prediction_id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    cnic: row.cnic,
    phone: row.phone,
    image_data_url,
    severity: row.severity,
    screening_outcome: row.screening_outcome ?? undefined,
    confidence: Number(row.confidence),
    recommendation: row.recommendation ?? "",
    model_version: row.model_version ?? "",
    jetson_inference_time: row.jetson_inference_time ?? 0,
    created_at: row.created_at,
    review_status: row.review_status,
    clinician_comment: row.clinician_comment ?? undefined,
    reviewed_at: row.reviewed_at,
  };
}

type SyncTableName = "users" | "patients" | "predictions";

interface SyncTableResult {
  table: SyncTableName;
  syncedCount: number;
  localMaxSerial: number;
  deployedMaxSerialBefore: number;
  deployedMaxSerialAfter: number;
}

interface SyncRunResult {
  startedAt: string;
  endedAt: string;
  tables: SyncTableResult[];
}

const SYNC_TABLE_ORDER: SyncTableName[] = ["users", "patients", "predictions"];
let isSyncInProgress = false;

async function getTableColumns(pool: pg.Pool, tableName: SyncTableName) {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

async function getTableMaxSerial(pool: pg.Pool, tableName: SyncTableName) {
  const result = await pool.query<{ max_serial: string | null }>(
    `SELECT COALESCE(MAX(serial_number), 0)::text AS max_serial FROM ${tableName}`,
  );
  return Number(result.rows[0]?.max_serial ?? 0);
}

/** GENERATED ALWAYS AS IDENTITY rejects explicit serial_number unless OVERRIDING SYSTEM VALUE. */
async function deployedSerialNumberIsAlwaysIdentity(tableName: SyncTableName) {
  if (!deployedPool) {
    return false;
  }
  const result = await deployedPool.query<{
    is_identity: string;
    identity_generation: string | null;
  }>(
    `
      SELECT is_identity, identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'serial_number'
    `,
    [tableName],
  );
  const row = result.rows[0];
  return row?.is_identity === "YES" && row?.identity_generation === "ALWAYS";
}

async function syncSingleTable(tableName: SyncTableName): Promise<SyncTableResult> {
  if (!deployedPool) {
    throw new Error("Deployed pool is not configured");
  }

  const [localColumns, deployedColumns] = await Promise.all([
    getTableColumns(localPool, tableName),
    getTableColumns(deployedPool, tableName),
  ]);
  const sharedColumns = localColumns.filter((column) => deployedColumns.includes(column));

  if (!sharedColumns.includes("serial_number")) {
    throw new Error(`Table ${tableName} is missing serial_number in one of the databases`);
  }

  const useIdentityOverride = await deployedSerialNumberIsAlwaysIdentity(tableName);

  const localMaxSerial = await getTableMaxSerial(localPool, tableName);
  const deployedMaxSerialBefore = await getTableMaxSerial(deployedPool, tableName);

  if (localMaxSerial <= deployedMaxSerialBefore) {
    return {
      table: tableName,
      syncedCount: 0,
      localMaxSerial,
      deployedMaxSerialBefore,
      deployedMaxSerialAfter: deployedMaxSerialBefore,
    };
  }

  const selectColumns = sharedColumns.map((column) => `"${column}"`).join(", ");
  const localRows = await localPool.query<Record<string, unknown>>(
    `
      SELECT ${selectColumns}
      FROM ${tableName}
      WHERE serial_number > $1
      ORDER BY serial_number ASC
      LIMIT $2
    `,
    [deployedMaxSerialBefore, DB_SYNC_BATCH_SIZE],
  );

  let syncedCount = 0;
  for (const row of localRows.rows) {
    const values = sharedColumns.map((column) => row[column]);
    const serialNumber = row.serial_number;
    const valuesWithSerialCheck = [...values, serialNumber];
    const insertPlaceholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const insertColumns = sharedColumns.map((column) => `"${column}"`).join(", ");
    const serialExistsPlaceholder = `$${valuesWithSerialCheck.length}`;

    const insertSql = useIdentityOverride
      ? `
        INSERT INTO ${tableName} (${insertColumns})
        OVERRIDING SYSTEM VALUE
        SELECT ${insertPlaceholders}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${tableName}
          WHERE serial_number = ${serialExistsPlaceholder}
        )
      `
      : `
        INSERT INTO ${tableName} (${insertColumns})
        SELECT ${insertPlaceholders}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${tableName}
          WHERE serial_number = ${serialExistsPlaceholder}
        )
      `;

    const insertResult = await deployedPool.query(insertSql, valuesWithSerialCheck);
    syncedCount += insertResult.rowCount ?? 0;
  }

  const deployedMaxSerialAfter = await getTableMaxSerial(deployedPool, tableName);
  return {
    table: tableName,
    syncedCount,
    localMaxSerial,
    deployedMaxSerialBefore,
    deployedMaxSerialAfter,
  };
}

async function synchronizeDatabases(): Promise<SyncRunResult | null> {
  if (!deployedPool || isSyncInProgress) {
    return null;
  }

  isSyncInProgress = true;
  const startedAt = new Date().toISOString();

  try {
    const tableResults: SyncTableResult[] = [];
    for (const tableName of SYNC_TABLE_ORDER) {
      const result = await syncSingleTable(tableName);
      tableResults.push(result);
    }

    return {
      startedAt,
      endedAt: new Date().toISOString(),
      tables: tableResults,
    };
  } finally {
    isSyncInProgress = false;
  }
}

/**
 * Reviewed image S3 prefix: referable bucket when model RDR is accepted, or model NRDR is rejected
 * (clinician upgrades to referable). Otherwise non-referable bucket.
 */
function getReviewedImageSubfolder(
  predictedOutcome: "NRDR" | "RDR",
  action: "accepted" | "rejected",
): "NRDR" | "RDR" {
  const referable =
    (predictedOutcome === "RDR" && action === "accepted") ||
    (predictedOutcome === "NRDR" && action === "rejected");
  return referable ? "RDR" : "NRDR";
}

function normalizeScreeningOutcome(value: string | null | undefined): "NRDR" | "RDR" | null {
  if (value == null) return null;
  const u = String(value).trim().toUpperCase();
  if (u === "NRDR") return "NRDR";
  if (u === "RDR") return "RDR";
  return null;
}

let modelSessionPromise: Promise<unknown> | null = null;
let selectedInferenceBackend: "engine" | "onnx" = "onnx";

type OrtModuleShape = {
  InferenceSession: {
    create: (modelPath: string | Uint8Array) => Promise<unknown>;
  };
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: [number, number, number, number],
  ) => unknown;
};

async function getOrtModule() {
  const ortLib = await import("onnxruntime-node");
  const ort = (ortLib.default ?? ortLib) as Partial<OrtModuleShape>;

  if (!ort.InferenceSession || !ort.Tensor) {
    throw new Error(
      "onnxruntime-node module missing InferenceSession/Tensor exports",
    );
  }

  return ort as OrtModuleShape;
}

function getModelSession() {
  if (!modelSessionPromise) {
    modelSessionPromise = getOrtModule().then(async (ort) => {
      if (MODEL_S3_URI) {
        const bytes = await downloadBytesFromS3ObjectUri(MODEL_S3_URI);
        return ort.InferenceSession.create(new Uint8Array(bytes));
      }
      return ort.InferenceSession.create(MODEL_ONNX_PATH);
    });
  }
  return modelSessionPromise;
}

function softmax(values: number[]) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

function normalizeOutput(rawValues: number[]) {
  if (MODEL_OUTPUT_KIND === "logits") {
    return softmax(rawValues);
  }
  if (MODEL_OUTPUT_KIND === "probs") {
    return rawValues;
  }
  const isProbLike =
    Math.max(...rawValues) <= 1 &&
    Math.min(...rawValues) >= 0 &&
    Math.abs(rawValues.reduce((sum, value) => sum + value, 0) - 1) < 1e-3;
  return isProbLike ? rawValues : softmax(rawValues);
}

async function checkFileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getModelAvailability() {
  const [engineExists, onnxFileExists, runnerExists] = await Promise.all([
    checkFileExists(MODEL_ENGINE_PATH),
    checkFileExists(MODEL_ONNX_PATH),
    checkFileExists(TENSORRT_RUNNER_PATH),
  ]);

  const onnxExists = MODEL_S3_URI ? true : onnxFileExists;

  const selectedBackend = MODEL_S3_URI
    ? "onnx"
    : engineExists && runnerExists
      ? "engine"
      : onnxFileExists
        ? "onnx"
        : "unavailable";

  return {
    engineExists,
    onnxExists,
    tensorRtRunnerExists: runnerExists,
    selectedBackend,
    inference_uses_s3_model_uri: Boolean(MODEL_S3_URI),
  };
}

async function resolveInferenceBackend() {
  if (MODEL_S3_URI) {
    selectedInferenceBackend = "onnx";
    return "onnx";
  }
  const availability = await getModelAvailability();
  if (availability.engineExists && availability.tensorRtRunnerExists) {
    selectedInferenceBackend = "engine";
  } else {
    selectedInferenceBackend = "onnx";
    if (availability.engineExists && !availability.tensorRtRunnerExists) {
      console.warn(
        `Engine file found at ${MODEL_ENGINE_PATH}, but TensorRT runner is missing at ${TENSORRT_RUNNER_PATH}. Falling back to ONNX.`,
      );
    }
  }
  return selectedInferenceBackend;
}

async function runTensorRtInference(imageBuffer: Buffer): Promise<LocalInferenceResult> {
  const tempFilename = `${Date.now()}-${randomUUID()}.jpg`;
  const tempImagePath = path.join(TENSORRT_WORK_DIR, tempFilename);
  await fs.writeFile(tempImagePath, imageBuffer);

  const labelsArg = MODEL_CLASS_LABELS.join(",");
  return await new Promise<LocalInferenceResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(
      "python",
      [
        TENSORRT_RUNNER_PATH,
        "--engine",
        MODEL_ENGINE_PATH,
        "--image",
        tempImagePath,
        "--imgsz",
        String(MODEL_INPUT_SIZE),
        "--labels",
        labelsArg,
      ],
      { cwd: process.cwd() },
    );

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start TensorRT runner: ${error.message}`));
    });

    child.on("close", async (code) => {
      try {
        await fs.unlink(tempImagePath);
      } catch {
        // Best-effort cleanup only.
      }

      if (code !== 0) {
        reject(
          new Error(
            `TensorRT runner exited with code ${code}. ${stderr || stdout || "No details."}`,
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          class: string;
          confidence: number;
          recommendation: string;
          model_version?: string;
        };
        resolve({
          predictedLabel: parsed.class,
          confidence: Number(parsed.confidence),
          recommendation: parsed.recommendation,
          modelVersion: parsed.model_version || "tensorrt-engine-local",
        });
      } catch (error) {
        reject(
          new Error(
            `TensorRT runner output was not valid JSON. ${error instanceof Error ? error.message : "Unknown parse error"}`,
          ),
        );
      }
    });
  });
}

async function preprocessImage(buffer: Buffer) {
  const sharpLib = await import("sharp");
  const sharp = sharpLib.default;
  const resized = await sharp(buffer)
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, {
      fit: "contain",
      position: "center",
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const baseIndex = i * 3;
    const r = resized[baseIndex] / 255;
    const g = resized[baseIndex + 1] / 255;
    const b = resized[baseIndex + 2] / 255;
    if (MODEL_NORMALIZATION === "imagenet") {
      tensor[i] = (r - 0.485) / 0.229;
      tensor[pixelCount + i] = (g - 0.456) / 0.224;
      tensor[pixelCount * 2 + i] = (b - 0.406) / 0.225;
    } else {
      tensor[i] = r;
      tensor[pixelCount + i] = g;
      tensor[pixelCount * 2 + i] = b;
    }
  }

  return tensor;
}

async function runLocalInference(imageBuffer: Buffer) {
  if (!MODEL_S3_URI) {
    const backend = await resolveInferenceBackend();
    if (backend === "engine") {
      try {
        const engineResult = await runTensorRtInference(imageBuffer);
        return engineResult;
      } catch (error) {
        console.error("TensorRT inference failed; switching to ONNX fallback.", {
          message: error instanceof Error ? error.message : "Unknown engine error",
        });
        if (!ALLOW_ONNX_FALLBACK) {
          throw error;
        }
        selectedInferenceBackend = "onnx";
      }
    }
  } else {
    await resolveInferenceBackend();
  }

  const ort = await getOrtModule();
  const session = (await getModelSession()) as {
    inputNames: string[];
    outputNames: string[];
    run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: unknown }>>;
  };
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const inputTensorData = await preprocessImage(imageBuffer);
  const inputTensor = new ort.Tensor("float32", inputTensorData, [
    1,
    3,
    MODEL_INPUT_SIZE,
    MODEL_INPUT_SIZE,
  ]);
  const output = await session.run({ [inputName]: inputTensor });
  const rawOutput = output[outputName]?.data;
  const logits = rawOutput ? Array.from(rawOutput as Iterable<number>) : [];
  if (logits.length === 0) {
    throw new Error("Model returned empty output.");
  }
  const probabilities = normalizeOutput(logits);
  let maxIndex = 0;
  let maxConfidence = probabilities[0] ?? 0;

  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i] > maxConfidence) {
      maxConfidence = probabilities[i];
      maxIndex = i;
    }
  }

  const predictedLabel =
    MODEL_CLASS_LABELS[maxIndex] || MODEL_CLASS_LABELS[0] || "RDR";
  const recommendation =
    maxConfidence < MODEL_CONFIDENCE_THRESHOLD
      ? "Low confidence prediction. Please verify scan quality and review manually."
      : predictedLabel.toLowerCase() === "nrdr"
        ? "No referable diabetic retinopathy. Continue scheduled screening."
        : "Referable diabetic retinopathy suspected. Clinical review is recommended.";

  return {
    predictedLabel,
    confidence: maxConfidence,
    recommendation,
    modelVersion: MODEL_S3_URI ? "onnx-s3-backend" : "onnx-local-backend",
  };
}

async function getUserById(userId: string): Promise<DbUserRow | null> {
  const result = await localPool.query<DbUserRow>(
    `
      SELECT id, username, email, full_name, role, password_hash, created_at, updated_at
      FROM users
      WHERE id = $1
    `,
    [userId],
  );
  return result.rows[0] ?? null;
}

const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    req.userId = user.id;
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

app.get("/healthz", async (_req: Request, res: Response) => {
  const [databaseState, deployedDatabaseState, modelAvailability, s3Connectivity] =
    await Promise.all([
    getDatabaseConnectionState(),
    getDeployedDatabaseConnectionState(),
    getModelAvailability(),
    verifyS3Connectivity().catch(() => getS3EnvironmentHealth()),
    ]);

  await resolveInferenceBackend();
  const isHealthy = databaseState === "connected";
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "healthy" : "degraded",
    backend: "up",
    database: databaseState,
    deployed_database: deployedPool ? deployedDatabaseState : "not_configured",
    sync_interval_ms: DB_SYNC_INTERVAL_MS,
    sync_batch_size: DB_SYNC_BATCH_SIZE,
    s3_sync_interval_ms: S3_SYNC_INTERVAL_MS,
    s3_sync_batch_size: S3_SYNC_BATCH_SIZE,
    inference_backend: selectedInferenceBackend,
    model_availability: modelAvailability,
    model_engine_path: MODEL_ENGINE_PATH,
    model_onnx_path: MODEL_ONNX_PATH,
    model_s3_uri: MODEL_S3_URI || null,
    tensorrt_runner_path: TENSORRT_RUNNER_PATH,
    model_normalization: MODEL_NORMALIZATION,
    model_output_kind: MODEL_OUTPUT_KIND,
    allow_onnx_fallback: ALLOW_ONNX_FALLBACK,
    s3: s3Connectivity,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/auth/register", async (req: Request, res: Response) => {
  try {
    const { username, email, password, name, role } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      name?: string;
      role?: string;
    };

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "Username, email, and password required" });
    }

    if (!DATABASE_URL) {
      return res.status(503).json({
        error: "Database not configured",
        details:
          "Set DATABASE_URL (or LOCAL_DATABASE_URL for host-only dev). Inside Docker, do not use localhost for Postgres on the host — use your cloud URL or host.docker.internal.",
      });
    }

    const existing = await localPool.query(
      `
        SELECT 1
        FROM users
        WHERE username = $1 OR email = $2
      `,
      [username, email],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      return res.status(400).json({ error: "Username or email already exists" });
    }

    const passwordHash = await bcryptjs.hash(password, 10);
    const inserted = await localPool.query<DbUserRow>(
      `
        INSERT INTO users (username, email, full_name, role, password_hash)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, email, full_name, role, password_hash, created_at, updated_at
      `,
      [username, email, name ?? null, role ?? "clinician", passwordHash],
    );

    const user = inserted.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });

    res.status(201).json({
      message: "User registered successfully",
      user: mapUserForResponse(user),
      token,
    });
    void synchronizeDatabases().catch((error) => {
      console.error(
        "Post-register sync attempt failed. Will retry on schedule:",
        error instanceof Error ? error.message : "Unknown sync error",
      );
    });
  } catch (error) {
    console.error("POST /api/auth/register failed:", error);
    res.status(500).json({
      error: "Registration failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username or email and password required" });
    }

    if (!DATABASE_URL) {
      return res.status(503).json({
        error: "Database not configured",
        details:
          "Set DATABASE_URL (or LOCAL_DATABASE_URL for host-only dev). Inside Docker, localhost points at the container, not your machine — use your RDS URL or host.docker.internal.",
      });
    }

    const result = await localPool.query<DbUserRow>(
      `
        SELECT id, username, email, full_name, role, password_hash, created_at, updated_at
        FROM users
        WHERE username = $1 OR email = $1
      `,
      [username.trim()],
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatch = await verifyStoredPassword(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "24h" });

    res.json({
      message: "Login successful",
      user: mapUserForResponse(user),
      token,
    });
  } catch (error) {
    console.error("POST /api/auth/login failed:", error);
    res.status(500).json({
      error: "Login failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post(
  "/api/classify",
  authMiddleware,
  upload.single("file"),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      if (!req.userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const patientName =
        typeof req.body.patientName === "string" ? req.body.patientName.trim() : "";
      const cnic = typeof req.body.cnic === "string" ? req.body.cnic.trim() : "";
      const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";

      if (!patientName || !cnic || !phone) {
        return res.status(400).json({
          error: "Patient name, CNIC, and phone are required",
        });
      }

      console.log("Image received for classification", {
        userId: req.userId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        patientName,
        cnic,
        phone,
      });

      const startTime = Date.now();
      const preferredBackend = await resolveInferenceBackend();

      console.log("Starting local classification", {
        backend: preferredBackend,
        enginePath: MODEL_ENGINE_PATH,
        tensorRtRunnerPath: TENSORRT_RUNNER_PATH,
        modelPath: MODEL_ONNX_PATH,
        inputSize: MODEL_INPUT_SIZE,
        normalization: MODEL_NORMALIZATION,
        outputKind: MODEL_OUTPUT_KIND,
        allowOnnxFallback: ALLOW_ONNX_FALLBACK,
      });

      const inference = await runLocalInference(req.file.buffer);
      const inferenceTime = Date.now() - startTime;
      const severity = inference.predictedLabel;
      const confidence = inference.confidence;
      const recommendation = inference.recommendation;
      const model_version = inference.modelVersion;

      const screeningOutcome: "NRDR" | "RDR" =
        severity.toLowerCase() === "nrdr" || severity === "No DR" || severity === "Mild DR"
          ? "NRDR"
          : "RDR";
      console.log("Classification result received", {
        severity,
        screeningOutcome,
        confidence,
        modelVersion: model_version,
        inferenceTimeMs: inferenceTime,
      });
      const fileExtension = path.extname(req.file.originalname) || ".jpg";
      const storedFilename = `${Date.now()}-${randomUUID()}${fileExtension.toLowerCase()}`;

      const s3Put = await uploadImageToS3({
        buffer: req.file.buffer,
        filename: storedFilename,
        keyPrefixes: ["pending"],
        contentType: req.file.mimetype,
      });
      if (!s3Put?.uri) {
        return res.status(503).json({
          error: "S3 upload failed",
          details:
            "Configure S3_URI (and AWS credentials). Prediction images are stored only in S3, not on local disk.",
        });
      }
      const imageStorageUri = s3Put.uri;

      const client = await localPool.connect();
      try {
        await client.query("BEGIN");

        const patientResult = await client.query<{
          id: string;
          full_name: string;
          cnic: string;
          phone: string;
        }>(
          `
            INSERT INTO patients (full_name, cnic, phone, created_by_user_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (cnic)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              phone = EXCLUDED.phone,
              updated_at = NOW()
            RETURNING id, full_name, cnic, phone
          `,
          [patientName, cnic, phone, req.userId],
        );

        const patient = patientResult.rows[0];

        const reviewStatusCol = await getPredictionsReviewStatusColumn();
        const predictionResult = await client.query<PredictionHistoryRow>(
          `
            INSERT INTO predictions (
              patient_id,
              created_by_user_id,
              image_storage_uri,
              image_filename,
              mime_type,
              severity_label,
              screening_outcome,
              confidence,
              recommendation,
              model_version,
              jetson_inference_time_ms,
              requires_review,
              ${reviewStatusCol}
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, 'pending')
            RETURNING
              id AS prediction_id,
              patient_id,
              $12::text AS patient_name,
              $13::text AS cnic,
              $14::text AS phone,
              image_storage_uri AS image_data_url,
              severity_label AS severity,
              screening_outcome,
              confidence::text AS confidence,
              recommendation,
              model_version,
              jetson_inference_time_ms AS jetson_inference_time,
              created_at,
              ${reviewStatusCol} AS review_status,
              clinician_comment,
              reviewed_at
          `,
          [
            patient.id,
            req.userId,
            imageStorageUri,
            storedFilename,
            req.file.mimetype,
            severity,
            screeningOutcome,
            confidence,
            recommendation,
            model_version,
            inferenceTime,
            patient.full_name,
            patient.cnic,
            patient.phone,
          ],
        );

        await client.query("COMMIT");
        res.json(await mapPredictionForResponse(predictionResult.rows[0]));
        void synchronizeDatabases().catch((error) => {
          console.error(
            "Post-classification sync attempt failed. Will retry on schedule:",
            error instanceof Error ? error.message : "Unknown sync error",
          );
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      console.error("Local classification failed", {
        message: errorMessage,
        modelPath: MODEL_ONNX_PATH,
      });

      res.status(500).json({
        error: "Classification failed",
        details: errorMessage,
      });
    }
  },
);

app.get("/api/predictions", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const reviewStatusCol = await getPredictionsReviewStatusColumn();
    const result = await localPool.query<PredictionHistoryRow>(
      `
        SELECT
          p.id AS prediction_id,
          p.patient_id,
          pt.full_name AS patient_name,
          pt.cnic,
          pt.phone,
          p.image_storage_uri AS image_data_url,
          p.severity_label AS severity,
          p.screening_outcome,
          p.confidence::text AS confidence,
          p.recommendation,
          p.model_version,
          p.jetson_inference_time_ms AS jetson_inference_time,
          p.created_at,
          p.${reviewStatusCol} AS review_status,
          p.clinician_comment,
          p.reviewed_at
        FROM predictions p
        INNER JOIN patients pt ON pt.id = p.patient_id
        ORDER BY p.created_at DESC
      `,
    );

    res.json({
      total: result.rows.length,
      predictions: await Promise.all(result.rows.map((row) => mapPredictionForResponse(row))),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch predictions",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get(
  "/api/predictions/:predictionId",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const reviewStatusCol = await getPredictionsReviewStatusColumn();
      const result = await localPool.query<PredictionHistoryRow>(
        `
          SELECT
            p.id AS prediction_id,
            p.patient_id,
            pt.full_name AS patient_name,
            pt.cnic,
            pt.phone,
            p.image_storage_uri AS image_data_url,
            p.severity_label AS severity,
            p.screening_outcome,
            p.confidence::text AS confidence,
            p.recommendation,
            p.model_version,
            p.jetson_inference_time_ms AS jetson_inference_time,
            p.created_at,
            p.${reviewStatusCol} AS review_status,
            p.clinician_comment,
            p.reviewed_at
          FROM predictions p
          INNER JOIN patients pt ON pt.id = p.patient_id
          WHERE p.id = $1
        `,
        [req.params.predictionId],
      );

      const prediction = result.rows[0];
      if (!prediction) {
        return res.status(404).json({ error: "Prediction not found" });
      }

      res.json(await mapPredictionForResponse(prediction));
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch prediction",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

app.post("/api/db/synchronize", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const syncResult = await synchronizeDatabases();
    if (!deployedPool) {
      return res.status(400).json({
        error: "Deployed database is not configured",
      });
    }
    if (!syncResult) {
      return res.status(202).json({
        message: "Synchronization is already in progress",
      });
    }
    return res.json({
      message: "Database synchronization completed",
      result: syncResult,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Database synchronization failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/s3/synchronize", authMiddleware, async (_req: AuthRequest, res: Response) => {
  return res.status(400).json({
    error: "S3 disk synchronization is disabled",
    details: "Images are uploaded directly to S3; there is no local uploads folder to sync.",
  });
});

app.post(
  "/api/predictions/:predictionId/review",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body as {
        action?: string;
        clinicianComment?: string;
        clinician_comment?: string;
      };
      const actionRaw = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
      const action = actionRaw === "accepted" || actionRaw === "rejected" ? actionRaw : undefined;
      const clinicianComment =
        typeof body.clinicianComment === "string"
          ? body.clinicianComment
          : typeof body.clinician_comment === "string"
            ? body.clinician_comment
            : "";

      if (action !== "accepted" && action !== "rejected") {
        return res.status(400).json({ error: "Action must be accepted or rejected" });
      }
      const reviewStatusCol = await getPredictionsReviewStatusColumn();
      const client = await localPool.connect();
      try {
        await client.query("BEGIN");
        const currentResult = await client.query<{
          prediction_id: string;
          image_filename: string | null;
          mime_type: string | null;
          screening_outcome: "NRDR" | "RDR" | null;
          image_storage_uri: string | null;
        }>(
          `
            SELECT
              id AS prediction_id,
              image_filename,
              mime_type,
              screening_outcome,
              image_storage_uri
            FROM predictions
            WHERE id = $1
            FOR UPDATE
          `,
          [req.params.predictionId],
        );

        const currentPrediction = currentResult.rows[0];
        if (!currentPrediction) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Prediction not found" });
        }

        if (!currentPrediction.image_filename) {
          throw new Error("Prediction image filename is missing");
        }

        const localImageBuffer = await downloadPredictionImageBuffer({
          imageStorageUri: currentPrediction.image_storage_uri,
          filename: currentPrediction.image_filename,
        });
        const screening = normalizeScreeningOutcome(
          currentPrediction.screening_outcome as string | null | undefined,
        );
        if (!screening) {
          throw new Error(
            `Prediction screening outcome is invalid: ${String(currentPrediction.screening_outcome)}`,
          );
        }
        const reviewedFolder = getReviewedImageSubfolder(screening, action);
        const reviewedUpload = await uploadImageToS3({
          buffer: localImageBuffer,
          filename: currentPrediction.image_filename,
          keyPrefixes: [reviewedFolder],
          contentType: currentPrediction.mime_type || undefined,
        });
        const reviewedRemoteUri = reviewedUpload?.uri ?? null;
        if (!reviewedRemoteUri) {
          throw new Error("S3 upload failed for reviewed image");
        }
        await deleteImageFromS3({
          filename: currentPrediction.image_filename,
          keyPrefixes: ["pending"],
        });
        const imageUriForDb = reviewedRemoteUri;

        const result = await client.query<PredictionHistoryRow>(
          `
            UPDATE predictions p
            SET
              ${reviewStatusCol} = '${action}',
              clinician_comment = $1,
              reviewed_at = NOW(),
              reviewed_by_user_id = $2,
              requires_review = FALSE,
              image_storage_uri = COALESCE($4, image_storage_uri),
              updated_at = NOW()
            FROM patients pt
            WHERE
              p.id = $3
              AND pt.id = p.patient_id
            RETURNING
              p.id AS prediction_id,
              p.patient_id,
              pt.full_name AS patient_name,
              pt.cnic,
              pt.phone,
              p.image_storage_uri AS image_data_url,
              p.severity_label AS severity,
              p.screening_outcome,
              p.confidence::text AS confidence,
              p.recommendation,
              p.model_version,
              p.jetson_inference_time_ms AS jetson_inference_time,
              p.created_at,
              p.${reviewStatusCol} AS review_status,
              p.clinician_comment,
              p.reviewed_at
          `,
          [
            clinicianComment?.trim() || null,
            req.userId,
            req.params.predictionId,
            imageUriForDb,
          ],
        );

        if (!result.rows[0]) {
          throw new Error("Review update did not match any row (check prediction id and patient link).");
        }

        await client.query("COMMIT");
        res.json(await mapPredictionForResponse(result.rows[0]));
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("POST /api/predictions/:predictionId/review failed:", error);
      res.status(500).json({
        error: "Failed to update review status",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

app.get("/api/analytics/summary", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const reviewStatusCol = await getPredictionsReviewStatusColumn();
    const [summaryResult, recentResult] = await Promise.all([
      localPool.query<{
        total_predictions: string;
        average_confidence: string | null;
        average_inference_time_ms: string | null;
        no_dr_count: string;
        mild_dr_count: string;
        moderate_dr_count: string;
        severe_dr_count: string;
        proliferative_dr_count: string;
      }>(
        `
          SELECT
            COUNT(*)::text AS total_predictions,
            AVG(confidence)::text AS average_confidence,
            AVG(jetson_inference_time_ms)::text AS average_inference_time_ms,
            COUNT(*) FILTER (WHERE severity_label = 'No DR')::text AS no_dr_count,
            COUNT(*) FILTER (WHERE severity_label = 'Mild DR')::text AS mild_dr_count,
            COUNT(*) FILTER (WHERE severity_label = 'Moderate DR')::text AS moderate_dr_count,
            COUNT(*) FILTER (WHERE severity_label = 'Severe DR')::text AS severe_dr_count,
            COUNT(*) FILTER (WHERE severity_label = 'Proliferative DR')::text AS proliferative_dr_count
          FROM predictions
        `,
      ),
      localPool.query<PredictionHistoryRow>(
        `
          SELECT
            p.id AS prediction_id,
            p.patient_id,
            pt.full_name AS patient_name,
            pt.cnic,
            pt.phone,
            p.image_storage_uri AS image_data_url,
            p.severity_label AS severity,
            p.screening_outcome,
            p.confidence::text AS confidence,
            p.recommendation,
            p.model_version,
            p.jetson_inference_time_ms AS jetson_inference_time,
            p.created_at,
            p.${reviewStatusCol} AS review_status,
            p.clinician_comment,
            p.reviewed_at
          FROM predictions p
          INNER JOIN patients pt ON pt.id = p.patient_id
          ORDER BY p.created_at DESC
          LIMIT 1
        `,
      ),
    ]);

    const summary = summaryResult.rows[0];
    res.json({
      total_predictions: Number(summary.total_predictions),
      severity_distribution: {
        "No DR": Number(summary.no_dr_count),
        "Mild DR": Number(summary.mild_dr_count),
        "Moderate DR": Number(summary.moderate_dr_count),
        "Severe DR": Number(summary.severe_dr_count),
        "Proliferative DR": Number(summary.proliferative_dr_count),
      },
      average_confidence: Number(Number(summary.average_confidence ?? 0).toFixed(2)),
      average_inference_time_ms: Math.round(Number(summary.average_inference_time_ms ?? 0)),
      most_recent: recentResult.rows[0]
        ? await mapPredictionForResponse(recentResult.rows[0])
        : null,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch analytics",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

if (deployedPool && DB_SYNC_INTERVAL_MS > 0) {
  void synchronizeDatabases().catch((error) => {
    console.error(
      "Initial DB sync failed. Periodic retries remain enabled:",
      error instanceof Error ? error.message : "Unknown sync error",
    );
  });

  setInterval(() => {
    void synchronizeDatabases()
      .then((result) => {
        if (!result) {
          return;
        }
        console.log("Periodic DB sync completed", result);
      })
      .catch((error) => {
        console.error(
          "Periodic DB sync failed:",
          error instanceof Error ? error.message : "Unknown sync error",
        );
      });
  }, DB_SYNC_INTERVAL_MS);

  console.log(
    `Periodic DB synchronization enabled every ${DB_SYNC_INTERVAL_MS} ms (batch size ${DB_SYNC_BATCH_SIZE}).`,
  );
}

async function ensureServingPreconditions() {
  if (!MODEL_S3_URI) {
    console.error(
      "MODEL_S3_URI is required. Inference loads ONNX bytes from this S3 object into memory (no local best.onnx required).",
    );
    process.exit(1);
  }
}

void ensureServingPreconditions().then(() => {
  app.listen(PORT, () => {
    const s3Sync = getS3EnvironmentHealth();
    const inferenceLine = MODEL_S3_URI
      ? `Inference: ONNX from MODEL_S3_URI (in memory; TensorRT disabled)\nMODEL_S3_URI: ${MODEL_S3_URI}`
      : `Inference backend priority: TensorRT engine -> ONNX fallback`;
    console.log(`
Backend server running on http://localhost:${PORT}
${inferenceLine}
Engine path: ${MODEL_ENGINE_PATH}
ONNX path: ${MODEL_ONNX_PATH}
TensorRT runner: ${TENSORRT_RUNNER_PATH}
Authentication: JWT
Database: PostgreSQL (primary app pool${deployedPool ? ", deployed sync pool" : ""})
S3 images: direct upload (target=${s3Sync.syncTarget})
  `);
    if (s3Sync.syncTarget === "none") {
      console.warn(
        "S3 is not configured: set S3_URI (e.g. s3://your-bucket/prefix) so prediction images can be stored.",
      );
    }
  });
});

export default app;
