# 🔍 Debug do Servidor - npm run dev não funciona

## 🚨 Problemas Comuns

### 1. Dependências não instaladas

**Sintoma:** Erro "Cannot find module" ou "concurrently não encontrado"

**Solução:**
```bash
# Instalar dependências do backend
npm install

# Instalar dependências do frontend
cd client
npm install
cd ..

# Ou instalar tudo de uma vez
npm run install-all
```

### 2. Arquivo .env não encontrado ou mal configurado

**Sintoma:** Erro de conexão com banco ou variáveis undefined

**Solução:**
```bash
# Verificar se o arquivo existe
dir server\.env

# Se não existir, criar a partir do exemplo
copy server\env.example server\.env

# Editar o arquivo .env com suas configurações
```

### 3. Porta já em uso

**Sintoma:** Erro "EADDRINUSE: address already in use"

**Solução:**
```bash
# Verificar qual processo está usando a porta
netstat -ano | findstr :3001
netstat -ano | findstr :3000

# Matar o processo (substitua PID pelo número encontrado)
taskkill /PID <PID> /F

# Ou altere a porta no arquivo .env
PORT=3002
```

### 4. Problema com concurrently

**Sintoma:** Comando para mas não mostra logs ou erro silencioso

**Solução:**
```bash
# Executar servidor e cliente separadamente

# Terminal 1 - Backend
npm run server

# Terminal 2 - Frontend
npm run client
```

### 5. Erro de conexão com banco de dados

**Sintoma:** Erro "Connection refused" ou "timeout"

**Solução:**
1. Verifique se o PostgreSQL está rodando
2. Verifique as credenciais no arquivo `.env`
3. Teste a conexão manualmente:
   ```bash
   psql -h <host> -U <usuario> -d <database>
   ```

## 🔧 Diagnóstico Passo a Passo

### Passo 1: Executar script de teste

```bash
node test-server.js
```

Este script verifica:
- ✅ Variáveis de ambiente
- ✅ Módulos instalados
- ✅ Arquivos necessários
- ✅ Configuração do banco

### Passo 2: Verificar logs detalhados

Execute o servidor com logs detalhados:

```bash
# Backend apenas (para ver erros)
npm run server

# Ou com variáveis de debug
set DEBUG=* && npm run server
```

### Passo 3: Testar componentes separadamente

**Teste 1: Apenas Backend**
```bash
npm run server
```
- Deve mostrar: "Servidor rodando na porta 3001"
- Se funcionar, o problema está no frontend ou no concurrently

**Teste 2: Apenas Frontend**
```bash
cd client
npm start
```
- Deve abrir em http://localhost:3000
- Se funcionar, o problema está no backend ou no concurrently

**Teste 3: Verificar concurrently**
```bash
npm list concurrently
```
- Deve mostrar a versão instalada
- Se não mostrar, instale: `npm install concurrently --save-dev`

## 🐛 Erros Específicos

### Erro: "nodemon não encontrado"

```bash
npm install nodemon --save-dev
```

### Erro: "concurrently não encontrado"

```bash
npm install concurrently --save-dev
```

### Erro: "Cannot find module 'dotenv'"

```bash
npm install dotenv
```

### Erro: "EACCES: permission denied"

Execute o terminal como Administrador (Windows) ou use `sudo` (Linux/Mac)

### Erro: "Port 3000 is already in use"

O React está tentando usar a porta 3000 que já está ocupada.

**Solução:**
```bash
# Opção 1: Matar processo na porta 3000
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Opção 2: Usar porta diferente
# No arquivo client/package.json, adicione:
"start": "set PORT=3002 && react-scripts start"
```

## ✅ Checklist de Verificação

Execute este checklist antes de reportar problemas:

- [ ] Node.js instalado (`node --version`)
- [ ] npm funcionando (`npm --version`)
- [ ] Dependências instaladas (`npm install` executado)
- [ ] Arquivo `.env` existe em `server/.env`
- [ ] Variáveis de ambiente configuradas no `.env`
- [ ] PostgreSQL rodando (se usar banco local)
- [ ] Portas 3000 e 3001 livres
- [ ] Sem erros de sintaxe no código

## 📝 Comandos Úteis

```bash
# Verificar processos Node rodando
tasklist | findstr node

# Matar todos os processos Node
taskkill /F /IM node.exe

# Limpar cache do npm
npm cache clean --force

# Reinstalar dependências
rm -rf node_modules package-lock.json
npm install

# Ver logs detalhados
npm run server --verbose
```

## 🆘 Ainda não funciona?

Execute e compartilhe:

```bash
# 1. Versões
node --version
npm --version

# 2. Teste do servidor
node test-server.js

# 3. Tentar iniciar servidor
npm run server

# 4. Verificar erros
npm run dev 2>&1 | tee error.log
```

---

**Dica:** Sempre execute `npm run server` primeiro para ver se o backend funciona isoladamente antes de tentar `npm run dev`.
