import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { type User, getStoredUser, getStoredToken, clearToken, storeToken, storeUser, isAuthenticated } from "@/lib/auth";
import {
  type PatientRecord,
  type UnderReviewRecord,
  finalScreeningOutcome,
} from "@/lib/sampleData";
import { getPredictions, reviewPrediction, type ClassificationResponse } from "@/lib/api";

interface AppContextType {
  user: User | null;
  isLoggedIn: boolean;
  login: (user: User, token: string) => void;
  logout: () => void;
  patients: PatientRecord[];
  underReview: UnderReviewRecord[];
  addUnderReview: (record: UnderReviewRecord) => void;
  acceptRecord: (id: string, comments: string) => Promise<void>;
  rejectRecord: (id: string, comments: string) => Promise<void>;
  refreshPredictions: () => Promise<void>;
  dataLoading: boolean;
}

function toPatientRecord(prediction: ClassificationResponse): PatientRecord {
  const modelPrediction: "NRDR" | "RDR" =
    prediction.screening_outcome === "NRDR" ? "NRDR" : "RDR";
  const reviewStatus = prediction.review_status ?? "pending";
  const result = finalScreeningOutcome(modelPrediction, reviewStatus);

  return {
    id: prediction.prediction_id,
    name: prediction.patient_name || "Unknown Patient",
    cnic: prediction.cnic || "N/A",
    phone: prediction.phone || "N/A",
    scanImage: prediction.image_data_url || "https://placehold.co/120x120?text=Scan",
    date: prediction.created_at.split("T")[0],
    result,
    modelPrediction,
    reviewStatus,
    comments:
      prediction.clinician_comment ||
      prediction.recommendation ||
      (reviewStatus === "pending"
        ? "Awaiting clinician review."
        : reviewStatus === "rejected"
          ? "Clinician rejected the model call."
          : "Reviewed by clinician."),
  };
}

function toUnderReviewRecord(prediction: ClassificationResponse): UnderReviewRecord {
  return {
    id: prediction.prediction_id,
    name: prediction.patient_name || "Unknown Patient",
    cnic: prediction.cnic || "N/A",
    phone: prediction.phone || "N/A",
    scanImage: prediction.image_data_url || "https://placehold.co/120x120?text=Scan",
    date: prediction.created_at.split("T")[0],
    prediction: prediction.screening_outcome === "NRDR" ? "NRDR" : "RDR",
    confidence: Number(prediction.confidence),
    status: "pending",
  };
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [underReview, setUnderReview] = useState<UnderReviewRecord[]>([]);
  const [dataLoading, setDataLoading] = useState(false);

  const refreshPredictions = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setPatients([]);
      setUnderReview([]);
      return;
    }

    setDataLoading(true);
    try {
      const { predictions } = await getPredictions(token);
      setPatients(
        predictions
          .filter(
            (prediction) =>
              prediction.review_status === "accepted" || prediction.review_status === "rejected",
          )
          .map(toPatientRecord),
      );
      setUnderReview(
        predictions
          .filter((prediction) => prediction.review_status === "pending")
          .map(toUnderReviewRecord),
      );
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    isAuthenticated().then((valid) => {
      if (valid) {
        const stored = getStoredUser();
        if (stored) {
          setUser(stored);
          setIsLoggedIn(true);
        }
      }
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      void refreshPredictions();
    } else {
      setPatients([]);
      setUnderReview([]);
    }
  }, [isLoggedIn, refreshPredictions]);

  const login = useCallback((u: User, token: string) => {
    storeToken(token);
    storeUser(u);
    setUser(u);
    setIsLoggedIn(true);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setIsLoggedIn(false);
    setPatients([]);
    setUnderReview([]);
  }, []);

  const addUnderReview = useCallback((record: UnderReviewRecord) => {
    setUnderReview((prev) => {
      if (prev.some((item) => item.id === record.id)) {
        return prev;
      }
      return [record, ...prev];
    });
  }, []);

  const acceptRecord = useCallback(async (id: string, comments: string) => {
    const token = getStoredToken();
    if (!token) {
      throw new Error("Not authenticated.");
    }

    await reviewPrediction(id, "accepted", comments, token);
    await refreshPredictions();
  }, [refreshPredictions]);

  const rejectRecord = useCallback(async (id: string, comments: string) => {
    const token = getStoredToken();
    if (!token) {
      throw new Error("Not authenticated.");
    }

    await reviewPrediction(id, "rejected", comments, token);
    await refreshPredictions();
  }, [refreshPredictions]);

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <AppContext.Provider
      value={{
        user,
        isLoggedIn,
        login,
        logout,
        patients,
        underReview,
        addUnderReview,
        acceptRecord,
        rejectRecord,
        refreshPredictions,
        dataLoading,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
