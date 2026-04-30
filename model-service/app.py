"""
Model Service - Separate inference service
Handles all machine learning inference for DR classification
"""

from flask import Flask, request, jsonify
from PIL import Image
import io
import numpy as np
import onnxruntime as rt
import logging
import os
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# ─────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────

MODEL_ENGINE_PATH = os.getenv("MODEL_ENGINE_PATH", "")
MODEL_ONNX_PATH = os.getenv("MODEL_ONNX_PATH", "")
MODEL_PT_PATH = os.getenv("MODEL_PT_PATH", "")
INPUT_SIZE = 224
CONFIDENCE_THRESHOLD = 0.5

# Class mapping for DR severity
CLASS_LABELS = [
    "No DR",
    "Mild DR", 
    "Moderate DR",
    "Severe DR",
    "Proliferative DR"
]

RECOMMENDATIONS = {
    "No DR": "No diabetic retinopathy detected. Continue routine screening.",
    "Mild DR": "Mild DR detected. Recommend annual eye exam.",
    "Moderate DR": "Moderate DR detected. Recommend referral to ophthalmologist.",
    "Severe DR": "Severe DR detected. Urgent referral to ophthalmologist required.",
    "Proliferative DR": "Proliferative DR detected. Emergency specialist evaluation needed.",
}

# ─────────────────────────────────────────────────────────────
# Load Model (priority: TensorRT engine -> ONNX)
# ─────────────────────────────────────────────────────────────

runtime_backend = None
model_session = None
input_name = None
output_name = None
model_path = None


def _existing_path(candidates):
    for candidate in candidates:
        if not candidate:
            continue
        candidate_path = Path(candidate).resolve()
        if candidate_path.exists():
            return str(candidate_path)
    return None


def _load_engine_runner(engine_path):
    # TensorRT Python bindings are optional; if unavailable we fall back to ONNX.
    try:
        import tensorrt as trt  # type: ignore
    except Exception as exc:
        logger.warning(f"TensorRT engine found but TensorRT runtime unavailable: {exc}")
        return None

    logger.warning(
        "TensorRT engine selected (%s) but runtime execution is not wired yet; falling back to ONNX if available.",
        engine_path,
    )
    _ = trt  # Keep import validated; prevents linting of unused import.
    return None


