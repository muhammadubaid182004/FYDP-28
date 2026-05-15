import { useState, useRef } from "react";
import { useApp } from "@/context/AppContext";
import { runInference } from "@/lib/modelInference";
import Layout from "@/components/Layout";
import ImageModal from "@/components/ImageModal";
import {
  Upload,
  User,
  CreditCard,
  Phone,
  ZoomIn,
  Check,
  X,
  Cpu,
  AlertTriangle,
  CheckCircle,
  Clock,
} from "lucide-react";

interface PendingInferenceResult {
  id: string;
  name: string;
  cnic: string;
  phone: string;
  scanImage: string;
  date: string;
  prediction: "NRDR" | "RDR";
  confidence: number;
}

function truncatePercent(value: number) {
  return Math.trunc(value * 100);
}

interface ReviewCommentModalProps {
  predictionId: string;
  action: "accepted" | "rejected";
  closePreview: boolean;
  submitError: string | null;
  onConfirm: (
    predictionId: string,
    action: "accepted" | "rejected",
    closePreview: boolean,
    comment: string,
  ) => void;
  onCancel: () => void;
}

function ReviewCommentModal({
  predictionId,
  action,
  closePreview,
  submitError,
  onConfirm,
  onCancel,
}: ReviewCommentModalProps) {
  const [comment, setComment] = useState("");
  const isAccept = action === "accepted";
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        className="bg-[#0f172a] border border-slate-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-comment-title"
      >
        <h3 id="review-comment-title" className="text-white font-semibold text-base mb-2">
          {isAccept ? "Accept prediction" : "Reject prediction"}
        </h3>
        <p className="text-slate-400 text-sm mb-4">
          {isAccept
            ? "Confirm the model is correct. Optional clinical comment."
            : "Disagree with the model. Optional clinical comment. If the model predicted RDR, the image is stored under the NRDR prefix; if it predicted NRDR, it stays under NRDR."}
        </p>
        {submitError && (
          <div className="mb-3 rounded-xl border border-red-800/80 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {submitError}
          </div>
        )}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            isAccept
              ? "e.g. Accepted — matches clinical findings…"
              : "e.g. Rejected — false positive, patient is NRDR…"
          }
          rows={3}
          className="w-full px-4 py-3 bg-[#1e293b] border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 text-sm resize-none"
        />
        <div className="flex gap-3 mt-4">
          <button
            type="button"
            onClick={() => onConfirm(predictionId, action, closePreview, comment)}
            className={`flex-1 py-2.5 font-semibold rounded-xl text-sm transition-all ${
              isAccept
                ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:from-emerald-400 hover:to-teal-500"
                : "bg-gradient-to-r from-red-500 to-rose-600 text-white hover:from-red-400 hover:to-rose-500"
            }`}
          >
            {isAccept ? "Confirm accept" : "Confirm reject"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl text-sm transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface ResultPreviewModalProps {
  result: PendingInferenceResult;
  onClose: () => void;
  onAccept: () => void;
  onReject: () => void;
  onMoveToTable: () => void;
}

function ResultPreviewModal({
  result,
  onClose,
  onAccept,
  onReject,
  onMoveToTable,
}: ResultPreviewModalProps) {
  const confidencePercent = truncatePercent(result.confidence);
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (confidencePercent / 100) * circumference;
  const isNrdr = result.prediction === "NRDR";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0f172a] border border-slate-700 rounded-2xl p-6 w-full max-w-lg mx-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-white font-semibold text-lg">Classification Result</h3>
            <p className="text-slate-400 text-sm mt-1">
              Review this result before moving it to the table.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-6 flex items-center justify-center">
          <div className="relative w-40 h-40">
            <svg className="w-40 h-40 -rotate-90" viewBox="0 0 140 140">
              <circle
                cx="70"
                cy="70"
                r={radius}
                stroke="rgb(30 41 59)"
                strokeWidth="12"
                fill="transparent"
              />
              <circle
                cx="70"
                cy="70"
                r={radius}
                stroke={isNrdr ? "rgb(16 185 129)" : "rgb(239 68 68)"}
                strokeWidth="12"
                fill="transparent"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeOffset}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-white">{confidencePercent}%</span>
              <span className="text-xs text-slate-400 mt-1">Confidence</span>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-center">
          {isNrdr ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
              <CheckCircle className="w-3.5 h-3.5" /> NRDR
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/25">
              <AlertTriangle className="w-3.5 h-3.5" /> RDR
            </span>
          )}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2">
          <button
            onClick={onAccept}
            className="py-2.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 hover:border-emerald-500/50 text-emerald-400 rounded-xl text-sm font-semibold transition-all"
          >
            Accept
          </button>
          <button
            onClick={onReject}
            className="py-2.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 hover:border-red-500/50 text-red-400 rounded-xl text-sm font-semibold transition-all"
          >
            Reject
          </button>
          <button
            onClick={onMoveToTable}
            className="py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-xl text-sm font-semibold transition-all"
          >
            Move to Table
          </button>
        </div>
      </div>
    </div>
  );
}

