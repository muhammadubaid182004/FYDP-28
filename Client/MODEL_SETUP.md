# Model Setup & Deployment Guide

## 1. Convert PyTorch to ONNX

**Option A: From Python**

```python
import torch
import torch.onnx
from torchvision import models

# Load your trained PyTorch model
model = models.resnet50(pretrained=False)
model.fc = torch.nn.Linear(2048, 5)  # 5 classes for DR severity
model.load_state_dict(torch.load('dr-classification.pt'))
model.eval()

# Create dummy input
dummy_input = torch.randn(1, 3, 224, 224)

# Export to ONNX
torch.onnx.export(
    model,
    dummy_input,
    "dr-classification.onnx",
    export_params=True,
    opset_version=14,
    input_names=['images'],
    output_names=['output'],
    dynamic_axes={'images': {0: 'batch_size'}, 'output': {0: 'batch_size'}},
    do_constant_folding=True,
    verbose=False
)

print("✓ Model exported to dr-classification.onnx")
```

**Option B: From .pt file (TorchScript → ONNX)**

```bash
# Install converter
pip install onnx onnx-simplifier

# Convert using Python script
python -c "
import torch
from torch.onnx import export

model = torch.jit.load('model.pt')
dummy = torch.randn(1, 3, 224, 224)
export(model, dummy, 'dr-classification.onnx', opset_version=14)
"
```

## 2. Optimize Model Size

```bash
pip install onnx onnx-simplifier

# Simplify ONNX model
python -m onnxruntime.transformers.onnx_model_bert --model_name_or_path dr-classification.onnx --output_dir ./optimized

# Or use Python API
from onnxruntime.transformers import optimizer

opt = optimizer.optimize_model('dr-classification.onnx')
opt.save_model_to_file('dr-classification-optimized.onnx')
```

## 3. Setup File Structure

```
public/
├── models/
│   ├── dr-classification.onnx        # ~50-200MB depending on architecture
│   └── model-metadata.json           # Model info (input size, classes, etc.)
└── index.html
```

### model-metadata.json
```json
{
  "inputSize": 224,
  "classes": ["No DR", "Mild DR", "Moderate DR", "Severe DR", "Proliferative DR"],
  "modelVersion": "1.0.0",
  "architecture": "ResNet50",
  "trainedOn": "2024-04-08"
}
```

## 4. Install Dependencies

Add to package.json:

```bash
npm install onnxruntime-web
```

## 5. Local Testing

```bash
# Serve public folder with model
npm run dev
# Navigate to http://localhost:3000
```

## 6. Cloud Deployment

### **AWS S3 + CloudFront**
```bash
# Upload model to S3
aws s3 cp public/models/dr-classification.onnx s3://your-bucket/models/

# Update vite.config.ts to use CDN
# const modelURL = 'https://cdn.your-domain.com/models/dr-classification.onnx'
```

### **Google Cloud Storage**
```bash
gsutil cp public/models/dr-classification.onnx gs://your-bucket/models/

# Make public (use signed URLs for production)
gsutil acl ch -u AllUsers:R gs://your-bucket/models/dr-classification.onnx
```

### **Azure Blob Storage**
```bash
az storage blob upload \
  --account-name youraccount \
  --container-name models \
  --name dr-classification.onnx \
  --file public/models/dr-classification.onnx
```

## 7. Serve Model from CDN

**Update useModelInference.ts:**

```typescript
const modelURL = process.env.VITE_MODEL_URL || '/models/dr-classification.onnx';
const session = await ort.InferenceSession.create(modelURL, {
  executionProviders: ['webgpu', 'wasm']
});
```

**.env.production:**
```
VITE_MODEL_URL=https://cdn.example.com/models/dr-classification.onnx
```

## 8. Deployment to Cloud

### **Vercel (Recommended for React + Static Files)**

```bash
npm install -g vercel

# Deploy
vercel deploy

# Add model to Vercel KV/Blob
vercel blob upload public/models/dr-classification.onnx
```

**vercel.json:**
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "env": {
    "VITE_MODEL_URL": "@model_url"
  }
}
```

### **AWS Amplify**

```bash
npm install -g @aws-amplify/cli

amplify init
amplify add hosting
amplify publish

# Upload model to S3
aws s3 cp public/models/ s3://amplify-bucket/models/ --recursive
```

### **Google Cloud Run**

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
RUN npm install -g serve
CMD ["serve", "-s", "dist"]
```

```bash
gcloud run deploy dr-detection \
  --source . \
  --memory 1024Mi \
  --allow-unauthenticated
```

### **Docker + Any VPS**

```bash
docker build -t dr-detection .
docker run -p 3000:3000 dr-detection
```

## 9. Performance Optimization

**For Large Models (>200MB):**

```typescript
// Enable lazy loading
const modelRef = useRef<ort.InferenceSession | null>(null);

const initializeModel = async () => {
  if (modelRef.current) return;
  
  // Show loading state
  const session = await ort.InferenceSession.create(modelURL, {
    executionProviders: ['webgpu', 'wasm'],
    // Cache model in IndexedDB
    sessionOptions: { graph_optimization_level: 'all' }
  });
  
  modelRef.current = session;
};
```

**Compression:**
```bash
# Gzip compression (server should handle)
gzip -k public/models/dr-classification.onnx

# Brotli
brotli --best public/models/dr-classification.onnx
```

## 10. Monitoring & Logging

```typescript
// Track inference performance
const startTime = performance.now();
await classify(file);
const endTime = performance.now();
console.log(`Inference took ${endTime - startTime}ms`);

// Send metrics
analytics.track('classification', {
  duration: endTime - startTime,
  confidence: result.confidence,
  severity: result.class
});
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Model too large | Quantize to int8, use pruning, or split model |
| Slow inference | Enable WebGPU, use WASM backend as fallback |
| CORS errors | Ensure model hosted on same domain or with CORS headers |
| Memory issues | Use sessionStorage caching, batch processing |
| Model not loading | Check CDN URL, verify ONNX opset compatibility |

