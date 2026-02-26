@echo off
echo ========================================
echo   Iniciando Servidor de Desenvolvimento
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

if not exist "client\node_modules" (
    echo [AVISO] client\node_modules nao encontrado!
    echo Instalando dependencias do frontend...
    cd client
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias do frontend
        pause
        exit /b 1
    )
    cd ..
)

echo.
echo Verificando arquivo .env...
if not exist "server\.env" (
    echo [AVISO] Arquivo server\.env nao encontrado!
    echo Criando a partir do exemplo...
    if exist "server\env.example" (
        copy "server\env.example" "server\.env"
        echo Arquivo .env criado. Configure as variaveis antes de continuar.
        pause
        exit /b 1
    ) else (
        echo [ERRO] Arquivo env.example nao encontrado!
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo   Iniciando servidor...
echo ========================================
echo.
echo Backend: http://localhost:3001
echo Frontend: http://localhost:3000
echo.
echo Pressione Ctrl+C para parar
echo.

call npm run dev

pause
