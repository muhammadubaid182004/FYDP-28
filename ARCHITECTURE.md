# 3-Service Architecture - Deployment Guide

## 📋 Overview

The Diabetic Retinopathy Detection System is deployed as 3 independent, scalable services:

```
┌────────────────────────────────────────────────────────────────┐
│                  Frontend (Node.js + React)                     │
│                     Port: 3000 (Vite/Build)                    │
│                                                                 │
│  - User Interface                                              │
│  - Image Upload & Preview                                      │
│  - Authentication (JWT)                                        │
│  - Result Display & History                                    │
└─────────────────────────┬──────────────────────────────────────┘
                          │ HTTP REST
        ┌─────────────────┼──────────────┐
        │                 │              │
┌───────▼──────────┐  ┌───▼────────┐  ┌▼──────────────┐
│ Backend Service  │  │   Model    │  │   Database   │
│  (Python+FastAPI)│  │  Service   │  │ (PostgreSQL) │
│  Port: 8000      │  │  (Flask)   │  │ Port: 5432   │
│                  │  │ Port: 5000 │  │              │
│ - Auth/JWT       │  │            │  └───────────────┘
│ - CRUD Routes    │  │ - Inference│
│ - DB Ops         │  │ - Predict  │
│ - Analytics      │  │            │
│ - History        │  │            │
└──────────────────┘  └────────────┘
```

---

## 🚀 Quick Start - All Services (Docker Compose)

### Prerequisites
- Docker & Docker Compose installed
- ONNX model file: `./models/dr-classification.onnx`
- Environment variables configured

### 1. Set Environment Variables

Create `.env` file in project root:

```bash
cat > .env << 'EOF'
# Database
POSTGRES_USER=dr_user
POSTGRES_PASSWORD=dr_password
POSTGRES_DB=dr_detection

# Backend
JWT_SECRET=your-super-secret-key-change-in-production
DATABASE_URL=postgresql://dr_user:dr_password@postgres:5432/dr_detection
MODEL_SERVICE_URL=http://model-service:5000
FRONTEND_URL=http://localhost:3000

# Model Service
MODEL_PATH=/app/models/dr-classification.onnx
EOF
```

### 2. Place Model File

```bash
mkdir -p models
# Copy your ONNX model file
cp dr-classification.onnx models/
```

### 3. Start All Services

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check service status
docker-compose ps
```

### 4. Verify Services Are Running

```bash
# Frontend
curl http://localhost:3000

# Backend
curl http://localhost:8000/healthz

# Model Service
curl http://localhost:5000/healthz

# Database
psql -h localhost -U dr_user -d dr_detection
```

---

## 📊 Service Details

### Frontend Service (Port 3000)

**Stack:** Node.js 20 + React 19 + TypeScript + Vite

**Responsibilities:**
- ✅ Web UI for image upload
- ✅ User authentication (login/register)
- ✅ Call backend API for classification
- ✅ Display results and history
- ✅ Export reports (PDF)

**Key Components:**
- `ImageClassifierAPI.tsx` - Updated to call backend
- `useClassificationAPI.ts` - API client hook
- `Login.tsx` - Authentication page
- `Dashboard.tsx` - User dashboard

**Build:**
```bash
npm run build
# Output: dist/
```

**API Calls Made:**
```
POST /api/classify        - Send image for classification
GET  /api/predictions     - Get user prediction history
POST /api/auth/login      - User login
POST /api/auth/register   - User registration
GET  /healthz             - Health check
```

---

### Backend Service (Port 8000)

**Stack:** Python 3.11 + FastAPI + SQLAlchemy + PostgreSQL

**Responsibilities:**
- ✅ User authentication & authorization
- ✅ Receive images from frontend
- ✅ Route to model service for inference
- ✅ Store predictions in database
- ✅ Serve prediction history
- ✅ Analytics & admin endpoints

**Key Routes:**

```python
# Authentication
POST   /api/auth/register         # Register new user
POST   /api/auth/login            # User login

