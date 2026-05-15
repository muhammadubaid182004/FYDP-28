/**
 * Image Classification Component
 * Handles image upload, display, and runs classification
 */

import { useState, useRef } from "react";
import { useModelInference } from "@/hooks/useModelInference";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClassificationResult {
  severity: string;
  confidence: number;
  recommendation: string;
}

function truncatePercent(value: number) {
  return Math.trunc(value * 100);
}

export function ImageClassifier() {
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ClassificationResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { classify, loading, error } = useModelInference();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file
    if (!file.type.startsWith("image/")) {
      alert("Please select an image file");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert("Image must be smaller than 10MB");
      return;
    }

    setSelectedImage(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleClassify = async () => {
    if (!selectedImage) return;

    try {
      const prediction = await classify(selectedImage);

      // Map model output to clinical recommendation
      const recommendations: Record<string, string> = {
        "No DR": "No diabetic retinopathy detected. Continue routine screening.",
        "Mild DR": "Mild DR detected. Recommend annual eye exam.",
        "Moderate DR": "Moderate DR detected. Recommend referral to ophthalmologist.",
        "Severe DR": "Severe DR detected. Urgent referral to ophthalmologist required.",
        "Proliferative DR": "Proliferative DR detected. Emergency specialist evaluation needed.",
      };

      setResult({
        severity: prediction.class,
        confidence: prediction.confidence,
        recommendation: recommendations[prediction.class] || "Classification complete.",
      });
    } catch (err) {
      console.error("Classification error:", err);
    }
  };

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      "No DR": "bg-green-50 border-green-200",
      "Mild DR": "bg-yellow-50 border-yellow-200",
      "Moderate DR": "bg-orange-50 border-orange-200",
      "Severe DR": "bg-red-50 border-red-200",
      "Proliferative DR": "bg-red-100 border-red-300",
    };
    return colors[severity] || "bg-gray-50 border-gray-200";
  };

  const getSeverityBadgeColor = (severity: string) => {
    const colors: Record<string, string> = {
      "No DR": "bg-green-100 text-green-800",
      "Mild DR": "bg-yellow-100 text-yellow-800",
      "Moderate DR": "bg-orange-100 text-orange-800",
      "Severe DR": "bg-red-100 text-red-800",
      "Proliferative DR": "bg-red-200 text-red-900",
    };
    return colors[severity] || "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Diabetic Retinopathy Detection</CardTitle>
          <CardDescription>
            Upload a fundus photograph for AI-powered classification
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Image Upload */}
          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
              preview ? "border-green-300 bg-green-50" : "border-gray-300 hover:border-gray-400"
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />

            {preview ? (
              <div className="space-y-2">
                <img
                  src={preview}
                  alt="Preview"
                  className="max-h-96 mx-auto rounded-lg"
                />
                <p className="text-sm text-gray-600">{selectedImage?.name}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="mx-auto h-12 w-12 text-gray-400" />
                <p className="text-lg font-medium">Drop image here or click to select</p>
                <p className="text-sm text-gray-500">PNG, JPG, or TIFF up to 10MB</p>
              </div>
            )}
          </div>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Classify Button */}
          <Button
            onClick={handleClassify}
            disabled={!selectedImage || loading}
            className="w-full h-10"
            size="lg"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              "Classify Image"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <Card className={`border-2 ${getSeverityColor(result.severity)}`}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Classification Result</CardTitle>
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Severity Badge */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-600">Severity Classification</p>
              <div className={`inline-block px-4 py-2 rounded-full font-semibold ${getSeverityBadgeColor(result.severity)}`}>
                {result.severity}
              </div>
            </div>

            {/* Confidence */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-600">Confidence Score</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${result.confidence * 100}%` }}
                  />
                </div>
                <span className="font-mono font-bold text-lg">
                  {truncatePercent(result.confidence)}%
                </span>
              </div>
            </div>

            {/* Recommendation */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-600">Clinical Recommendation</p>
              <p className="text-base text-gray-900">{result.recommendation}</p>
            </div>

            {/* Disclaimer */}
            <Alert>
              <AlertDescription className="text-xs">
                ⚠️ This is an AI-assisted analysis tool. Results should be reviewed by qualified ophthalmologists.
                Not for diagnostic use without professional review.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
