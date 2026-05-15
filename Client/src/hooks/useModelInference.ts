/**
 * ML Model inference hook using ONNX Runtime
 * Runs classification directly in the browser
 */

import { useState, useRef } from "react";
import * as ort from "onnxruntime-web";

export interface PredictionResult {
  class: string;
  confidence: number;
  timestamp: number;
}

export function useModelInference() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const modelRef = useRef<ort.InferenceSession | null>(null);

  // Initialize model on first use
  const initializeModel = async () => {
    if (modelRef.current) return; // Already loaded

    try {
      setLoading(true);
      // Load ONNX model from public folder
      const session = await ort.InferenceSession.create(
        "/models/dr-classification.onnx",
        { executionProviders: ["webgpu", "wasm"] }
      );
      modelRef.current = session;
    } catch (err) {
      setError(`Failed to load model: ${err instanceof Error ? err.message : "Unknown error"}`);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Preprocess image: resize to model input size (typically 224x224)
   * and normalize pixel values
   */
  const preprocessImage = (canvas: HTMLCanvasElement, inputSize: number = 224) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");

    // Create temp canvas for resizing
    const resizeCanvas = document.createElement("canvas");
    resizeCanvas.width = inputSize;
    resizeCanvas.height = inputSize;
    const resizeCtx = resizeCanvas.getContext("2d");
    if (!resizeCtx) throw new Error("Failed to get resize context");

    resizeCtx.drawImage(canvas, 0, 0, inputSize, inputSize);

    // Get image data
    const imageData = resizeCtx.getImageData(0, 0, inputSize, inputSize);
    const data = imageData.data;

    // Normalize to [0, 1] and create tensor
    const float32Data = new Float32Array((inputSize * inputSize * 3) as any);
    for (let i = 0; i < data.length; i += 4) {
      float32Data[i / 4 * 3] = data[i] / 255;      // R
      float32Data[i / 4 * 3 + 1] = data[i + 1] / 255; // G
      float32Data[i / 4 * 3 + 2] = data[i + 2] / 255; // B
    }

    return float32Data;
  };

  /**
   * Run inference on image
   */
  const classify = async (file: File): Promise<PredictionResult> => {
    try {
      setLoading(true);
      setError(null);

      // Initialize model if needed
      if (!modelRef.current) {
        await initializeModel();
      }

      // Read image file
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to get canvas context");

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = URL.createObjectURL(file);
      });

      canvas.width = image.width;
      canvas.height = image.height;
      ctx.drawImage(image, 0, 0);

      // Preprocess
      const tensorData = preprocessImage(canvas);

      // Create tensor
      const inputTensor = new ort.Tensor("float32", tensorData, [1, 3, 224, 224]);

      // Run inference
      const outputs = await modelRef.current!.run({ images: inputTensor });

      // Get predictions
      const predictions = outputs.output.data as Float32Array;

      // Find top prediction
      let maxConfidence = 0;
      let maxIndex = 0;
      for (let i = 0; i < predictions.length; i++) {
        if (predictions[i] > maxConfidence) {
          maxConfidence = predictions[i];
          maxIndex = i;
        }
      }

      // Class mapping for diabetic retinopathy
      const classLabels = [
        "No DR",              // 0
        "Mild DR",            // 1
        "Moderate DR",        // 2
        "Severe DR",          // 3
        "Proliferative DR",   // 4
      ];

      const prediction: PredictionResult = {
        class: classLabels[maxIndex] || `Class ${maxIndex}`,
        confidence: Math.round(maxConfidence * 100) / 100,
        timestamp: Date.now(),
      };

      setResult(prediction);
      return prediction;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(`Classification failed: ${errorMsg}`);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return {
    classify,
    loading,
    error,
    result,
    models: modelRef.current?.outputNames || [],
  };
}
