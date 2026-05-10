import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import pg from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  deleteImageFromS3,
  getS3EnvironmentHealth,
  synchronizeS3ImagesFromDisk,
  uploadImageToS3,
  verifyS3Connectivity,
} from "./s3.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const LOCAL_DATABASE_URL =
  process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || "";
const DEPLOYED_DATABASE_URL = process.env.DEPLOYED_DATABASE_URL || "";
const DATABASE_URL = LOCAL_DATABASE_URL;
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const IMAGES_DIR = path.resolve(process.cwd(), "images");
const IMAGES_NRDR_DIR = path.join(IMAGES_DIR, "NRDR");
const IMAGES_RDR_DIR = path.join(IMAGES_DIR, "RDR");
const MODEL_ENGINE_PATH = path.resolve(
  process.cwd(),
  process.env.MODEL_ENGINE_PATH || "best.engine",
);
const MODEL_ONNX_PATH = path.resolve(
  process.cwd(),
  process.env.MODEL_ONNX_PATH || "best.onnx",
);
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
const deployedPool = DEPLOYED_DATABASE_URL
  ? new Pool({
      connectionString: DEPLOYED_DATABASE_URL,
      ssl: SHOULD_USE_DEPLOYED_DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    })
  : null;

void (async () => {
  if (!DATABASE_URL) {
    console.warn(
      "LOCAL_DATABASE_URL is not configured. Starting backend in degraded mode without local database connectivity.",
    );
  } else {
    try {
      const dbResult = await localPool.query("SELECT 1");
      if (dbResult.rowCount !== null) {
        console.log("Local database connected successfully.");
      }
    } catch (dbError) {
      console.error(
        "Local database connection check failed. Backend will continue running in degraded mode:",
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

void Promise.all([
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
  fs.mkdir(IMAGES_NRDR_DIR, { recursive: true }),
  fs.mkdir(IMAGES_RDR_DIR, { recursive: true }),
]).catch((error: Error) => {
  console.error("Failed to ensure uploads/images directories exist:", error.message);
});

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
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/images", express.static(IMAGES_DIR));

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

function mapPredictionForResponse(row: PredictionHistoryRow) {
  return {
    prediction_id: row.prediction_id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    cnic: row.cnic,
    phone: row.phone,
    image_data_url: row.image_data_url ?? undefined,
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

async function synchronizeS3FromLocalDisk() {
  const health = getS3EnvironmentHealth();
  if (health.syncTarget === "none" || S3_SYNC_BATCH_SIZE <= 0) {
    return null;
  }
  return synchronizeS3ImagesFromDisk({
    uploadsDir: UPLOADS_DIR,
    imagesNrdrDir: IMAGES_NRDR_DIR,
    imagesRdrDir: IMAGES_RDR_DIR,
    batchLimit: S3_SYNC_BATCH_SIZE,
  });
}

function getUploadPublicUrl(req: Request, filename: string) {
  return `${req.protocol}://${req.get("host")}/uploads/${filename}`;
}

function getOrganizedImagePublicUrl(
  req: Request,
  subfolder: "NRDR" | "RDR",
  filename: string,
) {
  return `${req.protocol}://${req.get("host")}/images/${subfolder}/${filename}`;
}

/** RDR + accepted → RDR folder; all other outcomes → NRDR folder (local + S3 prefix). */
function getReviewedImageSubfolder(
  predictedOutcome: "NRDR" | "RDR",
  action: "accepted" | "rejected",
): "NRDR" | "RDR" {
  return predictedOutcome === "RDR" && action === "accepted" ? "RDR" : "NRDR";
}

async function resolveLocalPredictionImagePath(filename: string): Promise<string | null> {
  const candidates = [
    path.join(UPLOADS_DIR, filename),
    path.join(IMAGES_NRDR_DIR, filename),
    path.join(IMAGES_RDR_DIR, filename),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

let modelSessionPromise: Promise<unknown> | null = null;
let selectedInferenceBackend: "engine" | "onnx" = "onnx";

type OrtModuleShape = {
  InferenceSession: {
    create: (modelPath: string) => Promise<unknown>;
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
    modelSessionPromise = getOrtModule().then((ort) =>
      ort.InferenceSession.create(MODEL_ONNX_PATH),
    );
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
  const [engineExists, onnxExists, runnerExists] = await Promise.all([
    checkFileExists(MODEL_ENGINE_PATH),
    checkFileExists(MODEL_ONNX_PATH),
    checkFileExists(TENSORRT_RUNNER_PATH),
  ]);

  return {
    engineExists,
    onnxExists,
    tensorRtRunnerExists: runnerExists,
    selectedBackend:
      engineExists && runnerExists ? "engine" : onnxExists ? "onnx" : "unavailable",
  };
}

async function resolveInferenceBackend() {
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
  const tempImagePath = path.join(UPLOADS_DIR, tempFilename);
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
    modelVersion: "onnx-local-backend",
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

    const passwordMatch = await bcryptjs.compare(password, user.password_hash);
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
      const storedFilePath = path.join(UPLOADS_DIR, storedFilename);

      await fs.writeFile(storedFilePath, req.file.buffer);

      const imageDataUrl = getUploadPublicUrl(req, storedFilename);
      await uploadImageToS3({
        buffer: req.file.buffer,
        filename: storedFilename,
        keyPrefixes: ["pending"],
        contentType: req.file.mimetype,
      });

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
              review_status
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
              review_status,
              clinician_comment,
              reviewed_at
          `,
          [
            patient.id,
            req.userId,
            imageDataUrl,
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
        res.json(mapPredictionForResponse(predictionResult.rows[0]));
        void synchronizeDatabases().catch((error) => {
          console.error(
            "Post-classification sync attempt failed. Will retry on schedule:",
            error instanceof Error ? error.message : "Unknown sync error",
          );
        });
        void synchronizeS3FromLocalDisk().catch((error) => {
          console.error(
            "Post-classification S3 disk sync failed. Will retry on schedule:",
            error instanceof Error ? error.message : "Unknown S3 sync error",
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
          p.review_status,
          p.clinician_comment,
          p.reviewed_at
        FROM predictions p
        INNER JOIN patients pt ON pt.id = p.patient_id
        ORDER BY p.created_at DESC
      `,
    );

    res.json({
      total: result.rows.length,
      predictions: result.rows.map(mapPredictionForResponse),
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
            p.review_status,
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

      res.json(mapPredictionForResponse(prediction));
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
  try {
    const health = getS3EnvironmentHealth();
    if (health.syncTarget === "none") {
      return res.status(400).json({
        error: "S3 is not configured (set S3_URI)",
      });
    }
    const syncResult = await synchronizeS3FromLocalDisk();
    if (!syncResult) {
      return res.status(202).json({
        message: "S3 synchronization is already in progress or batch size is zero",
      });
    }
    return res.json({
      message: "S3 disk synchronization completed",
      result: syncResult,
    });
  } catch (error) {
    return res.status(500).json({
      error: "S3 synchronization failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post(
  "/api/predictions/:predictionId/review",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { action, clinicianComment } = req.body as {
        action?: "accepted" | "rejected";
        clinicianComment?: string;
      };

      if (action !== "accepted" && action !== "rejected") {
        return res.status(400).json({ error: "Action must be accepted or rejected" });
      }
      const client = await localPool.connect();
      try {
        await client.query("BEGIN");
        const currentResult = await client.query<{
          prediction_id: string;
          image_filename: string | null;
          mime_type: string | null;
          screening_outcome: "NRDR" | "RDR" | null;
        }>(
          `
            SELECT
              id AS prediction_id,
              image_filename,
              mime_type,
              screening_outcome
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

        const localImagePath = await resolveLocalPredictionImagePath(
          currentPrediction.image_filename,
        );
        if (!localImagePath) {
          throw new Error(
            `Prediction image file not found on disk: ${currentPrediction.image_filename}`,
          );
        }
        const localImageBuffer = await fs.readFile(localImagePath);
        if (
          currentPrediction.screening_outcome !== "NRDR" &&
          currentPrediction.screening_outcome !== "RDR"
        ) {
          throw new Error("Prediction screening outcome is invalid");
        }
        const reviewedFolder = getReviewedImageSubfolder(
          currentPrediction.screening_outcome,
          action,
        );
        const destDir = reviewedFolder === "RDR" ? IMAGES_RDR_DIR : IMAGES_NRDR_DIR;
        const destPath = path.join(destDir, currentPrediction.image_filename);
        const reviewedUpload = await uploadImageToS3({
          buffer: localImageBuffer,
          filename: currentPrediction.image_filename,
          keyPrefixes: [reviewedFolder],
          contentType: currentPrediction.mime_type || undefined,
        });
        const reviewedRemoteUri = reviewedUpload?.uri ?? null;
        await deleteImageFromS3({
          filename: currentPrediction.image_filename,
          keyPrefixes: ["pending"],
        });

        if (path.resolve(localImagePath) !== path.resolve(destPath)) {
          await fs.mkdir(destDir, { recursive: true });
          await fs.rename(localImagePath, destPath);
        }
        const organizedLocalUri = getOrganizedImagePublicUrl(
          req,
          reviewedFolder,
          currentPrediction.image_filename,
        );
        const imageUriForDb = reviewedRemoteUri ?? organizedLocalUri;

        const result = await client.query<PredictionHistoryRow>(
          `
            UPDATE predictions p
            SET
              review_status = $1::review_status,
              clinician_comment = $2,
              reviewed_at = NOW(),
              reviewed_by_user_id = $3,
              requires_review = FALSE,
              image_storage_uri = COALESCE($5, image_storage_uri),
              updated_at = NOW()
            FROM patients pt
            WHERE
              p.id = $4
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
              p.review_status,
              p.clinician_comment,
              p.reviewed_at
          `,
          [
            action,
            clinicianComment?.trim() || null,
            req.userId,
            req.params.predictionId,
            imageUriForDb,
          ],
        );

        await client.query("COMMIT");
        res.json(mapPredictionForResponse(result.rows[0]));
        void synchronizeS3FromLocalDisk().catch((error) => {
          console.error(
            "Post-review S3 disk sync failed. Will retry on schedule:",
            error instanceof Error ? error.message : "Unknown S3 sync error",
          );
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(500).json({
        error: "Failed to update review status",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

app.get("/api/analytics/summary", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
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
            p.review_status,
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
      most_recent: recentResult.rows[0] ? mapPredictionForResponse(recentResult.rows[0]) : null,
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

const s3PeriodicHealth = getS3EnvironmentHealth();
if (s3PeriodicHealth.syncTarget !== "none" && S3_SYNC_INTERVAL_MS > 0) {
  void synchronizeS3FromLocalDisk().catch((error) => {
    console.error(
      "Initial S3 disk sync failed. Periodic retries remain enabled:",
      error instanceof Error ? error.message : "Unknown S3 sync error",
    );
  });

  setInterval(() => {
    void synchronizeS3FromLocalDisk()
      .then((result) => {
        if (!result) {
          return;
        }
        console.log("Periodic S3 disk sync completed", result);
      })
      .catch((error) => {
        console.error(
          "Periodic S3 disk sync failed:",
          error instanceof Error ? error.message : "Unknown S3 sync error",
        );
      });
  }, S3_SYNC_INTERVAL_MS);

  console.log(
    `Periodic S3 disk synchronization enabled every ${S3_SYNC_INTERVAL_MS} ms (batch size ${S3_SYNC_BATCH_SIZE}; target=${s3PeriodicHealth.syncTarget}).`,
  );
}

app.listen(PORT, () => {
  const s3Sync = getS3EnvironmentHealth();
  console.log(`
Backend server running on http://localhost:${PORT}
Inference backend priority: TensorRT engine -> ONNX fallback
Engine path: ${MODEL_ENGINE_PATH}
ONNX path: ${MODEL_ONNX_PATH}
TensorRT runner: ${TENSORRT_RUNNER_PATH}
Authentication: JWT
Database: PostgreSQL (local primary${deployedPool ? ", deployed sync enabled" : ""})
S3 disk sync target: ${s3Sync.syncTarget}
  `);
  if (s3Sync.syncTarget === "none") {
    console.warn(
      "S3 disk sync and runtime S3 uploads are disabled: set S3_URI (e.g. s3://your-bucket/prefix) to enable them.",
    );
  }
});

export default app;
