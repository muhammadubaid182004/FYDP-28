# 3-Service Deployment - Quick Reference

## 🏗️ Architecture

```
CLIENT (React)           BACKEND (Python FastAPI)    MODEL (Python Flask)
   :3000        →              :8000          →           :5000
   ❌ No ONNX                  ✅ Routes                   ✅ Inference
                               ✅ Auth                     ✅ ONNX Runtime  
                               ✅ Database
```

---

## 🚀 Local Development (Docker Compose)

### Step 1: Prepare Files

```bash
# Create directories
mkdir -p models backend model-service

# Copy ONNX model
cp dr-classification.onnx models/

# Verify structure
ls -la
# backend/
# model-service/
# models/dr-classification.onnx
# docker-compose.yml
```

### Step 2: Start Services

```bash
# Build and start all 3 services + database
docker-compose up -d

# Wait for services to be healthy (~30s)
sleep 30

# Verify all are running
docker-compose ps
```

### Step 3: Test Services

```bash
# Test Frontend
curl http://localhost:3000

# Test Backend
curl http://localhost:8000/healthz
# Output: {"status":"healthy","backend":"up","model_service":"up","database":"up"}

# Test Model Service
curl http://localhost:5000/healthz

# Test Database
psql -h localhost -U dr_user -d dr_detection
```

### Step 4: Access Application

Open browser: **http://localhost:3000**

---

## 📋 Service Communication Flow

```
1. USER UPLOADS IMAGE
   ↓
2. FRONTEND (React)
   ├─ Validates image
   ├─ Displays preview
   └─ POST /api/classify
      ↓
3. BACKEND (FastAPI)
   ├─ Verifies auth
   ├─ Receives image
   └─ POST http://model-service:5000/api/predict
      ↓
4. MODEL SERVICE (Flask)
   ├─ Loads ONNX model
   ├─ Preprocesses image (224×224, normalize)
   ├─ Runs inference
   └─ Returns: {class, confidence, recommendation}
      ↓
5. BACKEND (FastAPI)
   ├─ Stores in database
   └─ Returns response
      ↓
6. FRONTEND (React)
   ├─ Displays results
   ├─ Shows severity badge
   ├─ Shows confidence
   └─ Shows clinical recommendation
```

---

## 🔧 Environment Setup

Create `.env` file:

```bash
cat > .env << 'EOF'
# Database
POSTGRES_USER=dr_user
POSTGRES_PASSWORD=dr_password
POSTGRES_DB=dr_detection

# Backend  
JWT_SECRET=change-this-to-random-secret-in-production
DATABASE_URL=postgresql://dr_user:dr_password@postgres:5432/dr_detection
MODEL_SERVICE_URL=http://model-service:5000
FRONTEND_URL=http://localhost:3000

# Frontend
VITE_API_BASE_URL=http://localhost:8000

# Model
MODEL_PATH=/app/models/dr-classification.onnx
EOF
```

---

## 🐳 Docker Compose Commands

### Manage Services

```bash
# Start all services
docker-compose up -d

# View logs (real-time)
docker-compose logs -f

# View logs for specific service
docker-compose logs -f backend
docker-compose logs -f model-service

# Stop all services
docker-compose stop

# Stop and remove containers
docker-compose down

# Remove everything including volumes
docker-compose down -v

# Rebuild images
docker-compose build --no-cache
```

### Scale Model Service

```bash
# Run 5 model service replicas (for load balancing)
docker-compose up -d --scale model-service=5
```

---

## 📊 Update Frontend to Use Backend

The files are already updated:

- ✅ `useClassificationAPI.ts` - Calls Python backend
- ✅ `ImageClassifierAPI.tsx` - Uses backend API

**Use in your page:**

```tsx
import { ImageClassifierAPI } from "@/components/ImageClassifierAPI";

export default function InferencePage() {
  return <ImageClassifierAPI />;
}
```

---

## ⚙️ Backend API Reference

### Classification

```bash
# Single image
curl -X POST http://localhost:8000/api/classify \
  -F "file=@fundus.jpg"

# Response
{
  "prediction_id": "pred-uuid",
  "severity": "Mild DR",
  "confidence": 0.87,
  "recommendation": "Recommend annual eye exam.",
  "created_at": "2024-04-08T...",
  "model_version": "1.0.0"
}
```

