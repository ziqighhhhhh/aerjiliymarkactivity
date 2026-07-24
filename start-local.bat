@echo off
title TigerHead Coupon Server (local test)
cd /d %~dp0

set ADMIN_KEY=admin123
set PORT=8080

echo ============================================
echo  TigerHead Partner Festival - local test
echo  Consumer page : http://localhost:%PORT%/
echo  Clerk redeem  : http://localhost:%PORT%/redeem
echo  Admin panel   : http://localhost:%PORT%/admin?key=%ADMIN_KEY%
echo  Database file : %cd%\coupons.db (delete to reset)
echo ============================================

start "" "http://localhost:%PORT%/"
start "" "http://localhost:%PORT%/redeem"
start "" "http://localhost:%PORT%/admin?key=%ADMIN_KEY%"

node server.js
pause
