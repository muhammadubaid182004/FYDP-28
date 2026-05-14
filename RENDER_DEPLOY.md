# 🚀 Deploy to Render (Easiest Method)

## Step 1: Prepare Your Code

### ⚠️ IMPORTANT: Remove Sensitive Data
Before pushing to GitHub, ensure your `.env` file is in `.gitignore`:

```bash
# Check if .env is ignored
git check-ignore backend/.env
```

## Step 2: Push to GitHub

```bash
# If not already a git repo:
git init
git add .
git commit -m "Initial commit - Diabetic Vision System"

# Create new repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/diabetic-vision-system.git
git push -u origin main
```

## Step 3: Deploy on Render

### 3.1 Sign up for Render
1. Go to https://render.com
2. Sign up with GitHub (free account)

### 3.2 Create New Blueprint
1. Click **"New +"** → **"Blueprint"**
2. Connect your GitHub repository
3. Render will auto-detect `render.yaml` and configure everything!

### 3.3 Set Secret Environment Variables
In Render dashboard, add these secrets:

**Backend Service:**
- `AWS_ACCESS_KEY_ID`: Your AWS access key
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key
- `JWT_SECRET`: (auto-generated, or set your own)

### 3.4 Deploy!
Click **"Apply"** - Render will:
- ✅ Create PostgreSQL database
- ✅ Build backend Docker image
- ✅ Build frontend Docker image
- ✅ Set up SSL certificates
- ✅ Give you public URLs

## Your URLs (after deployment)
- **Frontend**: `https://diabetic-vision-frontend.onrender.com`
- **Backend**: `https://diabetic-vision-backend.onrender.com`
- **Database**: Automatically connected

## Step 4: Verify Deployment

### Check Health:
```bash
curl https://diabetic-vision-backend.onrender.com/healthz
```

### View Logs:
In Render dashboard → Select service → "Logs" tab

## Free Tier Limits
- ✅ 750 hours/month (enough for one service 24/7)
- ✅ 512 MB RAM
- ✅ Auto-sleep after 15 min inactivity (first request takes ~30s)
- ✅ Free PostgreSQL database

## Upgrade to Paid (if needed)
- $7/month per service (no sleep, more RAM)
- $7/month for persistent database

## Troubleshooting

### Backend can't find model file:
Upload `best.onnx` to S3 and set `MODEL_S3_URI` (e.g. `s3://your-bucket/models/best.onnx`) plus your usual AWS credentials. From `backend/`: `npm run model:upload`. Do not commit the ONNX file to git.

### Database connection failed:
Render auto-sets `DATABASE_URL`. Check environment variables in dashboard.

### Frontend can't reach backend:
Update `VITE_API_BASE_URL` in render.yaml with your actual backend URL.

### AWS S3 errors:
Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set correctly in Render dashboard.

## Auto-Deploy on Push
Once set up, every `git push` automatically deploys your changes! 🎉

## Alternative: Manual Docker Setup

If you want to deploy manually without render.yaml:

1. **New Web Service** → Docker
2. Point to your repo
3. Set Dockerfile path: `./backend/Dockerfile`
4. Add environment variables manually
5. Repeat for frontend

---

**Need help?** Check Render docs: https://render.com/docs
