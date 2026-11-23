@echo off
chcp 65001 >nul
title Painel de Estudos - Servidor Local (Porta 3000)

:: Garante que o script rode sempre na pasta do projeto, mesmo chamado via Atalho na Área de Trabalho
cd /d "%~dp0"

echo ========================================================
echo   🚀 INICIANDO PAINEL DE ESTUDOS (Node.js + Gemini IA)
echo ========================================================
echo.

:: Verifica se a porta 3000 ja esta em uso (servidor ja rodando)
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] O servidor ja esta rodando em http://localhost:3000 !
    echo Abrindo o navegador...
    start "" "http://localhost:3000"
    timeout /t 2 >nul
    exit /b 0
)

:: Abre o navegador automaticamente apos 2 segundos em segundo plano
start "" cmd /c "timeout /t 2 /nobreak >nul && start "" http://localhost:3000"

echo Iniciando servidor em http://localhost:3000 ...
echo (Mantenha esta janela aberta ou minimizada enquanto estuda. Pressione Ctrl+C para encerrar.)
echo.

node server.js

if %errorlevel% neq 0 (
    echo.
    echo [ERRO] O servidor parou inesperadamente.
    pause
)

