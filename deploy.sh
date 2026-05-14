#!/bin/bash
# 🚀 Quick Deploy Script for Linux/Mac

echo "🎯 Deploying Diabetic Vision System to Render..."
echo ""

# Step 1: Add files
echo "📦 Adding files to git..."
git add .
git status --short

# Step 2: Commit
echo ""
echo "💾 Committing changes..."
git commit -m "Add deployment configuration for Render"

# Step 3: Push to GitHub
echo ""
echo "⬆️  Pushing to GitHub..."
git push origin main

echo ""
echo "✅ Code pushed to GitHub!"
echo ""
echo "📋 Next Steps:"
echo "1. Go to https://render.com"
echo "2. Sign up/Login with GitHub"
echo "3. Click 'New +' → 'Blueprint'"
echo "4. Select repository: FYDP-28"
echo "5. Render will auto-detect render.yaml"
echo "6. Add these secrets in Render dashboard:"
echo "   - AWS_ACCESS_KEY_ID"
echo "   - AWS_SECRET_ACCESS_KEY"
echo "7. Click 'Apply' to deploy!"
echo ""
echo "📖 Full guide: See RENDER_DEPLOY.md"
echo ""
echo "🌐 Your app will be live at:"
echo "   Frontend: https://diabetic-vision-frontend.onrender.com"
echo "   Backend: https://diabetic-vision-backend.onrender.com"
