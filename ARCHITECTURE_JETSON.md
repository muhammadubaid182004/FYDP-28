# 🏥 Diabetic Retinopathy Detection - Jetson Orin Nano Architecture

## 🎯 System Overview

```
┌──────────────────┐
│   React Frontend │  ← User uploads retina scan
│   (Port 3000)    │
└────────┬─────────┘
         │
         │ POST /api/classify
         │ (with JWT token)
         │
┌────────▼──────────────────┐
│  Node.js Backend           │  ← API Controller
│  (Port 8000)               │  ← Security layer
│  (Express.js)              │  ← Data storage
└────────┬──────────────────┘
         │
         │ POST http://JETSON_IP:8000/api/predict
         │ (forwards image in multipart/form-data)
         │
┌────────▼──────────────────┐
│  Jetson Orin Nano          │  ← GPU Inference
│  (TensorRT Engine)         │  ← Handles heavy lifting
│  (Custom IP on network)    │
│  - Preprocess image        │
│  - ONNX/TensorRT inference │
│  - Return predictions      │
└────────┬──────────────────┘
         │
         │ JSON Response
         │ {class, confidence, recommendation}
         │
┌────────▼──────────────────┐
│  Node.js Backend           │  ← Process result
│  (Store in DB)             │  ← Add metadata
│  (Return to frontend)      │
└────────┬──────────────────┘
         │
         │ JSON Response with prediction_id
         │
┌────────▼──────────────────┐
│   React Frontend           │  ← Display results
│   (Show severity badge)    │  ← Show confidence
│   (Show recommendation)    │  ← Show inference time
└───────────────────────────┘
```

---

## 🔑 Key Design Decisions

### ✅ Why Node.js Backend?

1. **Type Safety** - TypeScript for reliability
2. **Performance** - Handles many concurrent requests
3. **Simplicity** - Same tech stack as frontend (JavaScript)
4. **Security** - Backend acts as proxy (Jetson never exposed)
5. **Database** - Lightweight JSON storage with optional SQL later

### ✅ Why NOT Direct Frontend→Jetson?

| Issue | Impact | Solution |
|-------|--------|----------|
| **No authentication** | Anyone with IP can access | Backend validates JWT |
| **Exposes device IP** | Security risk | Backend is proxy/controller |
| **No request logging** | Can't audit usage | Backend logs all requests |
| **No data persistence** | Results lost | Backend stores in DB |
| **CORS issues** | Frontend can't reach device | Backend handles CORS |
| **Hard to scale** | Can't load balance | Backend layer enables scaling |

---

## 📋 Data Flow (Step-by-Step)

### Step 1️⃣: User Authentication

```typescript
// Frontend
const response = await fetch("http://localhost:8000/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: "user", password: "pass" })
});

const { token } = await response.json();
localStorage.setItem("dr_token", token);  // Store JWT
```

**Backend processes:**
- Hash password with bcryptjs
- Compare with stored hash
- Generate JWT (24hr expiry)
- Return token

---

### Step 2️⃣: User Uploads Image