interface ReviewCommentFlowState {
  id: string;
  action: "accepted" | "rejected";
  closePreview: boolean;
}

export default function Inference() {
  const { underReview, addUnderReview, acceptRecord, rejectRecord } = useApp();
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [cnic, setCnic] = useState("");
  const [phone, setPhone] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [imageModal, setImageModal] = useState<string | null>(null);
  const [reviewCommentFlow, setReviewCommentFlow] = useState<ReviewCommentFlowState | null>(null);
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PendingInferenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleFile = (file: File) => {
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  };

  const handleRunInference = async () => {
    if (!imageFile || !patientName || !cnic || !phone) return;
    setRunning(true);
    setProgress(0);
    setError(null);

    const interval = setInterval(() => {
      setProgress((prev) => Math.min(prev + Math.random() * 15, 90));
    }, 300);

    try {
      const result = await runInference(imageFile, {
        name: patientName,
        cnic,
        phone,
      });

      clearInterval(interval);
      setProgress(100);
      await new Promise((r) => setTimeout(r, 400));

      const stagedResult: PendingInferenceResult = {
        id: result.predictionId,
        name: patientName,
        cnic,
        phone,
        scanImage: result.imageDataUrl || imagePreview!,
        date: result.createdAt.split("T")[0],
        prediction: result.prediction,
        confidence: result.confidence,
      };
      setPreviewResult(stagedResult);
      setImageFile(null);
      setImagePreview(null);
      setPatientName("");
      setCnic("");
      setPhone("");
    } catch (err) {
      clearInterval(interval);
      setError(err instanceof Error ? err.message : "Inference failed.");
    } finally {
      setRunning(false);
      setProgress(0);
    }
  };

  const handleAccept = (id: string) => {
    setReviewSubmitError(null);
    setReviewCommentFlow({ id, action: "accepted", closePreview: false });
  };

  const confirmReview = async (
    predictionId: string,
    action: "accepted" | "rejected",
    closePreview: boolean,
    comment: string,
  ) => {
    setReviewSubmitError(null);
    try {
      if (action === "accepted") {
        await acceptRecord(predictionId, comment);
      } else {
        await rejectRecord(predictionId, comment);
      }
      setReviewCommentFlow(null);
      if (closePreview) {
        setPreviewResult(null);
      }
    } catch (e) {
      setReviewSubmitError(e instanceof Error ? e.message : "Review failed.");
    }
  };

  const handleReject = (id: string) => {
    setReviewSubmitError(null);
    setReviewCommentFlow({ id, action: "rejected", closePreview: false });
  };

  const handlePreviewAccept = () => {
    if (!previewResult) return;
    setReviewSubmitError(null);
    setReviewCommentFlow({ id: previewResult.id, action: "accepted", closePreview: true });
  };

  const handlePreviewReject = () => {
    if (!previewResult) return;
    setReviewSubmitError(null);
    setReviewCommentFlow({ id: previewResult.id, action: "rejected", closePreview: true });
  };

  const handleMoveToTable = () => {
    if (!previewResult) return;
    addUnderReview({
      ...previewResult,
      status: "pending",
    });
    setPreviewResult(null);
  };

  const isFormValid = imageFile && patientName.trim() && cnic.trim() && phone.trim();

  return (
    <Layout>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Inference Engine</h1>
          <p className="text-slate-400 text-sm mt-1">Upload retinal scans and run AI-powered DR classification</p>
        </div>

        <div className="mb-8">
          <div className="bg-[#0f172a] border border-slate-800/60 rounded-2xl p-6">
            <h3 className="text-white font-semibold text-base mb-5 flex items-center gap-2">
              <Cpu className="w-5 h-5 text-cyan-400" />
              New Scan Analysis
            </h3>

            <div className="grid grid-cols-2 gap-6">
              {/* Left — image drop zone */}
              <div
                ref={dropRef}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => !imagePreview && fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl transition-all duration-200 h-full min-h-[220px] flex flex-col ${
                  imagePreview
                    ? "border-cyan-500/30 cursor-default"
                    : "border-slate-700 hover:border-cyan-500/50 cursor-pointer"
                }`}
              >
                {imagePreview ? (
                  <div className="p-4 flex-1 flex flex-col">
                    <div className="relative group/scan flex-1">
                      <img
                        src={imagePreview}
                        alt="Selected scan"
                        className="w-full h-full max-h-48 object-contain rounded-lg bg-black/20"
                      />
                      <div className="absolute inset-0 rounded-lg bg-black/50 opacity-0 group-hover/scan:opacity-100 flex items-center justify-center gap-3 transition-all duration-200">
                        <button
                          onClick={(e) => { e.stopPropagation(); setImageModal(imagePreview); }}
                          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all"
                          title="View full size"
                        >
                          <ZoomIn className="w-5 h-5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setImageFile(null); setImagePreview(null); }}
                          className="p-2 bg-white/10 hover:bg-red-500/30 rounded-lg text-white transition-all"
                          title="Remove"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500 text-center mt-2">{imageFile?.name}</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center flex-1 px-4 py-10">
                    <div className="w-14 h-14 rounded-xl bg-cyan-500/10 flex items-center justify-center mb-3">
                      <Upload className="w-7 h-7 text-cyan-400" />
                    </div>
                    <p className="text-slate-300 font-medium text-sm">Drop retinal scan here</p>
                    <p className="text-slate-500 text-xs mt-1">or click to browse — PNG, JPG, JPEG</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  className="hidden"
                />
              </div>

              {/* Right — patient details + run */}
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" /> Patient Name
                  </label>
                  <input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="Full name"
                    className="w-full px-4 py-2.5 bg-[#1e293b] border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 text-sm transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 flex items-center gap-1.5">
                    <CreditCard className="w-3.5 h-3.5" /> CNIC
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={9999999999999}
                    value={cnic}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "").slice(0, 13);
                      setCnic(digits);
                    }}
                    placeholder="13-digit CNIC"
                    className="w-full px-4 py-2.5 bg-[#1e293b] border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 text-sm font-mono transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5 flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" /> Contact
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={99999999999}
                    value={phone}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "").slice(0, 11);
                      setPhone(digits);
                    }}
                    placeholder="11-digit contact"
                    className="w-full px-4 py-2.5 bg-[#1e293b] border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 text-sm font-mono transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>

                {running && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-400 font-medium">Running classification model...</span>
                      <span className="text-xs text-cyan-400 font-mono">{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-500 to-blue-600 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="text-xs text-slate-500 mt-2 text-center">
                      {progress < 30 ? "Loading model weights..." : progress < 60 ? "Preprocessing image..." : progress < 85 ? "Running inference..." : "Finalizing results..."}
                    </p>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                )}

                <button
                  onClick={handleRunInference}
                  disabled={!isFormValid || running}
                  className="mt-auto py-3 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:from-slate-700 disabled:to-slate-800 disabled:text-slate-500 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30 disabled:shadow-none disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
                >
                  <Cpu className="w-4 h-4" />
                  {running ? "Running Model..." : "Run Inference"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#0f172a] border border-slate-800/60 rounded-2xl">
          <div className="px-6 py-5 border-b border-slate-800/60 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-white font-semibold text-base">Under Review</h3>
              {underReview.length > 0 && (
                <span className="bg-amber-500 text-black text-xs font-bold px-2.5 py-0.5 rounded-full">
                  {underReview.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <Clock className="w-3.5 h-3.5" />
              Awaiting physician review
            </div>
          </div>

          {underReview.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 px-4">
              <div className="w-16 h-16 rounded-2xl bg-slate-800/60 flex items-center justify-center mb-4">
                <Clock className="w-8 h-8 text-slate-600" />
              </div>
              <p className="text-slate-400 font-medium text-sm">No records under review</p>
              <p className="text-slate-600 text-xs mt-1">Run inference on a scan to see results here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-800/60">
                    {["Patient Name", "CNIC", "Contact", "Scan", "Date", "Prediction", "Confidence", "Actions"].map((h) => (
                      <th key={h} className="px-5 py-3.5 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {underReview.map((record) => (
                    <tr key={record.id} className="hover:bg-slate-800/20 transition-colors duration-150">
                      <td className="px-5 py-4">
                        <span className="text-white text-sm font-medium">{record.name}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-slate-300 text-sm font-mono">{record.cnic}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-slate-300 text-sm">{record.phone}</span>
                      </td>
                      <td className="px-5 py-4">
                        <button
                          onClick={() => setImageModal(record.scanImage)}
                          className="relative group/img"
                        >
                          <img
                            src={record.scanImage}
                            alt="Retinal scan"
                            className="w-12 h-12 rounded-lg object-cover border border-slate-700 group-hover/img:border-cyan-500/50 transition-all duration-200"
                          />
                          <div className="absolute inset-0 rounded-lg bg-black/50 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all duration-200">
                            <ZoomIn className="w-4 h-4 text-white" />
                          </div>
                        </button>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-slate-300 text-sm">{new Date(record.date).toLocaleDateString("en-GB")}</span>
                      </td>
                      <td className="px-5 py-4">
                        {record.prediction === "NRDR" ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle className="w-3 h-3" /> NRDR
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
                            <AlertTriangle className="w-3 h-3" /> RDR
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-slate-800 rounded-full h-1.5 w-16 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${record.prediction === "NRDR" ? "bg-emerald-500" : "bg-red-500"}`}
                              style={{ width: `${truncatePercent(record.confidence)}%` }}
                            />
                          </div>
                          <span className="text-slate-300 text-xs font-mono font-semibold">
                            {truncatePercent(record.confidence)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleAccept(record.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 hover:border-emerald-500/50 text-emerald-400 rounded-lg text-xs font-semibold transition-all duration-200"
                          >
                            <Check className="w-3.5 h-3.5" /> Accept
                          </button>
                          <button
                            onClick={() => handleReject(record.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 hover:border-red-500/50 text-red-400 rounded-lg text-xs font-semibold transition-all duration-200"
                          >
                            <X className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {imageModal && <ImageModal src={imageModal} onClose={() => setImageModal(null)} />}
      {previewResult && (
        <ResultPreviewModal
          result={previewResult}
          onClose={() => setPreviewResult(null)}
          onAccept={handlePreviewAccept}
          onReject={handlePreviewReject}
          onMoveToTable={handleMoveToTable}
        />
      )}
      {reviewCommentFlow && (
        <ReviewCommentModal
          key={`${reviewCommentFlow.id}-${reviewCommentFlow.action}`}
          predictionId={reviewCommentFlow.id}
          action={reviewCommentFlow.action}
          closePreview={reviewCommentFlow.closePreview}
          submitError={reviewSubmitError}
          onConfirm={(predictionId, action, closePreview, comment) => {
            void confirmReview(predictionId, action, closePreview, comment);
          }}
          onCancel={() => {
            setReviewCommentFlow(null);
            setReviewSubmitError(null);
          }}
        />
      )}
    </Layout>
  );
}