# Classification
POST   /api/classify              # Single image classification
GET    /api/predictions           # Get user history
GET    /api/predictions/{id}      # Get specific prediction

# Admin
GET    /api/analytics/summary     # System statistics

# Health
GET    /healthz                   # Service health
```

**Requirements:**
```
fastapi==0.104.1
sqlalchemy==2.0.23
psycopg2-binary==2.9.9
```

**Run Locally:**
```bash
cd backend
pip install -r requirements.txt
export DATABASE_URL="postgresql://dr_user:dr_password@localhost:5432/dr_detection"
export MODEL_SERVICE_URL="http://localhost:5000"
uvicorn main:app --host 0.0.0.0 --port 8000
```

---

### Model Service (Port 5000)

**Stack:** Python 3.11 + Flask + ONNX Runtime

**Responsibilities:**
- ✅ Load ONNX model on startup
- ✅ Receive images from backend
- ✅ Preprocess images (resize, normalize)
- ✅ Run inference using ONNX Runtime
- ✅ Return predictions with confidence scores

**Key Routes:**

```python
# Prediction
POST   /api/predict               # Single image inference
POST   /api/predict-batch         # Batch inference (multiple images)

# Health
GET    /healthz                   # Service health
```

**Features:**
- GPU acceleration (CUDA) with CPU fallback
- Batch processing support
- Preprocessor: 224×224 resize + normalization
- 5-class DR classification

**Run Locally:**
```bash
cd model-service
pip install -r requirements.txt
export MODEL_PATH="./models/dr-classification.onnx"
gunicorn --bind 0.0.0.0:5000 app:app
```

---

### Database (PostgreSQL Port 5432)

**Stack:** PostgreSQL 16 Alpine

**Responsibilities:**
- ✅ Store user accounts
- ✅ Store prediction history
- ✅ Store analytics data

**Initial Schema:**
```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Predictions table
CREATE TABLE predictions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  severity VARCHAR(50) NOT NULL,
  confidence FLOAT NOT NULL,
  image_path VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Connect:**
```bash
psql -h localhost -U dr_user -d dr_detection
```

---

## 📦 Deployment Options

### Option 1: Docker Compose (Local/VPS)

**Best for:** Development, testing, self-hosted servers

```bash
# Single command deployment
docker-compose up -d

# Scaling model service
docker-compose up -d --scale model-service=3
```

**Pros:** Single command deployment, local development
**Cons:** Manual server management

### Option 2: Kubernetes (Production)

**Best for:** Large-scale production, multiple regions

Create `k8s/deployment.yaml`:
```yaml
---
# Frontend Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dr-frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: dr-frontend
  template:
    metadata:
      labels:
        app: dr-frontend
    spec:
      containers:
      - name: frontend
        image: dr-detection:frontend
        ports:
        - containerPort: 3000

---
# Backend Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dr-backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dr-backend
  template:
    metadata:
      labels:
        app: dr-backend
    spec:
      containers:
      - name: backend
        image: dr-detection:backend
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url

---
# Model Service Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dr-model
spec:
  replicas: 5  # Scale model service
  selector:
    matchLabels:
      app: dr-model
  template:
    metadata:
      labels:
        app: dr-model
    spec:
      containers:
      - name: model
        image: dr-detection:model
        resources:
          requests:
            nvidia.com/gpu: 1  # GPU support
```

Deploy:
```bash
kubectl apply -f k8s/
```

### Option 3: Cloud Platforms

#### AWS ECS
```bash
# Push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
docker tag dr-detection:frontend $ECR_URL/dr-frontend:latest
docker push $ECR_URL/dr-frontend:latest

# Deploy with ECS Compose
ecs-cli compose -f docker-compose.yml service up
```

#### Google Cloud Run
```bash
# Deploy each service separately
gcloud run deploy dr-backend \
  --source ./backend \
  --memory 1024Mi \
  --allow-unauthenticated

gcloud run deploy dr-model \
  --source ./model-service \
  --memory 2048Mi \
  --gpu 1 \
  --allow-unauthenticated
```