def _load_onnx_runner(onnx_path):
    sess_options = rt.SessionOptions()
    sess_options.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL

    session = rt.InferenceSession(
        onnx_path,
        sess_options=sess_options,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    return session, session.get_inputs()[0].name, session.get_outputs()[0].name


engine_candidate = _existing_path(
    [
        MODEL_ENGINE_PATH,
        "./best.engine",
        "./models/dr-classification.engine",
        "../backend/best.engine",
    ]
)
onnx_candidate = _existing_path(
    [
        MODEL_ONNX_PATH,
        os.getenv("MODEL_PATH", ""),
        "./best.onnx",
        "./models/dr-classification.onnx",
        "../backend/best.onnx",
    ]
)
pt_candidate = _existing_path(
    [
        MODEL_PT_PATH,
        "./best.pt",
        "./models/dr-classification.pt",
        "../backend/best.pt",
    ]
)

if engine_candidate:
    engine_runner = _load_engine_runner(engine_candidate)
    if engine_runner:
        runtime_backend = "tensorrt-engine"
        model_path = engine_candidate
        model_session = engine_runner

if runtime_backend is None and onnx_candidate:
    try:
        model_session, input_name, output_name = _load_onnx_runner(onnx_candidate)
        runtime_backend = "onnxruntime"
        model_path = onnx_candidate
        logger.info(f"✓ ONNX model loaded successfully from {model_path}")
        logger.info(f"  Input: {input_name}, Output: {output_name}")
    except Exception as exc:
        logger.error(f"Failed to load ONNX model from {onnx_candidate}: {exc}")
        model_session = None

if runtime_backend is None:
    if pt_candidate:
        logger.warning(
            "Found PT model at %s, but this service currently serves ONNX/TensorRT runtime paths.",
            pt_candidate,
        )
    logger.error(
        "No usable model backend available. Checked engine=%s onnx=%s pt=%s",
        engine_candidate,
        onnx_candidate,
        pt_candidate,
    )

# ─────────────────────────────────────────────────────────────
# Preprocessing
# ─────────────────────────────────────────────────────────────

def preprocess_image(image_bytes):
    """Preprocess image for inference"""
    try:
        # Open image
        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        
        # Resize to model input size
        image = image.resize((INPUT_SIZE, INPUT_SIZE), Image.LANCZOS)
        
        # Convert to numpy array
        image_array = np.array(image, dtype=np.float32)
        
        # Normalize to [0, 1]
        image_array = image_array / 255.0
        
        # Transpose to CHW format
        image_array = np.transpose(image_array, (2, 0, 1))
        
        # Add batch dimension
        image_array = np.expand_dims(image_array, 0)
        
        return image_array
        
    except Exception as e:
        logger.error(f"Preprocessing error: {e}")
        raise

# ─────────────────────────────────────────────────────────────
# Health & Status
# ─────────────────────────────────────────────────────────────

@app.route('/healthz', methods=['GET'])
def health_check():
    """Check model service health"""
    return jsonify({
        "status": "healthy" if model_session else "unhealthy",
        "model_loaded": model_session is not None,
        "model_path": model_path,
        "backend": runtime_backend,
        "pt_candidate": pt_candidate,
    }), 200 if model_session else 503

# ─────────────────────────────────────────────────────────────
# Inference Endpoint
# ─────────────────────────────────────────────────────────────

@app.route('/api/predict', methods=['POST'])
def predict():
    """Run inference on uploaded fundus image"""
    
    if not model_session:
        return jsonify({"error": "Model not loaded"}), 503
    
    try:
        # Check if file was provided
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        file = request.files['file']
        
        if file.filename == '':
            return jsonify({"error": "No file selected"}), 400
        
        if not file.content_type.startswith('image/'):
            return jsonify({"error": "File must be an image"}), 400
        
        # Read and preprocess image
        image_bytes = file.read()
        processed_image = preprocess_image(image_bytes)
        
        # Run inference (ONNX currently active backend)
        outputs = model_session.run(None, {input_name: processed_image})
        predictions = outputs[0][0]  # First batch, all classes
        
        # Get top prediction
        max_idx = np.argmax(predictions)
        max_confidence = float(predictions[max_idx])
        
        # Check confidence threshold
        if max_confidence < CONFIDENCE_THRESHOLD:
            predicted_class = "Unable to classify"
            recommendation = "Image quality insufficient. Please provide a clearer image."
        else:
            predicted_class = CLASS_LABELS[max_idx] if max_idx < len(CLASS_LABELS) else "Unknown"
            recommendation = RECOMMENDATIONS.get(predicted_class, "")
        
        return jsonify({
            "class": predicted_class,
            "confidence": max_confidence,
            "recommendation": recommendation,
            "all_predictions": {
                CLASS_LABELS[i]: float(predictions[i])
                for i in range(len(CLASS_LABELS))
            },
            "model_version": f"{runtime_backend or 'unknown'}-1.0.0"
        }), 200
        
    except Exception as e:
        logger.error(f"Prediction error: {e}")
        return jsonify({"error": str(e)}), 500

# ─────────────────────────────────────────────────────────────
# Batch Inference
# ─────────────────────────────────────────────────────────────

@app.route('/api/predict-batch', methods=['POST'])
def predict_batch():
    """Run inference on multiple images"""
    
    if not model_session:
        return jsonify({"error": "Model not loaded"}), 503
    
    try:
        files = request.files.getlist('files')
        
        if not files:
            return jsonify({"error": "No files provided"}), 400
        
        results = []
        
        for file in files:
            if not file.content_type.startswith('image/'):
                results.append({
                    "filename": file.filename,
                    "error": "Not an image file"
                })
                continue
            
            try:
                # Preprocess and predict
                image_bytes = file.read()
                processed_image = preprocess_image(image_bytes)
                outputs = model_session.run(None, {input_name: processed_image})
                predictions = outputs[0][0]
                
                max_idx = np.argmax(predictions)
                max_confidence = float(predictions[max_idx])
                
                results.append({
                    "filename": file.filename,
                    "class": CLASS_LABELS[max_idx],
                    "confidence": max_confidence,
                    "recommendation": RECOMMENDATIONS.get(CLASS_LABELS[max_idx], "")
                })
                
            except Exception as e:
                results.append({
                    "filename": file.filename,
                    "error": str(e)
                })
        
        return jsonify({
            "total": len(files),
            "successful": len([r for r in results if "error" not in r]),
            "results": results
        }), 200
        
    except Exception as e:
        logger.error(f"Batch prediction error: {e}")
        return jsonify({"error": str(e)}), 500

# ─────────────────────────────────────────────────────────────
# Root endpoint
# ─────────────────────────────────────────────────────────────

@app.route('/', methods=['GET'])
def root():
    """Model service info"""
    return jsonify({
        "service": "DR Classification Model Service",
        "version": "1.0.0",
        "model_path": model_path,
        "backend": runtime_backend,
        "pt_candidate": pt_candidate,
        "model_loaded": model_session is not None,
        "endpoints": ["/healthz", "/api/predict", "/api/predict-batch"]
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
