@echo off
echo ========================================
echo   Iniciando APENAS o Backend
echo ========================================
echo.

echo Verificando dependencias...
if not exist "node_modules" (
    echo [AVISO] node_modules nao encontrado!
    echo Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias
        pause
        exit /b 1
    )
)

echo.
echo Verificando arquivo .env...
if not exist "server\.env" (
    echo [ERRO] Arquivo server\.env nao encontrado!
    echo Crie o arquivo .env a partir de server\env.example
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Iniciando servidor backend...
echo ========================================
echo.
echo Backend: http://localhost:3001
echo.
echo Pressione Ctrl+C para parar
echo.

call npm run server

pause