#### Azure Container Instances
```bash
# Create container group
az container create \
  --resource-group dr-rg \
  --name dr-detection \
  --image myregistry.azurecr.io/dr-detection:latest \
  --cpu 4 \
  --memory 8
```

---

## 🔧 Configuration

### Environment Variables

**Backend (.env or docker-compose):**
```
DATABASE_URL=postgresql://user:pass@host:5432/db
JWT_SECRET=your-secret-key
MODEL_SERVICE_URL=http://model-service:5000
FRONTEND_URL=http://localhost:3000
```

**Model Service (.env):**
```
MODEL_PATH=/app/models/dr-classification.onnx
```

**Frontend (.env):**
```
VITE_API_BASE_URL=http://localhost:8000
```

---

## 🚨 Health Checks & Monitoring

### Service Health Endpoints

```bash
# Check all services
curl http://localhost:3000           # Frontend
curl http://localhost:8000/healthz   # Backend
curl http://localhost:5000/healthz   # Model Service
```

### Docker Compose Health Status

```bash
docker-compose ps
# Shows health status of each container

docker-compose logs backend  # View backend logs
docker-compose logs model-service  # View model logs
```

### Monitoring Metrics

Track via backend `/api/analytics/summary`:
```json
{
  "total_predictions": 1250,
  "total_users": 45,
  "severity_distribution": {
    "No DR": 600,
    "Mild DR": 400,
    "Moderate DR": 150,
    "Severe DR": 75,
    "Proliferative DR": 25
  }
}
```

---

## 📈 Scaling Strategy

### Frontend
- Static files served by CDN (Cloudflare, AWS CloudFront)
- Multiple instances with load balancer
- No data stored server-side

### Backend
- Horizontal scaling: Add more instances
- Load balance with nginx/HAProxy
- Database: Increase replicas, use connection pooling

### Model Service
- **GPU acceleration:** Run on GPU instances for 10× faster inference
- **Horizontal scaling:** Run multiple model replicas
- **Batch processing:** Accumulate requests, process in batches

```bash
# Scale model service with Docker
docker-compose up -d --scale model-service=5
```

---

## 🔐 Security Checklist

- [ ] Change JWT_SECRET to strong random value
- [ ] Enable HTTPS/TLS in production
- [ ] Set CORS properly for your domain
- [ ] Use environment variables for secrets
- [ ] Enable database encryption
- [ ] Implement rate limiting on API endpoints
- [ ] Use API keys/tokens for requests
- [ ] Regular security updates for dependencies

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Services won't start | Check `docker-compose logs` for errors |
| Model not loading | Verify ONNX file exists and path is correct |
| DB connection error | Check DATABASE_URL and postgres container health |
| Slow inference | Enable GPU, scale model replicas, check model size |
| CORS errors | Verify FRONTEND_URL in backend env |
| Out of memory | Reduce image size, use quantized model, scale horizontally |

---

## 📚 File Structure

```
project-root/
├── frontend/              # Node.js + React (npm/Vite)
│   ├── src/
│   ├── package.json
│   └── Dockerfile
├── backend/               # Python + FastAPI
│   ├── main.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── ...
├── model-service/         # Python + Flask
│   ├── app.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── ...
├── models/
│   └── dr-classification.onnx
├── docker-compose.yml
├── .env
└── README.md
```

---

## ✅ Production Deployment Checklist

- [ ] Use production-grade database (managed RDS/Cloud SQL)
- [ ] Enable HTTPS & SSL certificates
- [ ] Configure DNS records
- [ ] Set up monitoring/alerting
- [ ] Enable automated backups
- [ ] Configure load balancing
- [ ] Test failover scenarios
- [ ] Document runbooks
- [ ] Set up CI/CD pipeline
- [ ] Implement rate limiting
- [ ] Enable audit logging

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for detailed cloud deployment instructions.
