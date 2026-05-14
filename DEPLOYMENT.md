# Deployment Guide - Diabetic Vision System

## Railway Deployment

### Prerequisites
- Railway CLI installed: `npm install -g @railway/cli`
- Railway account (free): https://railway.app/

### Step 1: Login to Railway
```bash
railway login
```

### Step 2: Create New Project
```bash
railway init
```

### Step 3: Set Environment Variables

#### Backend Service Variables:
```bash
railway variables set NODE_ENV=production
railway variables set PORT=8000
railway variables set JWT_SECRET=<generate-strong-secret>
railway variables set FRONTEND_URL=<your-frontend-url>
railway variables set MODEL_ONNX_PATH=best.onnx
railway variables set MODEL_S3_URI=s3://YOUR_BUCKET/models/best.onnx
railway variables set MODEL_INPUT_SIZE=256
railway variables set MODEL_CLASS_LABELS=Nrdr,Rdr
railway variables set ALLOW_ONNX_FALLBACK=true
railway variables set AWS_REGION=eu-north-1
railway variables set AWS_ACCESS_KEY_ID=<your-key>
railway variables set AWS_SECRET_ACCESS_KEY=<your-secret>
railway variables set S3_URI=s3://fydp-28
```

#### Database (Railway Postgres Plugin):
Railway will automatically provide `DATABASE_URL` when you add the Postgres plugin.

### Step 4: Deploy
```bash
railway up
```

### Step 5: Add Postgres Database
1. Go to Railway dashboard
2. Click "New" -> "Database" -> "PostgreSQL"
3. Railway automatically sets `DATABASE_URL` environment variable

### Step 6: Get Your URLs
```bash
railway domain
```

## Alternative: Manual Docker Deployment

### Using Docker Compose:
```bash
docker compose up -d
```

### Access:
- Frontend: http://localhost:3000
- Backend: http://localhost:8000

## Environment Variables Reference

### Required for Production:
- `DATABASE_URL`: Postgres connection string (auto-set by Railway)
- `JWT_SECRET`: Strong random string for authentication
- `AWS_ACCESS_KEY_ID`: Your AWS access key
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key
- `S3_URI`: S3 bucket URI
- `FRONTEND_URL`: Frontend domain URL

### Model Configuration:
- `MODEL_S3_URI`: Full S3 URI of the ONNX object (e.g. `s3://fydp-28/models/best.onnx`). The API loads model bytes from S3 into memory on first inference (no local `best.onnx` required). Use the same bucket/credentials as `S3_URI` when possible. Optional: `npm run model:upload` to push a file from disk to that URI.
- `MODEL_ONNX_PATH`: Only used when `MODEL_S3_URI` is unset (local ONNX path). Ignored for inference when `MODEL_S3_URI` is set.
- `MODEL_S3_FORCE_DOWNLOAD`: Only used by `scripts/fetch-model-from-s3.mjs` when you explicitly download the model to disk.
- `MODEL_INPUT_SIZE`: Input image size (default: 256)
- `MODEL_CLASS_LABELS`: Comma-separated class labels
- `ALLOW_ONNX_FALLBACK`: Enable ONNX fallback if TensorRT fails

## Security Notes

⚠️ **NEVER commit .env files to git**
⚠️ **Rotate AWS credentials regularly**
⚠️ **Use strong JWT_SECRET in production**
⚠️ **Enable DATABASE_SSL in production**

## Troubleshooting

### Container fails to start:
```bash
railway logs
```

### Database connection issues:
Check `DATABASE_URL` is set correctly:
```bash
railway variables
```

### Model loading issues:
Set `MODEL_S3_URI` to the exact object key you uploaded. Ensure IAM allows `s3:GetObject` on that object (same credentials as the app). First classification request may be slower while the model loads from S3 into memory.
