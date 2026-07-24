@echo off
chcp 65001 >nul
title TigerHead Coupon Server (local test)
cd /d %~dp0

set ADMIN_KEY=admin123
set PORT=8080

echo ============================================
echo  TigerHead 伙伴节 · 本地测试服务
echo  消费者页:  http://localhost:%PORT%/
echo  店员核销:  http://localhost:%PORT%/redeem
echo  管理后台:  http://localhost:%PORT%/admin?key=%ADMIN_KEY%
echo  数据库:    %cd%\coupons.db (删除可重置)
echo ============================================

start "" "http://localhost:%PORT%/"
start "" "http://localhost:%PORT%/redeem"
start "" "http://localhost:%PORT%/admin?key=%ADMIN_KEY%"

node server.js
pause
