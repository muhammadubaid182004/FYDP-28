import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import pg from "pg";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const DATABASE_URL = process.env.DATABASE_URL;
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const MODEL_ONNX_PATH = path.resolve(
  process.cwd(),
  process.env.MODEL_ONNX_PATH || "best.onnx",
);
const MODEL_INPUT_SIZE = Number(process.env.MODEL_INPUT_SIZE || 256);
const MODEL_CLASS_LABELS = (
  process.env.MODEL_CLASS_LABELS || "No DR,RDR"
)
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
const MODEL_CONFIDENCE_THRESHOLD = Number(process.env.MODEL_CONFIDENCE_THRESHOLD || 0.5);
const DATABASE_SSL = (process.env.DATABASE_SSL || "").toLowerCase();
const SHOULD_USE_DATABASE_SSL =
  DATABASE_SSL === "true" ||
  DATABASE_SSL === "require" ||
  DATABASE_URL.includes("sslmode=require") ||
  DATABASE_URL.includes("amazonaws.com");
const ALLOWED_ORIGINS = (
  process.env.FRONTEND_URL || "http://localhost:3000,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for the backend to use PostgreSQL.");
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: SHOULD_USE_DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

pool
  .connect()
  .then((client) => {
    console.log("Database connected successfully.");
    client.release();
  })
  .catch((error: Error) => {
    console.error("Failed to connect to PostgreSQL:", error.message);
  });

void fs.mkdir(UPLOADS_DIR, { recursive: true }).catch((error: Error) => {
  console.error("Failed to ensure uploads directory exists:", error.message);
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

function getUploadPublicUrl(req: Request, filename: string) {
  return `${req.protocol}://${req.get("host")}/uploads/${filename}`;
}

let modelSessionPromise: Promise<unknown> | null = null;

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

async function preprocessImage(buffer: Buffer) {
  const sharpLib = await import("sharp");
  const sharp = sharpLib.default;
  const resized = await sharp(buffer)
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const baseIndex = i * 3;
    tensor[i] = resized[baseIndex] / 255;
    tensor[pixelCount + i] = resized[baseIndex + 1] / 255;
    tensor[pixelCount * 2 + i] = resized[baseIndex + 2] / 255;
  }

  return tensor;
}

async function runLocalInference(imageBuffer: Buffer) {
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
  const probabilities = softmax(logits);
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
      : predictedLabel === "No DR" || predictedLabel === "Mild DR"
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
  const result = await pool.query<DbUserRow>(
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
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "healthy",
      backend: "up",
      database: "connected",
      inference_backend: "onnx-local",
      model_onnx_path: MODEL_ONNX_PATH,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      backend: "up",
      database: "disconnected",
      error: error instanceof Error ? error.message : "Unknown database error",
    });
  }
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

    const existing = await pool.query(
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
    const inserted = await pool.query<DbUserRow>(
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

    const result = await pool.query<DbUserRow>(
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

      console.log("Starting local ONNX classification", {
        modelPath: MODEL_ONNX_PATH,
        inputSize: MODEL_INPUT_SIZE,
      });

      const inference = await runLocalInference(req.file.buffer);
      const inferenceTime = Date.now() - startTime;
      const severity = inference.predictedLabel;
      const confidence = inference.confidence;
      const recommendation = inference.recommendation;
      const model_version = inference.modelVersion;

      const screeningOutcome: "NRDR" | "RDR" =
        severity === "No DR" || severity === "Mild DR" ? "NRDR" : "RDR";
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

      const client = await pool.connect();
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
            req.file.originalname,
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
    const result = await pool.query<PredictionHistoryRow>(
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
      const result = await pool.query<PredictionHistoryRow>(
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

      const result = await pool.query<PredictionHistoryRow>(
        `
          UPDATE predictions p
          SET
            review_status = $1::review_status,
            clinician_comment = $2,
            reviewed_at = NOW(),
            reviewed_by_user_id = $3,
            requires_review = FALSE,
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
        ],
      );

      const prediction = result.rows[0];
      if (!prediction) {
        return res.status(404).json({ error: "Prediction not found" });
      }

      res.json(mapPredictionForResponse(prediction));
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
      pool.query<{
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
      pool.query<PredictionHistoryRow>(
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

app.listen(PORT, () => {
  console.log(`
Backend server running on http://localhost:${PORT}
Inference backend: ONNX (local)
Model path: ${MODEL_ONNX_PATH}
Authentication: JWT
Database: PostgreSQL
  `);
});

export default app;
