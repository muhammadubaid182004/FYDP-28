const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export interface User {
  id: string;
  username: string;
  email?: string;
  name: string;
  role: string;
}

export interface LoginResponse {
  message: string;
  user: User;
  token: string;
}

export type ScreeningOutcome = "NRDR" | "RDR";

export interface ClassificationResponse {
  prediction_id: string;
  severity: string;
  confidence: number;
  recommendation: string;
  jetson_inference_time: number;
  created_at: string;
  model_version: string;
  patient_name?: string;
  cnic?: string;
  phone?: string;
  image_data_url?: string;
  review_status?: "pending" | "accepted" | "rejected";
  clinician_comment?: string;
  screening_outcome?: ScreeningOutcome;
}

export interface PredictionHistoryResponse {
  total: number;
  predictions: ClassificationResponse[];
}

function buildHeaders(token?: string, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  token?: string,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: buildHeaders(token, init?.headers),
  });

  if (!response.ok) {
    let message = "Request failed";
    try {
      const errorBody = await response.json();
      message = errorBody.details || errorBody.error || message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export async function loginRequest(username: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
}

export async function classifyRequest(
  file: File,
  patient: { name: string; cnic: string; phone: string },
  token: string,
): Promise<ClassificationResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("patientName", patient.name);
  formData.append("cnic", patient.cnic);
  formData.append("phone", patient.phone);

  return apiFetch<ClassificationResponse>(
    "/api/classify",
    {
      method: "POST",
      body: formData,
    },
    token,
  );
}

export async function getPredictions(token: string): Promise<PredictionHistoryResponse> {
  return apiFetch<PredictionHistoryResponse>("/api/predictions", undefined, token);
}

export async function reviewPrediction(
  predictionId: string,
  action: "accepted" | "rejected",
  clinicianComment: string,
  token: string,
): Promise<ClassificationResponse> {
  return apiFetch<ClassificationResponse>(
    `/api/predictions/${predictionId}/review`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, clinicianComment }),
    },
    token,
  );
}

export async function validateStoredSession(token: string): Promise<boolean> {
  try {
    await getPredictions(token);
    return true;
  } catch {
    return false;
  }
}

export { API_BASE_URL };
