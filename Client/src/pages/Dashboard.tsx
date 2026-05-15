import { useState, useRef } from "react";
import { useApp } from "@/context/AppContext";
import {
  MONTHLY_RDR_DATA,
  MONTHLY_NRDR_DATA,
  type PatientRecord,
  type ReviewOutcome,
} from "@/lib/sampleData";
import Layout from "@/components/Layout";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  ScanEye,
  CheckCircle,
  AlertTriangle,
  Clock,
  Download,
  ZoomIn,
  Loader2,
} from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ImageModal from "@/components/ImageModal";

type PdfState = "idle" | "generating" | "done";

function truncatePercent(value: number) {
  return Math.trunc(value * 100);
}

export default function Dashboard() {
  const { patients, underReview } = useApp();
  const [imageModal, setImageModal] = useState<string | null>(null);
  const [pdfState, setPdfState] = useState<PdfState>("idle");
  const tableRef = useRef<HTMLDivElement>(null);
  const allPatientRows: PatientRecord[] = [
    ...patients,
    ...underReview.map((record) => ({
      id: record.id,
      name: record.name,
      cnic: record.cnic,
      phone: record.phone,
      scanImage: record.scanImage,
      date: record.date,
      modelPrediction: record.prediction,
      reviewStatus: "pending" as const,
      result: "Under Review" as const,
      comments: `AI predicted ${record.prediction} (${truncatePercent(record.confidence)}% confidence). Awaiting clinician review.`,
    })),
  ];

  const totalScans = patients.length + underReview.length;
  const nrdrCases = patients.filter((p) => p.result === "NRDR").length;
  const rdrCases = patients.filter((p) => p.result === "RDR").length;
  const underReviewCases = underReview.length;

  const cards = [
    {
      label: "Total Scans",
      value: totalScans,
      icon: ScanEye,
      color: "from-cyan-500 to-blue-600",
      glow: "shadow-cyan-500/25",
      textColor: "text-cyan-400",
      bg: "bg-cyan-500/10",
    },
    {
      label: "NRDR Cases",
      value: nrdrCases,
      icon: CheckCircle,
      color: "from-emerald-500 to-teal-600",
      glow: "shadow-emerald-500/25",
      textColor: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "RDR Cases",
      value: rdrCases,
      icon: AlertTriangle,
      color: "from-red-500 to-rose-600",
      glow: "shadow-red-500/25",
      textColor: "text-red-400",
      bg: "bg-red-500/10",
    },
    {
      label: "Under Review",
      value: underReviewCases,
      icon: Clock,
      color: "from-amber-500 to-orange-600",
      glow: "shadow-amber-500/25",
      textColor: "text-amber-400",
      bg: "bg-amber-500/10",
    },
  ];

  const handleExportPDF = async () => {
    if (pdfState !== "idle") return;
    setPdfState("generating");

    // Yield to the browser so the spinner renders before jsPDF blocks the thread
    await new Promise((r) => setTimeout(r, 50));

    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFillColor(10, 15, 30);
    doc.rect(0, 0, 297, 210, "F");
    doc.setTextColor(200, 220, 255);
    doc.setFontSize(18);
    doc.text("RetinaScan AI - Patient Details Report", 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(150, 170, 200);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 26);

    const expertLabel = (status: ReviewOutcome) => {
      if (status === "pending") return "Pending";
      if (status === "accepted") return "Accepted";
      return "Rejected";
    };

    const rows = allPatientRows.map((p) => [
      p.name,
      p.cnic,
      p.phone,
      p.date,
      p.modelPrediction,
      expertLabel(p.reviewStatus),
      p.result,
      p.comments,
    ]);

    autoTable(doc, {
      startY: 32,
      head: [
        [
          "Patient Name",
          "CNIC",
          "Phone",
          "Date",
          "Model prediction",
          "Expert decision",
          "Final decision",
          "Comments",
        ],
      ],
      body: rows,
      styles: {
        fillColor: [15, 23, 42],
        textColor: [200, 220, 255],
        fontSize: 9,
        lineColor: [30, 41, 59],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [6, 182, 212],
        textColor: [0, 0, 0],
        fontStyle: "bold",
      },
      alternateRowStyles: {
        fillColor: [20, 30, 50],
      },
      columnStyles: {
        6: {
          fontStyle: "bold",
        },
      },
    });

    doc.save("retinascan-report.pdf");
    setPdfState("done");
    setTimeout(() => setPdfState("idle"), 2500);
  };

  const getScreeningBadge = (outcome: "NRDR" | "RDR") => {
    if (outcome === "NRDR")
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
          NRDR
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
        <span className="w-1.5 h-1.5 bg-red-400 rounded-full" />
        RDR
      </span>
    );
  };

  const getExpertDecisionBadge = (status: ReviewOutcome) => {
    if (status === "pending")
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">
          <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
          Pending
        </span>
      );
    if (status === "accepted")
      return (
        <span
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/25"
          title="Clinician accepted the model screening outcome"
        >
          Accepted
        </span>
      );
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/25"
        title="Clinician rejected the model call: RDR→NRDR, NRDR→RDR (final referability)"
      >
        Rejected
      </span>
    );
  };

  const getFinalDecisionBadge = (result: string) => {
    if (result === "NRDR") return getScreeningBadge("NRDR");
    if (result === "RDR") return getScreeningBadge("RDR");
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">
        <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
        Under Review
      </span>
    );
  };

  return (
    <Layout>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
          <p className="text-slate-400 text-sm mt-1">Overview of diabetic retinopathy screening analytics</p>
        </div>

        <div className="grid grid-cols-4 gap-5 mb-8">
          {cards.map(({ label, value, icon: Icon, color, glow, textColor, bg }) => (
            <div
              key={label}
              className={`bg-[#0f172a] border border-slate-800/60 rounded-2xl p-6 relative overflow-hidden group hover:border-slate-700 transition-all duration-300`}
            >
              <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl opacity-10 bg-gradient-to-br ${color} -mr-8 -mt-8`} />
              <div className={`inline-flex w-12 h-12 rounded-xl ${bg} items-center justify-center mb-4`}>
                <Icon className={`w-6 h-6 ${textColor}`} />
              </div>
              <div>
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">{label}</p>
                <p className={`text-4xl font-bold ${textColor}`}>{value}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-6 mb-8">
          <div className="bg-[#0f172a] border border-slate-800/60 rounded-2xl p-6">
            <div className="mb-5">
              <h3 className="text-white font-semibold text-base">RDR Cases Over Time</h3>
              <p className="text-slate-400 text-xs mt-0.5">Monthly Referable DR detections</p>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={MONTHLY_RDR_DATA} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="rdrGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #1e293b", borderRadius: "10px", color: "#e2e8f0" }}
                  itemStyle={{ color: "#ef4444" }}
                  labelStyle={{ color: "#94a3b8", fontWeight: 600 }}
                />
                <Area
                  type="monotone"
                  dataKey="cases"
                  stroke="#ef4444"
                  strokeWidth={2.5}
                  fill="url(#rdrGradient)"
                  dot={{ fill: "#ef4444", strokeWidth: 0, r: 4 }}
                  activeDot={{ r: 6, fill: "#ef4444", strokeWidth: 2, stroke: "#1e293b" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-[#0f172a] border border-slate-800/60 rounded-2xl p-6">
            <div className="mb-5">
              <h3 className="text-white font-semibold text-base">NRDR Cases Over Time</h3>
              <p className="text-slate-400 text-xs mt-0.5">Monthly Non-Referable DR detections</p>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={MONTHLY_NRDR_DATA} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="nrdrGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #1e293b", borderRadius: "10px", color: "#e2e8f0" }}
                  itemStyle={{ color: "#10b981" }}
                  labelStyle={{ color: "#94a3b8", fontWeight: 600 }}
                />
                <Area
                  type="monotone"
                  dataKey="cases"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  fill="url(#nrdrGradient)"
                  dot={{ fill: "#10b981", strokeWidth: 0, r: 4 }}
                  activeDot={{ r: 6, fill: "#10b981", strokeWidth: 2, stroke: "#1e293b" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#0f172a] border border-slate-800/60 rounded-2xl" ref={tableRef}>
          <div className="px-6 py-5 border-b border-slate-800/60 flex items-center justify-between">
            <div>
              <h3 className="text-white font-semibold text-base">Patient Details</h3>
              <p className="text-slate-400 text-xs mt-0.5">{allPatientRows.length} total records</p>
            </div>
            <button
              onClick={handleExportPDF}
              disabled={pdfState !== "idle"}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 border
                ${pdfState === "done"
                  ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-400 cursor-default"
                  : pdfState === "generating"
                  ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400/60 cursor-wait"
                  : "bg-gradient-to-r from-cyan-500/20 to-blue-600/20 border-cyan-500/30 hover:border-cyan-500/60 text-cyan-400 hover:text-cyan-300 cursor-pointer"
                }`}
            >
              {pdfState === "generating" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating…
                </>
              ) : pdfState === "done" ? (
                <>
                  <CheckCircle className="w-4 h-4" />
                  Downloaded!
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Export PDF
                </>
              )}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800/60">
                  {[
                    "Patient Name",
                    "CNIC",
                    "Phone",
                    "Scan",
                    "Date",
                    "Model prediction",
                    "Expert decision",
                    "Final decision",
                    "Comments",
                  ].map((h) => (
                    <th key={h} className="px-5 py-3.5 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {allPatientRows.map((patient) => (
                  <tr key={patient.id} className="hover:bg-slate-800/20 transition-colors duration-150">
                    <td className="px-5 py-4">
                      <span className="text-white text-sm font-medium">{patient.name}</span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-slate-300 text-sm font-mono">{patient.cnic}</span>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-slate-300 text-sm">{patient.phone}</span>
                    </td>
                    <td className="px-5 py-4">
                      <button
                        onClick={() => setImageModal(patient.scanImage)}
                        className="relative group/img"
                        title="Click to view full size"
                      >
                        <img
                          src={patient.scanImage}
                          alt="Retinal scan"
                          className="w-12 h-12 rounded-lg object-cover border border-slate-700 group-hover/img:border-cyan-500/50 transition-all duration-200"
                        />
                        <div className="absolute inset-0 rounded-lg bg-black/50 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all duration-200">
                          <ZoomIn className="w-4 h-4 text-white" />
                        </div>
                      </button>
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-slate-300 text-sm">{new Date(patient.date).toLocaleDateString("en-GB")}</span>
                    </td>
                    <td className="px-5 py-4">{getScreeningBadge(patient.modelPrediction)}</td>
                    <td className="px-5 py-4">{getExpertDecisionBadge(patient.reviewStatus)}</td>
                    <td className="px-5 py-4">{getFinalDecisionBadge(patient.result)}</td>
                    <td className="px-5 py-4">
                      <span className="text-slate-400 text-xs max-w-xs block truncate" title={patient.comments}>
                        {patient.comments}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {imageModal && <ImageModal src={imageModal} onClose={() => setImageModal(null)} />}
    </Layout>
  );
}
