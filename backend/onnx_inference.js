import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ort from "onnxruntime-node";
import sharp from "sharp";

const DEFAULT_MODEL = "best.onnx";
const DEFAULT_IMAGES_DIR = "images";
const DEFAULT_IMAGE_SIZE = 256;
const DEFAULT_LABELS = ["Nrdr", "Rdr"];
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const DEFAULT_NORMALIZATION = "none";
const DEFAULT_OUTPUT_KIND = "auto";
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    imagesDir: DEFAULT_IMAGES_DIR,
    imgsz: DEFAULT_IMAGE_SIZE,
    labels: DEFAULT_LABELS,
    normalization: DEFAULT_NORMALIZATION,
    outputKind: DEFAULT_OUTPUT_KIND,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--model" && next) {
      args.model = next;
      i += 1;
    } else if (token === "--images-dir" && next) {
      args.imagesDir = next;
      i += 1;
    } else if (token === "--imgsz" && next) {
      args.imgsz = Number(next);
      i += 1;
    } else if (token === "--labels" && next) {
      args.labels = next
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === "--normalization" && next) {
      args.normalization = next.trim().toLowerCase();
      i += 1;
    } else if (token === "--output-kind" && next) {
      args.outputKind = next.trim().toLowerCase();
      i += 1;
    }
  }

  return args;
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

async function preprocessImage(imagePath, imageSize, normalization) {
  const raw = await sharp(imagePath)
    .resize(imageSize, imageSize, {
      fit: "contain",
      position: "center",
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixelCount = imageSize * imageSize;
  const tensor = new Float32Array(3 * pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    const base = i * 3;
    const r = raw[base] / 255;
    const g = raw[base + 1] / 255;
    const b = raw[base + 2] / 255;
    if (normalization === "imagenet") {
      tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      tensor[pixelCount + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      tensor[pixelCount * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    } else {
      tensor[i] = r;
      tensor[pixelCount + i] = g;
      tensor[pixelCount * 2 + i] = b;
    }
  }

  return tensor;
}

function recommendationFor(label) {
  const normalized = String(label).trim().toLowerCase();
  if (normalized === "nrdr" || normalized === "no dr" || normalized === "no_dr") {
    return "No referable diabetic retinopathy detected. Continue routine screening.";
  }
  return "Referable diabetic retinopathy suspected. Clinical review is recommended.";
}

async function run() {
  const cli = parseArgs(process.argv.slice(2));
  const modelPath = path.resolve(process.cwd(), cli.model);
  const imagesDir = path.resolve(process.cwd(), cli.imagesDir);

  await fs.access(modelPath);
  const dirEntries = await fs.readdir(imagesDir, { withFileTypes: true });
  const imageFiles = dirEntries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(imagesDir, entry.name))
    .filter((filePath) => ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  if (imageFiles.length === 0) {
    throw new Error(`No supported images found in ${imagesDir}`);
  }

  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const results = [];
  for (const imagePath of imageFiles) {
    const inputData = await preprocessImage(imagePath, cli.imgsz, cli.normalization);
    const tensor = new ort.Tensor("float32", inputData, [1, 3, cli.imgsz, cli.imgsz]);
    const output = await session.run({ [inputName]: tensor });
    const rawOutput = output[outputName]?.data;
    const logits = rawOutput ? Array.from(rawOutput, Number) : [];
    if (logits.length === 0) {
      throw new Error(`Model returned empty output for ${imagePath}`);
    }

    const probs = (() => {
      if (cli.outputKind === "logits") return softmax(logits);
      if (cli.outputKind === "probs") return logits;
      const isProbLike =
        Math.max(...logits) <= 1 &&
        Math.min(...logits) >= 0 &&
        Math.abs(logits.reduce((s, v) => s + v, 0) - 1) < 1e-3;
      return isProbLike ? logits : softmax(logits);
    })();
    let topIndex = 0;
    let topConfidence = probs[0] ?? 0;
    for (let i = 1; i < probs.length; i += 1) {
      if (probs[i] > topConfidence) {
        topConfidence = probs[i];
        topIndex = i;
      }
    }

    const predictedClass = cli.labels[topIndex] || `class_${topIndex}`;
    results.push({
      image_path: imagePath,
      class: predictedClass,
      confidence: topConfidence,
      recommendation: recommendationFor(predictedClass),
    });
  }

  const payload = {
    model_path: modelPath,
    model_version: "onnx-direct-node-1.0.0",
    images_dir: imagesDir,
    settings: {
      imgsz: cli.imgsz,
      normalization: cli.normalization,
      output_kind: cli.outputKind,
    },
    total: results.length,
    results,
  };

  console.log(JSON.stringify(payload, null, 2));
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ONNX inference failed: ${message}`);
  process.exit(1);
});
