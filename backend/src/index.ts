import express from "express";
import cors from "cors";
import multer from "multer";
import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import fs from "fs";
import path from "path";
import { Router } from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;
const JETSON_URL = process.env.JETSON_IP_ADDRESS
  ? `http://${process.env.JETSON_IP_ADDRESS}:8000`
  : "http://localhost:8001";
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Middleware
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/jpg"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG and PNG images are allowed"));
    }
  },
});

// ============ DATABASE SETUP ============
const DB_PATH = process.env.DB_PATH || "./predictions.db";

interface DBUser {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: string;
}

interface DBPrediction {
  id: string;
  user_id: string;
  severity: string;
  confidence: number;
  recommendation: string;
  model_version: string;
  created_at: string;
  jetson_inference_time: number;
}

let users: DBUser[] = [];
let predictions: DBPrediction[] = [];

// Load data on startup
function loadDatabase() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
      users = data.users || [];
      predictions = data.predictions || [];
      console.log(`✅ Database loaded from ${DB_PATH}`);
    }
  } catch (err) {
    console.log("📝 Creating new database...");
  }
}

function saveDatabase() {
  fs.writeFileSync(DB_PATH, JSON.stringify({ users, predictions }, null, 2));
}

loadDatabase();

// ============ AUTH MIDDLEWARE ============
interface AuthRequest extends express.Request {
  userId?: string;
  user?: DBUser;
}

const authMiddleware = (
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    const user = users.find((u) => u.id === decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ============ ROUTES ============

// Health check
app.get("/healthz", (req, res) => {
  res.json({
    status: "healthy",
    backend: "up",
    jetson_url: JETSON_URL,
    timestamp: new Date().toISOString(),
  });
});

// ---- AUTHENTICATION ----
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password, name } = req.body;

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "Username, email, and password required" });
    }

    // Check if user exists
    if (users.some((u) => u.username === username)) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Hash password
    const password_hash = await bcryptjs.hash(password, 10);
    const userId = `user_${Date.now()}`;

    const newUser: DBUser = {
      id: userId,
      username,
      email,
      password_hash,
      created_at: new Date().toISOString(),
    };

    users.push(newUser);
    saveDatabase();

    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "24h" });

    res.status(201).json({
      message: "User registered successfully",
      user: { id: userId, username, email },
      token,
    });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password required" });
    }

    const user = users.find((u) => u.username === username);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatch = await bcryptjs.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      message: "Login successful",
      user: { id: user.id, username: user.username, email: user.email },
      token,
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// ---- JETSON INFERENCE ----
app.post(
  "/api/classify",
  authMiddleware,
  upload.single("file"),
  async (req: AuthRequest, res: express.Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      if (!req.userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      console.log(`📤 Forwarding image to Jetson at ${JETSON_URL}...`);
      const startTime = Date.now();

      // Create form data for Jetson
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname
      );

      // Forward to Jetson
      const jetsonResponse = await axios.post(`${JETSON_URL}/api/predict`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
        timeout: 30000,
      });

      const inferenceTime = Date.now() - startTime;
      console.log(`✅ Jetson inference completed in ${inferenceTime}ms`);

      const {
        class: severity,
        confidence,
        recommendation,
        model_version,
      } = jetsonResponse.data;

      // Save to database
      const predictionId = `pred_${Date.now()}`;
      const prediction: DBPrediction = {
        id: predictionId,
        user_id: req.userId,
        severity,
        confidence,
        recommendation,
        model_version,
        created_at: new Date().toISOString(),
        jetson_inference_time: inferenceTime,
      };

      predictions.push(prediction);
      saveDatabase();

      res.json({
        prediction_id: predictionId,
        severity,
        confidence,
        recommendation,
        model_version,
        jetson_inference_time: inferenceTime,
        created_at: prediction.created_at,
      });
    } catch (err) {
      const error = err as AxiosError;
      console.error("❌ Jetson connection error:", error.message);

      if (error.code === "ECONNREFUSED") {
        return res.status(503).json({
          error: "Jetson inference server unreachable",
          details: `Cannot connect to ${JETSON_URL}`,
          jetson_url: JETSON_URL,
        });
      }

      res.status(500).json({
        error: "Classification failed",
        details: error.message,
      });
    }
  }
);

// ---- PREDICTION HISTORY ----
app.get("/api/predictions", authMiddleware, (req: AuthRequest, res) => {
  try {
    const userPredictions = predictions.filter(
      (p) => p.user_id === req.userId
    );
    res.json({
      total: userPredictions.length,
      predictions: userPredictions.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch predictions" });
  }
});

app.get("/api/predictions/:predictionId", authMiddleware, (req: AuthRequest, res) => {
  try {
    const prediction = predictions.find((p) => p.id === req.params.predictionId);

    if (!prediction) {
      return res.status(404).json({ error: "Prediction not found" });
    }

    if (prediction.user_id !== req.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch prediction" });
  }
});

// ---- ANALYTICS ----
app.get("/api/analytics/summary", authMiddleware, (req: AuthRequest, res) => {
  try {
    const userPredictions = predictions.filter(
      (p) => p.user_id === req.userId
    );

    const severityCount = {
      "No DR": 0,
      "Mild DR": 0,
      "Moderate DR": 0,
      "Severe DR": 0,
      "Proliferative DR": 0,
    };

    userPredictions.forEach((p) => {
      if (severityCount.hasOwnProperty(p.severity)) {
        severityCount[p.severity as keyof typeof severityCount]++;
      }
    });

    const avgConfidence =
      userPredictions.length > 0
        ? userPredictions.reduce((sum, p) => sum + p.confidence, 0) /
          userPredictions.length
        : 0;

    const avgInferenceTime =
      userPredictions.length > 0
        ? userPredictions.reduce((sum, p) => sum + p.jetson_inference_time, 0) /
          userPredictions.length
        : 0;

    res.json({
      total_predictions: userPredictions.length,
      severity_distribution: severityCount,
      average_confidence: parseFloat(avgConfidence.toFixed(2)),
      average_inference_time_ms: parseInt(avgInferenceTime.toString()),
      most_recent: userPredictions[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 Backend server running on http://localhost:${PORT}
🎯 Jetson URL: ${JETSON_URL}
🔐 Authentication: JWT
📊 Database: ${DB_PATH}
  `);
});

export default app;
