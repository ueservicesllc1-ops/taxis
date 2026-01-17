# Script para crear el archivo .env automáticamente
# Ejecuta: .\create-env.ps1

$envContent = @"
# Environment
NODE_ENV=development

# Server Configuration
PORT=3000

# Firebase Configuration
FIREBASE_API_KEY=AIzaSyC03i4R2cxyOKV4W443mPzDXQ4GBzCgrOc
FIREBASE_AUTH_DOMAIN=superprice-fa792.firebaseapp.com
FIREBASE_PROJECT_ID=superprice-fa792
FIREBASE_STORAGE_BUCKET=superprice-fa792.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=563172013263
FIREBASE_APP_ID=1:563172013263:web:2d162dab07f2222f4233ba
FIREBASE_MEASUREMENT_ID=G-SJF9G3N639

# Google Maps API
GOOGLE_MAPS_API_KEY=AIzaSyCN3M2CUT2BsIwiLrXTqMqLESyTdmPhBog

# Security
JWT_SECRET=dev_secret_change_in_production_min_32_chars_random
SESSION_SECRET=dev_session_secret_change_in_production_random

# CORS
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=debug
"@

# Crear el archivo .env
$envContent | Out-File -FilePath ".env" -Encoding UTF8 -NoNewline

Write-Host "[OK] Archivo .env creado exitosamente!" -ForegroundColor Green
Write-Host "[INFO] Ubicacion: $PWD\.env" -ForegroundColor Cyan
Write-Host ""
Write-Host "[WARNING] IMPORTANTE:" -ForegroundColor Yellow
Write-Host "   - Este archivo NO se subira a Git (esta en .gitignore)" -ForegroundColor Yellow
Write-Host "   - Para produccion, usa railway-env.json" -ForegroundColor Yellow
Write-Host ""
Write-Host "[OK] Ahora puedes ejecutar: npm start" -ForegroundColor Green
