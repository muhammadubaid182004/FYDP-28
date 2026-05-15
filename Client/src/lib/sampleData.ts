export type ScanResult = "NRDR" | "RDR" | "Under Review";

export type ReviewOutcome = "pending" | "accepted" | "rejected";

/**
 * Final referability after expert review.
 * NRDR + accepted → NRDR; NRDR + rejected → RDR (expert upgrades to referable).
 * RDR + accepted → RDR; RDR + rejected → NRDR (expert downgrades).
 * Matches reviewed-image routing in the API.
 */
export function finalScreeningOutcome(
  modelPrediction: "NRDR" | "RDR",
  reviewStatus: ReviewOutcome,
): ScanResult {
  if (reviewStatus === "pending") return "Under Review";
  if (reviewStatus === "accepted") return modelPrediction;
  if (modelPrediction === "RDR") return "NRDR";
  return "RDR";
}

export interface PatientRecord {
  id: string;
  name: string;
  cnic: string;
  phone: string;
  scanImage: string;
  date: string;
  /** Final referability for dashboards (derived from model + review). */
  result: ScanResult;
  modelPrediction: "NRDR" | "RDR";
  reviewStatus: ReviewOutcome;
  comments: string;
}

export interface UnderReviewRecord {
  id: string;
  name: string;
  cnic: string;
  phone: string;
  scanImage: string;
  date: string;
  prediction: "NRDR" | "RDR";
  confidence: number;
  status: "pending";
}

export const SAMPLE_SCAN_IMAGES = [
  "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Fundus_photograph_of_normal_right_eye.jpg/800px-Fundus_photograph_of_normal_right_eye.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b9/Fundus_photo_showing_scatter_laser_surgery_for_diabetic_retinopathy%2C_EDA.jpg/800px-Fundus_photo_showing_scatter_laser_surgery_for_diabetic_retinopathy%2C_EDA.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Fundus_photograph_of_normal_right_eye.jpg/800px-Fundus_photograph_of_normal_right_eye.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b9/Fundus_photo_showing_scatter_laser_surgery_for_diabetic_retinopathy%2C_EDA.jpg/800px-Fundus_photo_showing_scatter_laser_surgery_for_diabetic_retinopathy%2C_EDA.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Fundus_photograph_of_normal_right_eye.jpg/800px-Fundus_photograph_of_normal_right_eye.jpg",
];

export const INITIAL_PATIENTS: PatientRecord[] = [
  {
    id: "p1",
    name: "Muhammad Ali",
    cnic: "35202-1234567-1",
    phone: "0300-1234567",
    scanImage: SAMPLE_SCAN_IMAGES[0],
    date: "2025-12-10",
    modelPrediction: "NRDR",
    reviewStatus: "accepted",
    result: "NRDR",
    comments: "No diabetic retinopathy detected. Follow-up in 12 months.",
  },
  {
    id: "p2",
    name: "Fatima Zahra",
    cnic: "35202-7654321-2",
    phone: "0301-9876543",
    scanImage: SAMPLE_SCAN_IMAGES[1],
    date: "2026-01-15",
    modelPrediction: "RDR",
    reviewStatus: "accepted",
    result: "RDR",
    comments: "Moderate NPDR detected. Refer to retinal specialist.",
  },
  {
    id: "p3",
    name: "Imran Sheikh",
    cnic: "42101-3456789-3",
    phone: "0333-2345678",
    scanImage: SAMPLE_SCAN_IMAGES[2],
    date: "2026-01-22",
    modelPrediction: "NRDR",
    reviewStatus: "accepted",
    result: "NRDR",
    comments: "Mild changes, monitor closely.",
  },
  {
    id: "p4",
    name: "Ayesha Siddiqui",
    cnic: "42201-9876543-4",
    phone: "0345-6789012",
    scanImage: SAMPLE_SCAN_IMAGES[3],
    date: "2026-02-05",
    modelPrediction: "RDR",
    reviewStatus: "accepted",
    result: "RDR",
    comments: "Proliferative DR found. Urgent laser therapy recommended.",
  },
  {
    id: "p5",
    name: "Bilal Akhtar",
    cnic: "35101-4567890-5",
    phone: "0321-3456789",
    scanImage: SAMPLE_SCAN_IMAGES[0],
    date: "2026-02-18",
    modelPrediction: "NRDR",
    reviewStatus: "accepted",
    result: "NRDR",
    comments: "Normal fundus. Annual screening advised.",
  },
  {
    id: "p6",
    name: "Sana Malik",
    cnic: "35202-5678901-6",
    phone: "0312-4567890",
    scanImage: SAMPLE_SCAN_IMAGES[1],
    date: "2026-03-01",
    modelPrediction: "RDR",
    reviewStatus: "accepted",
    result: "RDR",
    comments: "Background DR with macular edema. Immediate treatment required.",
  },
  {
    id: "p7",
    name: "Hassan Raza",
    cnic: "35301-6789012-7",
    phone: "0323-5678901",
    scanImage: SAMPLE_SCAN_IMAGES[2],
    date: "2026-03-12",
    modelPrediction: "NRDR",
    reviewStatus: "accepted",
    result: "NRDR",
    comments: "Minimal findings. Regular check-up in 6 months.",
  },
  {
    id: "p8",
    name: "Zainab Hussain",
    cnic: "35401-7890123-8",
    phone: "0334-6789012",
    scanImage: SAMPLE_SCAN_IMAGES[3],
    date: "2026-03-25",
    modelPrediction: "RDR",
    reviewStatus: "pending",
    result: "Under Review",
    comments: "Borderline case. Pending specialist opinion.",
  },
];

export const INITIAL_UNDER_REVIEW: UnderReviewRecord[] = [
  {
    id: "ur1",
    name: "Kamran Yousaf",
    cnic: "35202-8901234-1",
    phone: "0311-8901234",
    scanImage: SAMPLE_SCAN_IMAGES[1],
    date: "2026-04-06",
    prediction: "RDR",
    confidence: 0.87,
    status: "pending",
  },
  {
    id: "ur2",
    name: "Nadia Farooq",
    cnic: "42301-2345678-2",
    phone: "0322-2345678",
    scanImage: SAMPLE_SCAN_IMAGES[0],
    date: "2026-04-07",
    prediction: "NRDR",
    confidence: 0.93,
    status: "pending",
  },
  {
    id: "ur3",
    name: "Tariq Mehmood",
    cnic: "35101-3456789-3",
    phone: "0333-3456789",
    scanImage: SAMPLE_SCAN_IMAGES[3],
    date: "2026-04-08",
    prediction: "RDR",
    confidence: 0.76,
    status: "pending",
  },
];

export const MONTHLY_RDR_DATA = [
  { month: "Aug", cases: 2 },
  { month: "Sep", cases: 4 },
  { month: "Oct", cases: 3 },
  { month: "Nov", cases: 5 },
  { month: "Dec", cases: 6 },
  { month: "Jan", cases: 4 },
  { month: "Feb", cases: 7 },
  { month: "Mar", cases: 3 },
];

export const MONTHLY_NRDR_DATA = [
  { month: "Aug", cases: 8 },
  { month: "Sep", cases: 12 },
  { month: "Oct", cases: 10 },
  { month: "Nov", cases: 14 },
  { month: "Dec", cases: 11 },
  { month: "Jan", cases: 16 },
  { month: "Feb", cases: 13 },
  { month: "Mar", cases: 18 },
];
