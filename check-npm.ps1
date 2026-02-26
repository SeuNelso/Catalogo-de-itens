# Script de Diagnóstico do npm
# Execute este script no PowerShell para verificar a instalação do Node.js/npm

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Diagnóstico do npm" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verificar Node.js
Write-Host "1. Verificando Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Node.js instalado: $nodeVersion" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Node.js NÃO encontrado" -ForegroundColor Red
        Write-Host "   📥 Instale Node.js de: https://nodejs.org/" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ❌ Node.js NÃO encontrado" -ForegroundColor Red
    Write-Host "   📥 Instale Node.js de: https://nodejs.org/" -ForegroundColor Yellow
}

Write-Host ""

# Verificar npm
Write-Host "2. Verificando npm..." -ForegroundColor Yellow
try {
    $npmVersion = npm --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ npm instalado: v$npmVersion" -ForegroundColor Green
    } else {
        Write-Host "   ❌ npm NÃO encontrado" -ForegroundColor Red
    }
} catch {
    Write-Host "   ❌ npm NÃO encontrado" -ForegroundColor Red
}

Write-Host ""

# Verificar localização do Node.js
Write-Host "3. Localização do Node.js..." -ForegroundColor Yellow
try {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($nodePath) {
        Write-Host "   ✅ Encontrado em: $nodePath" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Node.js não está no PATH" -ForegroundColor Red
    }
} catch {
    Write-Host "   ❌ Node.js não encontrado no PATH" -ForegroundColor Red
}

Write-Host ""

# Verificar localização do npm
Write-Host "4. Localização do npm..." -ForegroundColor Yellow
try {
    $npmPath = (Get-Command npm -ErrorAction SilentlyContinue).Source
    if ($npmPath) {
        Write-Host "   ✅ Encontrado em: $npmPath" -ForegroundColor Green
    } else {
        Write-Host "   ❌ npm não está no PATH" -ForegroundColor Red
    }
} catch {
    Write-Host "   ❌ npm não encontrado no PATH" -ForegroundColor Red
}

Write-Host ""

# Verificar PATH
Write-Host "5. Verificando PATH..." -ForegroundColor Yellow
$pathEnv = $env:PATH -split ';'
$nodeInPath = $pathEnv | Where-Object { $_ -like "*nodejs*" -or $_ -like "*node*" }
if ($nodeInPath) {
    Write-Host "   ✅ Node.js encontrado no PATH:" -ForegroundColor Green
    $nodeInPath | ForEach-Object { Write-Host "      - $_" -ForegroundColor Gray }
} else {
    Write-Host "   ❌ Node.js NÃO está no PATH" -ForegroundColor Red
    Write-Host "   💡 Adicione: C:\Program Files\nodejs\" -ForegroundColor Yellow
}

Write-Host ""

# Verificar permissões
Write-Host "6. Verificando permissões..." -ForegroundColor Yellow
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host "   ✅ Executando como Administrador" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Não está executando como Administrador" -ForegroundColor Yellow
    Write-Host "   💡 Alguns comandos podem precisar de permissões elevadas" -ForegroundColor Gray
}

Write-Host ""

# Resumo e recomendações
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Recomendações" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$nodeOk = $false
$npmOk = $false

try {
    $null = node --version 2>&1
    if ($LASTEXITCODE -eq 0) { $nodeOk = $true }
} catch { }

try {
    $null = npm --version 2>&1
    if ($LASTEXITCODE -eq 0) { $npmOk = $true }
} catch { }

if (-not $nodeOk) {
    Write-Host "❌ Node.js não está instalado ou não está no PATH" -ForegroundColor Red
    Write-Host ""
    Write-Host "📥 SOLUÇÃO:" -ForegroundColor Yellow
    Write-Host "   1. Baixe Node.js LTS de: https://nodejs.org/" -ForegroundColor White
    Write-Host "   2. Execute o instalador .msi" -ForegroundColor White
    Write-Host "   3. Marque 'Add to PATH' durante a instalação" -ForegroundColor White
    Write-Host "   4. Reinicie o terminal após instalar" -ForegroundColor White
    Write-Host ""
} elseif (-not $npmOk) {
    Write-Host "❌ npm não está funcionando corretamente" -ForegroundColor Red
    Write-Host ""
    Write-Host "🔧 SOLUÇÃO:" -ForegroundColor Yellow
    Write-Host "   1. Reinstale o Node.js (npm vem junto)" -ForegroundColor White
    Write-Host "   2. Ou tente: npm install -g npm@latest" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "✅ Tudo parece estar funcionando!" -ForegroundColor Green
    Write-Host ""
    Write-Host "🧪 Teste rápido:" -ForegroundColor Yellow
    Write-Host "   npm --version" -ForegroundColor White
    Write-Host "   npm install" -ForegroundColor White
    Write-Host ""
}

Write-Host "📚 Para mais ajuda, consulte: TROUBLESHOOTING_NPM.md" -ForegroundColor Cyan
Write-Host ""