### Authentication

```bash
# Login
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user","password":"pass"}'

# Register
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"user","email":"user@example.com","password":"pass","name":"User Name"}'
```

### History

```bash
# Get predictions
curl http://localhost:8000/api/predictions?user_id=user-123

# Get specific prediction
curl http://localhost:8000/api/predictions/pred-uuid
```

---

## 🔌 Model Service API Reference

### Predict

```bash
# Single image
curl -X POST http://localhost:5000/api/predict \
  -F "file=@fundus.jpg"

# Response
{
  "class": "Mild DR",
  "confidence": 0.87,
  "recommendation": "Recommend annual eye exam.",
  "all_predictions": {
    "No DR": 0.05,
    "Mild DR": 0.87,
    "Moderate DR": 0.06,
    "Severe DR": 0.02,
    "Proliferative DR": 0.00
  },
  "model_version": "1.0.0"
}
```

### Batch Predict

```bash
# Multiple images
curl -X POST http://localhost:5000/api/predict-batch \
  -F "files=@image1.jpg" \
  -F "files=@image2.jpg" \
  -F "files=@image3.jpg"

# Response
{
  "total": 3,
  "successful": 3,
  "results": [
    {"filename": "image1.jpg", "class": "Mild DR", "confidence": 0.87},
    {"filename": "image2.jpg", "class": "No DR", "confidence": 0.95},
    ...
  ]
}
```

---

## 🚨 Troubleshooting

### Services Won't Start

```bash
# Check logs
docker-compose logs

# Check if ports are in use
lsof -i :3000  # Frontend
lsof -i :8000  # Backend
lsof -i :5000  # Model Service
lsof -i :5432  # Database

# Free port 3000 (example)
kill -9 $(lsof -t -i :3000)
```

### Database Connection Error

```bash
# Check if postgres container is running
docker-compose ps postgres

# Connect and verify database
docker-compose exec postgres psql -U dr_user -d dr_detection -c "SELECT 1"
```

### Model Service Can't Load Model

```bash
# Check if model file exists
ls -la models/dr-classification.onnx

# Check model service logs
docker-compose logs model-service

# Verify ONNX file is valid
python -c "import onnxruntime as rt; rt.InferenceSession('models/dr-classification.onnx')"
```

### CORS Errors

Check `FRONTEND_URL` is correct in backend `.env`:
```
FRONTEND_URL=http://localhost:3000
```

---

## 📦 Deployment to Production

### Option 1: AWS ECS with Docker Compose

```bash
# Install ECS CLI
curl -o /usr/local/bin/ecs-cli https://amazon-ecs-cli.s3.amazonaws.com/ecs-cli-linux-amd64-latest
chmod +x /usr/local/bin/ecs-cli

# Create cluster
ecs-cli up --cluster-name dr-detection

# Deploy
ecs-cli compose -f docker-compose.yml service up
```

### Option 2: Kubernetes

```bash
# Create k8s deployment files from docker-compose
kompose convert -f docker-compose.yml -o k8s/

# Deploy to cluster
kubectl apply -f k8s/
kubectl get pods
```

### Option 3: Cloud Run (GCP)

```bash
# Deploy backend
gcloud run deploy dr-backend --source ./backend --region us-central1

# Deploy model service
gcloud run deploy dr-model --source ./model-service --region us-central1 --memory 2048Mi

# Deploy frontend
gcloud run deploy dr-frontend --source . --region us-central1
```

---

## ✅ Deployment Checklist

- [ ] ONNX model file ready
- [ ] `.env` configured
- [ ] Docker & Docker Compose installed
- [ ] Services start without errors
- [ ] All health checks pass
- [ ] Frontend can reach backend
- [ ] Backend can reach model service
- [ ] Database initialized
- [ ] Test classification works end-to-end
- [ ] Logs monitored and healthy

---

## 📚 See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Detailed architecture
- [docker-compose.yml](./docker-compose.yml) - Full compose config
- [backend/main.py](./backend/main.py) - Backend source
- [model-service/app.py](./model-service/app.py) - Model service source

**Ready to deploy?** Run:

```bash
docker-compose up -d
```

Then open **http://localhost:3000** 🎉
