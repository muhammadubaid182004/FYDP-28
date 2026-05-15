import { classifyRequest, type ScreeningOutcome } from "./api";
import { getStoredToken } from "./auth";

export type Prediction = ScreeningOutcome;

export interface InferenceResult {
  predictionId: string;
  prediction: Prediction;
  confidence: number;
  processingTime: number;
  recommendation: string;
  createdAt: string;
  imageDataUrl?: string;
}

export async function runInference(
  imageFile: File,
  patient: { name: string; cnic: string; phone: string },
): Promise<InferenceResult> {
  const token = getStoredToken();
  if (!token) {
    throw new Error("Not authenticated. Please login first.");
  }

  const response = await classifyRequest(imageFile, patient, token);
  const prediction: Prediction =
    response.screening_outcome === "NRDR" ||
    response.severity === "No DR" ||
    response.severity === "Mild DR"
      ? "NRDR"
      : "RDR";

  return {
    predictionId: response.prediction_id,
    prediction,
    confidence: response.confidence,
    processingTime: response.jetson_inference_time,
    recommendation: response.recommendation,
    createdAt: response.created_at,
    imageDataUrl: response.image_data_url,
  };
}
