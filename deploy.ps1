# 🚀 Quick Deploy Script

Write-Host "🎯 Deploying Diabetic Vision System to Render..." -ForegroundColor Green
Write-Host ""

# Step 1: Add files
Write-Host "📦 Adding files to git..." -ForegroundColor Yellow
git add .
git status --short

# Step 2: Commit
Write-Host ""
Write-Host "💾 Committing changes..." -ForegroundColor Yellow
git commit -m "Add deployment configuration for Render"

# Step 3: Push to GitHub
Write-Host ""
Write-Host "⬆️  Pushing to GitHub..." -ForegroundColor Yellow
git push origin main

Write-Host ""
Write-Host "✅ Code pushed to GitHub!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next Steps:" -ForegroundColor Cyan
Write-Host "1. Go to https://render.com"
Write-Host "2. Sign up/Login with GitHub"
Write-Host "3. Click 'New +' → 'Blueprint'"
Write-Host "4. Select repository: FYDP-28"
Write-Host "5. Render will auto-detect render.yaml"
Write-Host "6. Add these secrets in Render dashboard:"
Write-Host "   - AWS_ACCESS_KEY_ID"
Write-Host "   - AWS_SECRET_ACCESS_KEY"
Write-Host "7. Click 'Apply' to deploy!"
Write-Host ""
Write-Host "📖 Full guide: See RENDER_DEPLOY.md" -ForegroundColor Cyan
Write-Host ""
Write-Host "🌐 Your app will be live at:" -ForegroundColor Green
Write-Host "   Frontend: https://diabetic-vision-frontend.onrender.com"
Write-Host "   Backend: https://diabetic-vision-backend.onrender.com"
