# 🔧 Como Resolver Problemas do npm

## ⚡ Diagnóstico Rápido

### Execute no PowerShell ou CMD:

```powershell
node --version
npm --version
```

**Se aparecer erro "não reconhecido":**
- Node.js não está instalado ou não está no PATH
- Continue lendo abaixo

## 🚀 Solução Rápida (5 minutos)

### 1. Instalar Node.js

1. **Baixe Node.js:**
   - Acesse: https://nodejs.org/
   - Clique em "Download Node.js (LTS)" - versão recomendada
   - Baixe o arquivo `.msi` para Windows

2. **Instale:**
   - Execute o arquivo `.msi` baixado
   - Clique em "Next" em todas as telas
   - **IMPORTANTE:** Na tela "Tools for Native Modules", marque:
     - ✅ "Automatically install the necessary tools"
   - Na tela final, certifique-se que está marcado:
     - ✅ "Add to PATH" (deve estar marcado por padrão)

3. **Reinicie o Terminal:**
   - Feche TODOS os terminais abertos
   - Abra um NOVO PowerShell ou CMD
   - Execute novamente: `node --version` e `npm --version`

### 2. Verificar Instalação

```powershell
# Deve mostrar versões (ex: v18.17.0 e 9.6.7)
node --version
npm --version
```

### 3. Testar no Projeto

```powershell
cd C:\Users\felip\Documents\GitHub\Catalogo-de-itens
npm install
```

## 🐛 Se Ainda Não Funcionar

### Problema: PowerShell bloqueando scripts

**Erro:** "running scripts is disabled on this system"

**Solução 1: Usar arquivo .bat (mais fácil)**

Execute o arquivo `check-npm.bat` que foi criado:
```powershell
.\check-npm.bat
```

**Solução 2: Habilitar scripts no PowerShell (cuidado!)**

Execute no PowerShell **como Administrador**:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Depois execute novamente:
```powershell
.\check-npm.ps1
```

**Solução 3: Executar script diretamente**

```powershell
powershell -ExecutionPolicy Bypass -File .\check-npm.ps1
```

### Problema: Node.js instalado mas npm não funciona

```powershell
# Atualizar npm
npm install -g npm@latest

# Ou reinstalar Node.js completamente
```

### Problema: PATH não configurado

1. Pressione `Win + R`
2. Digite: `sysdm.cpl` e pressione Enter
3. Vá em "Avançado" > "Variáveis de Ambiente"
4. Em "Variáveis do sistema", encontre "Path"
5. Clique em "Editar"
6. Verifique se existe: `C:\Program Files\nodejs\`
7. Se não existir, clique em "Novo" e adicione
8. Clique em "OK" em todas as janelas
9. **Reinicie o terminal**

## ✅ Verificação Final

Execute estes comandos e todos devem funcionar:

```powershell
node --version      # Deve mostrar: v18.x.x ou similar
npm --version       # Deve mostrar: 9.x.x ou similar
where node          # Deve mostrar: C:\Program Files\nodejs\node.exe
where npm           # Deve mostrar: C:\Program Files\nodejs\npm.cmd
```

## 📦 Instalar Dependências do Projeto

Após resolver o npm, instale as dependências:

```powershell
# No diretório do projeto
cd C:\Users\felip\Documents\GitHub\Catalogo-de-itens

# Instalar dependências do backend
npm install

# Instalar dependências do frontend
cd client
npm install
cd ..

# Ou usar o script automatizado (se npm estiver funcionando)
npm run install-all
```

## 🎯 Alternativas ao npm

Se npm continuar com problemas, você pode usar:

### Yarn
```powershell
npm install -g yarn
yarn install
yarn start
```

### pnpm
```powershell
npm install -g pnpm
pnpm install
pnpm start
```

## 📞 Ainda com Problemas?

Execute e compartilhe os resultados:

```powershell
# Informações do sistema
node --version
npm --version
where node
where npm
echo $env:PATH

# Teste de instalação
npm install -g npm-check-updates
```

---

**Dica:** Se nada funcionar, considere usar **Docker** ou reinstalar o Windows completamente (último recurso).
