# 🚀 Jetson Orin Nano - Quick Setup Guide

## 📋 System Architecture (Your Setup)

```
🖥️  Your Laptop/PC                    🔌 Network                    🎯 Jetson Orin Nano
┌─────────────────────────┐          (192.168.x.x)              ┌──────────────────────┐
│                         │                                     │                      │
│  React Frontend         │◄──────────────────────────────────►│  TensorRT Inference  │
│  - Port 3000            │  (HTTPS/HTTP)                       │  - Port 8000         │
│                         │                                     │  - Custom app.py     │
├─────────────────────────┤                                     ├──────────────────────┤
│                         │                                     │                      │
│  Node.js Backend        │◄──────────(POST /api/predict)──────│  ONNX/TensorRT       │
│  - Port 8000            │  (forwards image for inference)     │  - GPU acceleration  │
│  - Express.js           │                                     │  - Model outputs     │
│                         │                                     │                      │
│  ✅ Auth middleware     │                                     │                      │
│  ✅ JWT validation      │  (TCP Port 8000)                    │                      │
│  ✅ Data persistence    │                                     │  (No direct internet │
│  ✅ Jetson controller   │                                     │   needed)            │
│                         │                                     │                      │
└─────────────────────────┘                                     └──────────────────────┘
```

---

## 🔧 Prerequisites

### On Your Laptop/PC

```bash
# Required versions
Node.js 20+
npm or pnpm
React 19+
TypeScript 5+

# Installation
pipx install oven-sh/bun/bun  # or use npm
npm install  # Install all dependencies
```

### On Jetson Orin Nano

```bash
# SSH into Jetson
ssh <user>@<jetson-ip>

# Required packages (Ubuntu-based)
sudo apt-get update
sudo apt-get install -y \
  python3 \
  python3-pip \
  python3-venv \
  git

# Python dependencies for inference
pip3 install --upgrade pip
pip3 install onnxruntime  # or tensorrt if using TensorRT
pip3 install pillow numpy flask
```

---

## 🔐 Step 1: Find Your Jetson's IP Address

### From Jetson Device (via Terminal)

```bash
hostname -I
# Output: 192.168.1.100 192.168.1.150
# Use the one on your network (usually 192.168.x.x)
```

### From Your Laptop (Scan Network)

```bash
# macOS/Linux
nmap -sn 192.168.1.0/24 | grep -i jetson

# Windows (requires nmap)
nmap -sn 192.168.1.0/24

# Or use IP scanner app (Angry IP Scanner, etc.)
```

**Write down your Jetson IP:** `192.168.1.__?__`

---

## 📝 Step 2: Configure Backend

### Create `.env` File

```bash
# In project root or backend folder
cat > backend/.env << 'EOF'
PORT=8000
NODE_ENV=development
JWT_SECRET=dev-secret-key-change-in-production
FRONTEND_URL=http://localhost:3000
JETSON_IP_ADDRESS=192.168.1.100
DB_PATH=./predictions.db
EOF
```

**Replace `192.168.1.100` with your actual Jetson IP**

---

## 🚀 Step 3: Start Backend (First Time)

### Install Dependencies

```bash
cd backend
npm install
```

### Start Development Server

```bash
npm run dev
```

**Output should show:**
```
🚀 Backend server running on http://localhost:8000
🎯 Jetson URL: http://192.168.1.100:8000
🔐 Authentication: JWT
📊 Database: ./predictions.db
```

---

## 🌐 Step 4: Jetson Inference Server

### Create Simple Inference App

```bash
# SSH into Jetson
ssh <user>@192.168.1.100

# Create inference app
mkdir -p ~/dr-inference && cd ~/dr-inference

cat > app.py << 'EOF'
from flask import Flask, request, jsonify
import onnxruntime as rt
import numpy as np
from PIL import Image
from io import BytesIO
import json

app = Flask(__name__)

# Add your model loading code
MODEL_PATH = "/path/to/dr-classification.onnx"
session = rt.InferenceSession(MODEL_PATH)
input_name = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name

CLASSES = ["No DR", "Mild DR", "Moderate DR", "Severe DR", "Proliferative DR"]

@app.route('/healthz', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "model_loaded": True})

@app.route('/api/predict', methods=['POST'])
def predict():
    try:
        # Receive image
        file = request.files['file']
        image_bytes = file.read()
        
        # Preprocess
        image = Image.open(BytesIO(image_bytes)).convert('RGB')
        image = image.resize((224, 224))
        image_array = np.array(image) / 255.0
        
        # Add batch dimension
        batch = image_array[np.newaxis, :, :, :].transpose(0, 3, 1, 2).astype(np.float32)
        
        # Run inference
        outputs = session.run([output_name], {input_name: batch})
        predictions = outputs[0][0]
        
        # Get class and confidence
        class_idx = np.argmax(predictions)
        confidence = float(predictions[class_idx])
        
        return jsonify({
            "class": CLASSES[class_idx],
            "confidence": confidence,
            "recommendation": f"Recommendation for {CLASSES[class_idx]}",
            "model_version": "1.0.0"
        })
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=False)
EOF

# Start inference server
python3 app.py
```

**Jetson inference server should now show:**
```
 * Running on http://0.0.0.0:8000
 * WARNING: This is a development server...
```

---

