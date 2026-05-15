import { useEffect } from "react";
import { X } from "lucide-react";

interface ImageModalProps {
  src: string;
  onClose: () => void;
}

export default function ImageModal({ src, onClose }: ImageModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-4xl max-h-[90vh] mx-4" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-4 -right-4 z-10 w-9 h-9 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-full flex items-center justify-center text-slate-300 hover:text-white transition-all duration-200"
        >
          <X className="w-4 h-4" />
        </button>
        <img
          src={src}
          alt="Retinal scan - full size"
          className="max-w-full max-h-[85vh] rounded-xl border border-slate-700 shadow-2xl object-contain"
        />
        <p className="text-center text-slate-500 text-xs mt-3">Retinal Scan — Full Resolution</p>
      </div>
    </div>
  );
}
