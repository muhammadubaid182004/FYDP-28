/**
 * API client for Node.js Express backend
 * Communicates with backend that forwards to Jetson Orin Nano
 */

import { useState } from "react";

export interface ClassificationResult {
  prediction_id: string;
  severity: string;
  confidence: number;
  recommendation: string;
  jetson_inference_time: number;
  created_at: string;
  model_version: string;
}

export function useClassificationAPI() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClassificationResult | null>(null);

  const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

  /**
   * Get JWT token from localStorage
   */
  const getToken = (): string | null => {
    return localStorage.getItem("dr_token");
  };

  /**
   * Get auth headers with JWT token
   */
  const getAuthHeaders = () => {
    const token = getToken();
    return token
      ? { Authorization: `Bearer ${token}` }
      : {};
  };

  /**
   * Send image to Node backend for classification via Jetson
   */
  const classify = async (file: File): Promise<ClassificationResult> => {
    try {
      setLoading(true);
      setError(null);

      const token = getToken();
      if (!token) {
        throw new Error("Not authenticated. Please login first.");
      }

      // Create form data
      const formData = new FormData();
      formData.append("file", file);

      // Send to backend (backend forwards to Jetson)
      const response = await fetch(`${apiUrl}/api/classify`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || 
          errorData.details ||
          "Classification failed"
        );
      }

      const data: ClassificationResult = await response.json();
      setResult(data);
      return data;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get user's prediction history
   */
  const getPredictionHistory = async () => {
    try {
      const response = await fetch(
        `${apiUrl}/api/predictions`,
        {
          headers: getAuthHeaders(),
        }
      );

      if (!response.ok) throw new Error("Failed to fetch history");
      return await response.json();
    } catch (err) {
      console.error("Error fetching history:", err);
      throw err;
    }
  };

  /**
   * Get specific prediction details
   */
  const getPrediction = async (predictionId: string) => {
    try {
      const response = await fetch(
        `${apiUrl}/api/predictions/${predictionId}`,
        {
          headers: getAuthHeaders(),
        }
      );

      if (!response.ok) throw new Error("Failed to fetch prediction");
      return await response.json();
    } catch (err) {
      console.error("Error fetching prediction:", err);
      throw err;
    }
  };

  /**
   * Get analytics summary
   */
  const getAnalytics = async () => {
    try {
      const response = await fetch(
        `${apiUrl}/api/analytics/summary`,
        {
          headers: getAuthHeaders(),
        }
      );

      if (!response.ok) throw new Error("Failed to fetch analytics");
      return await response.json();
    } catch (err) {
      console.error("Error fetching analytics:", err);
      throw err;
    }
  };

  /**
   * Check backend health and Jetson connectivity
   */
  const checkHealth = async () => {
    try {
      const response = await fetch(`${apiUrl}/healthz`);
      return await response.json();
    } catch (err) {
      console.error("Health check failed:", err);
      return {
        status: "unhealthy",
        error: "Backend unreachable",
      };
    }
  };

  return {
    classify,
    getPredictionHistory,
    getPrediction,
    getAnalytics,
    checkHealth,
    loading,
    error,
    result,
  };
}