## ✅ Step 5: Test the Connection

### From Your Laptop, Test Backend Health

```bash
curl http://localhost:8000/healthz
```

**Expected response:**
```json
{
  "status": "healthy",
  "backend": "up",
  "jetson_url": "http://192.168.1.100:8000",
  "timestamp": "2024-04-08T..."
}
```

### Test Jetson Connection (From Backend)

```bash
# This test happens in the backend logs
# Check for messages like:
# "📤 Forwarding image to Jetson at http://192.168.1.100:8000..."
```

---

## 🎮 Step 6: Start Frontend

### In New Terminal

```bash
npm run dev
```

**Frontend should be at:** `http://localhost:3000`

---

## 🧪 Step 7: Test Full Flow

### 1️⃣ Register User

```bash
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "password123",
    "name": "Test User"
  }'
```

**Response:** `{"token": "eyJhbGc...", "user": {...}}`

### 2️⃣ Copy Token

```bash
# From the response above
export TOKEN="eyJhbGc..."
```

### 3️⃣ Test Classification

```bash
# Using test image
curl -X POST http://localhost:8000/api/classify \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@fundus_sample.jpg"
```

**Expected response:**
```json
{
  "prediction_id": "pred_1701234567890",
  "severity": "Mild DR",
  "confidence": 0.87,
  "recommendation": "...",
  "jetson_inference_time": 145,
  "created_at": "2024-04-08T..."
}
```

---

## 🌐 Network Diagram (Your Setup)

```
Your Laptop (192.168.1.X)
├── React Frontend :3000
│   └─ calls backend
│
├── Node Backend :8000
│   ├─ validates user
│   ├─ stores results
│   └─ calls Jetson at 192.168.1.100:8000
│       ↓
│   Jetson Orin Nano (192.168.1.100)
│   └─ TensorRT inference
│       └─ returns predictions
│   
└─ Database: predictions.db
```

---

## 📊 Performance Expectations

| Component | Time |
|-----------|------|
| Jetson TensorRT inference | 100-200ms |
| Backend overhead | 50-100ms |
| Network latency | 5-20ms (local network) |
| **Total per image** | **~200-300ms** |

---

## 🆘 Troubleshooting

### ❌ Backend → Can't connect to Jetson

```bash
# Check Jetson IP
ping 192.168.1.100

# Check Jetson inference server running
# (SSH into Jetson and verify app.py is running)

# Update backend/.env with correct IP
JETSON_IP_ADDRESS=192.168.1.XXX
```

### ❌ Jetson → Can't import onnxruntime

```bash
# On Jetson, install:
pip3 install onnxruntime

# Or for GPU support:
pip3 install onnxruntime-gpu

# Or use TensorRT:
pip3 install tensorrt
```

### ❌ Frontend → 401 Unauthorized

```bash
# Token missing or expired
# 1. Check localStorage for dr_token
# 2. Re-login to get new token
# 3. Check token expiry (24 hours)
```

### ❌ No predictions showing

```bash
# Check if predictions.db exists
ls -la predictions.db

# Check if readable/writable
chmod 644 predictions.db
```

---

## 📦 Production Deployment

### Backend on Cloud (AWS/GCP/Azure)

```bash
# Build Docker image
docker build -f backend/Dockerfile -t dr-backend:latest .

# Push to registry
docker tag dr-backend:latest myregistry/dr-backend:latest
docker push myregistry/dr-backend:latest

# Deploy to cloud
# (Specific instructions depend on cloud provider)
```

### Keep Jetson on Local Network

```bash
# Jetson stays on-premises (192.168.1.100)
# Backend connects to Jetson via VPN or direct network
# Add firewall rule to only allow backend IP
```

---

## 🔐 Security Production Checklist

- [ ] Change `JWT_SECRET` to random 32-char string
- [ ] Set `NODE_ENV=production`
- [ ] Use HTTPS for frontend
- [ ] Firewall Jetson (only allow backend IP)
- [ ] Enable database encryption
- [ ] Audit all API calls
- [ ] Add rate limiting to backend
- [ ] Regular model updates and validation

---

## 📱 Quick Command Reference

```bash
# Start everything (3 different terminals)

# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
npm run dev

# Terminal 3: SSH to Jetson and run inference
ssh <user>@192.168.1.100
python3 ~/dr-inference/app.py
```

---

## 🎯 Next Steps

1. **Find Jetson IP** - `hostname -I` on Jetson
2. **Update backend/.env** - Set `JETSON_IP_ADDRESS`
3. **Start backend** - `npm run dev` in backend folder
4. **Start Jetson inference** - Run inference app on Jetson
5. **Start frontend** - `npm run dev` in root
6. **Test** - Register user → Upload image → See results

---

## 📚 Files Reference

| File | Purpose |
|------|---------|
| `backend/.env.example` | Template for environment vars |
| `backend/src/index.ts` | Main backend server |
| `backend/package.json` | Dependencies |
| `src/hooks/useClassificationAPI.ts` | Frontend API client |
| `ARCHITECTURE_JETSON.md` | Detailed architecture |
| `docker-compose.yml` | Container orchestration |

---

**Status:** ✅ Ready to connect to Jetson Orin Nano

**Questions?** Check [ARCHITECTURE_JETSON.md](./ARCHITECTURE_JETSON.md) for detailed information.