```typescript
// Frontend - with authentication
const formData = new FormData();
formData.append("file", imageFile);

const response = await fetch(
  "http://localhost:8000/api/classify",
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${localStorage.getItem("dr_token")}`
    },
    body: formData
  }
);
```

---

### Step 3️⃣: Backend Receives Request

```typescript
// Backend validates:
app.post("/api/classify", authMiddleware, upload.single("file"), async (req, res) => {
  // 1. Verify JWT token ✓
  // 2. Check user exists ✓
  // 3. Validate image (JPEG/PNG) ✓
  // 4. Forward to Jetson...
```

---

### Step 4️⃣: Backend Forwards to Jetson

```typescript
// Backend sends to Jetson
const formData = new FormData();
formData.append("file", new Blob([imageBuffer]), "image.jpg");

const jetsonResponse = await axios.post(
  "http://192.168.1.100:8000/api/predict",
  formData,
  { timeout: 30000 }
);

const { class: severity, confidence, recommendation } = jetsonResponse.data;
```

---

### Step 5️⃣: Jetson Runs Inference

```python
# Jetson Orin Nano (TensorRT)
@app.route('/api/predict', methods=['POST'])
def predict():
    # 1. Receive image
    image_bytes = request.files['file'].read()
    
    # 2. Preprocess
    image = Image.open(BytesIO(image_bytes))
    image = image.resize((224, 224))
    image_array = np.array(image) / 255.0
    
    # 3. Run TensorRT inference
    results = model_session.run(
        [output_name],
        {input_name: image_array[np.newaxis, ...].astype(np.float32)}
    )
    
    # 4. Post-process
    predictions = results[0][0]
    class_idx = np.argmax(predictions)
    confidence = float(predictions[class_idx])
    
    # 5. Return JSON
    return jsonify({
        "class": CLASSES[class_idx],
        "confidence": confidence,
        "recommendation": RECOMMENDATIONS[class_idx],
        "model_version": "1.0.0"
    })
```

---

### Step 6️⃣: Backend Stores Result

```typescript
// Backend saves prediction
const prediction = {
  id: `pred_${Date.now()}`,
  user_id: req.userId,
  severity,      // From Jetson
  confidence,
  recommendation,
  model_version: "1.0.0",
  jetson_inference_time: Date.now() - startTime,
  created_at: new Date().toISOString()
};

predictions.push(prediction);
saveDatabase();  // Save to predictions.db
```

---

### Step 7️⃣: Frontend Receives Result

```typescript
// Response sent back to frontend
{
  "prediction_id": "pred_1701234567890",
  "severity": "Mild DR",
  "confidence": 0.87,
  "recommendation": "Schedule eye exam within 3-6 months.",
  "model_version": "1.0.0",
  "jetson_inference_time": 145,  // ms on Jetson
  "created_at": "2024-04-08T10:30:45.123Z"
}
```

---

### Step 8️⃣: Frontend Displays Results

```jsx
// React component shows:
export function ResultsDisplay() {
  return (
    <>
      <div className={getSeverityColor(result.severity)}>
        {result.severity}  {/* Badge color based on severity */}
      </div>
      <div>Confidence: {(result.confidence * 100).toFixed(1)}%</div>
      <div>Recommendation: {result.recommendation}</div>
      <div>Inference Time: {result.jetson_inference_time}ms</div>
    </>
  );
}
```

---

## 🔌 API Endpoints

### Authentication

```bash
# Register
POST /api/auth/register
{
  "username": "dr_user",
  "email": "user@hospital.com",
  "password": "secure_password",
  "name": "Dr. Smith"
}

# Login
POST /api/auth/login
{
  "username": "dr_user",
  "password": "secure_password"
}

# Response
{
  "token": "eyJhbGc...",
  "user": { "id": "user_1701234567", "username": "dr_user", "email": "..." }
}
```

### Classification

```bash
# Classify Image
POST /api/classify
Headers: Authorization: Bearer <JWT_TOKEN>
Body: multipart/form-data { file: <image> }

# Response
{
  "prediction_id": "pred_1701234567890",
  "severity": "Mild DR",
  "confidence": 0.87,
  "recommendation": "Schedule eye exam within 3-6 months.",
  "jetson_inference_time": 145,
  "model_version": "1.0.0",
  "created_at": "2024-04-08T10:30:45.123Z"
}
```

### History & Analytics

```bash
# Get All Predictions
GET /api/predictions
Headers: Authorization: Bearer <JWT_TOKEN>

# Response
{
  "total": 45,
  "predictions": [
    { "id": "pred_1", "severity": "Mild DR", "confidence": 0.87, ... },
    ...
  ]
}

# Get Specific Prediction
GET /api/predictions/{predictionId}
Headers: Authorization: Bearer <JWT_TOKEN>

# Get Analytics Summary
GET /api/analytics/summary
Headers: Authorization: Bearer <JWT_TOKEN>

# Response
{
  "total_predictions": 45,
  "severity_distribution": {
    "No DR": 15,
    "Mild DR": 20,
    "Moderate DR": 8,
    "Severe DR": 2,
    "Proliferative DR": 0
  },
  "average_confidence": 0.86,
  "average_inference_time_ms": 142,
  "most_recent": { "id": "pred_...", ... }
}
```

---

## 🚀 Local Development Setup

### 1️⃣ Install Backend Dependencies

```bash
cd backend
npm install
```

### 2️⃣ Configure Environment

```bash
# Copy template
cp backend/.env.example backend/.env

# Edit backend/.env
JETSON_IP_ADDRESS=192.168.1.100  # Your Jetson IP
JWT_SECRET=your-secret-key
FRONTEND_URL=http://localhost:3000
```

### 3️⃣ Start Backend (Development)

```bash
cd backend
npm run dev
```

Backend runs at **http://localhost:8000**

### 4️⃣ Start Frontend

```bash
npm run dev
```

Frontend runs at **http://localhost:3000**

### 5️⃣ Jetson Orin Nano Setup (Separate)

Jetson runs independently with TensorRT:
```bash
# On Jetson
python app.py  # Runs inference server at http://0.0.0.0:8000/api/predict
```

---

## 📦 Docker Deployment (Production)

### Build Backend Image

```bash
docker build -f backend/Dockerfile -t dr-backend:latest .
```

### Run Backend Container

```bash
docker run \
  -p 8000:8000 \
  -e JETSON_IP_ADDRESS=192.168.1.100 \
  -e JWT_SECRET=production-secret \
  -v backend_data:/app/data \
  dr-backend:latest
```

### Full Stack with Docker Compose

```bash
# Set Jetson IP
export JETSON_IP_ADDRESS=192.168.1.100

# Start both frontend and backend
docker-compose up -d

# View logs
docker-compose logs -f backend
```

---

## 🔐 Security Considerations

### Authentication Flow

```
User provides username/password
    ↓
Backend hashes with bcryptjs (cost=10)
    ↓
Compares to database hash
    ↓
Generates JWT (HS256, 24hr expiry)
    ↓
Frontend stores JWT in localStorage
    ↓
Frontend includes JWT in Authorization header for all requests
    ↓
Backend verifies JWT signature before processing
```

### Jetson Security

| Concern | Solution |
|---------|----------|
| Direct access to Jetson | Only backend can reach Jetson (firewall) |
| Unauthenticated requests | Backend validates JWT before forwarding |
| Data exposure | Backend logs and stores with user association |
| CORS | Backend handles CORS for frontend |

---

## 🧪 Testing the System

### Test 1: Backend Health

```bash
curl http://localhost:8000/healthz
```

Expected response:
```json
{
  "status": "healthy",
  "backend": "up",
  "jetson_url": "http://192.168.1.100:8000",
  "timestamp": "2024-04-08T10:30:45.123Z"
}
```

### Test 2: User Registration

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

### Test 3: User Login

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "password123"}'

# Save token from response
export TOKEN="eyJhbGc..."
```

### Test 4: Image Classification

```bash
curl -X POST http://localhost:8000/api/classify \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@fundus.jpg"
```

---

## 📊 Performance Considerations

### Jetson Orin Nano Specs

- NVIDIA Jetson Orin Nano Developer Kit
- 6-core ARM CPU
- 1024-CUDA Cores GPU
- 8GB LPDDR5 RAM
- Typical TensorRT inference: **100-200ms per image**

### Backend Performance

- Node.js handles ~1000 requests/sec
- Each request: parse form → forward → wait Jetson → save DB
- Total time: **~200-300ms** (100-200ms Jetson + ~50-100ms backend overhead)

### Frontend Performance

- React image upload: instant
- Display results: instant
- Network delay: depends on network latency

### Optimization Tips

1. **Batch Predictions** - Send multiple images to Jetson
2. **Caching** - Cache identical images (hash-based)
3. **Compression** - Compress JPEG before sending
4. **Database Indexing** - Index user_id and created_at
5. **Load Balancing** - Multiple Jetson devices behind load balancer

---

## 🌐 Environment Variables

### Frontend (`.env`)

```bash
VITE_API_BASE_URL=http://localhost:8000
```

### Backend (`backend/.env`)

```bash
PORT=8000
NODE_ENV=production
JWT_SECRET=your-random-secret-key
FRONTEND_URL=http://localhost:3000
JETSON_IP_ADDRESS=192.168.1.100
DB_PATH=/app/data/predictions.db
```

### Jetson (on device)

```bash
JETSON_PORT=8000
MODEL_PATH=/models/dr-classification.engine
# (TensorRT engine or ONNX model)
```

---

## 📱 API Response Examples

### Success Response

```json
{
  "prediction_id": "pred_1701234567890",
  "severity": "Mild DR",
  "confidence": 0.8734,
  "recommendation": "Schedule eye exam within 3-6 months. Consider increased monitoring.",
  "model_version": "v2.1.0",
  "jetson_inference_time": 147,
  "created_at": "2024-04-08T10:30:45.123Z"
}
```

### Error Response (Jetson Unreachable)

```json
{
  "error": "Jetson inference server unreachable",
  "details": "Cannot connect to http://192.168.1.100:8000",
  "jetson_url": "http://192.168.1.100:8000"
}
```

### Error Response (Authentication Failed)

```json
{
  "error": "Invalid token"
}
```

---

## 🚨 Troubleshooting

### Backend Won't Start

```bash
# Check if port 8000 is in use
lsof -i :8000

# Kill process on port 8000 (Windows)
netstat -ano | findstr :8000
taskkill /PID <PID> /F
```

### Can't Connect to Jetson

```bash
# Verify Jetson IP
ping 192.168.1.100

# Check backend logs
npm run dev  # Will show connection errors

# Update JETSON_IP_ADDRESS in backend/.env
```

### JWT Token Errors

```bash
# Token expired (24 hours)
# Solution: Login again to get new token

# Invalid token
# Solution: Check Authorization header format: "Bearer <token>"
```

### Database Not Persisting

```bash
# Check if predictions.db exists
ls -la predictions.db

# Check write permissions
chmod 644 predictions.db
```

---

## 📚 See Also

- [DEPLOYMENT_QUICKSTART.md](./DEPLOYMENT_QUICKSTART.md) - Quick deployment guide
- [backend/.env.example](./backend/.env.example) - Environment variables
- [backend/src/index.ts](./backend/src/index.ts) - Backend source code
- [src/hooks/useClassificationAPI.ts](./src/hooks/useClassificationAPI.ts) - Frontend API client

---

## ✅ Architecture Checklist

- [ ] Node.js backend installed and running
- [ ] Frontend configured with correct API URL
- [ ] Jetson Orin Nano IP configured in backend
- [ ] JWT authentication tested
- [ ] Image classification tested end-to-end
- [ ] Database persistence tested
- [ ] Docker images built and tested
- [ ] Health checks working

---

**Status:** ✅ Architecture ready for deployment

**Next Steps:**
1. Configure Jetson IP address in backend/.env
2. Set JWT_SECRET for production
3. Deploy backend and frontend
4. Test image classification end-to-end
5. Monitor inference times and accuracy
