@echo off
echo ========================================
echo   Diagnostico do npm
echo ========================================
echo.

echo 1. Verificando Node.js...
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo    [OK] Node.js encontrado
    node --version
) else (
    echo    [ERRO] Node.js NAO encontrado
    echo    Instale Node.js de: https://nodejs.org/
)

echo.
echo 2. Verificando npm...
where npm >nul 2>&1
if %errorlevel% equ 0 (
    echo    [OK] npm encontrado
    npm --version
) else (
    echo    [ERRO] npm NAO encontrado
)

echo.
echo 3. Testando instalacao...
if %errorlevel% equ 0 (
    echo    [OK] npm esta funcionando!
    echo.
    echo    Proximo passo: npm install
) else (
    echo    [ERRO] npm nao esta funcionando
    echo.
    echo    SOLUCAO:
    echo    1. Instale Node.js de https://nodejs.org/
    echo    2. Marque "Add to PATH" durante a instalacao
    echo    3. Reinicie o terminal
)

echo.
echo ========================================
pause
