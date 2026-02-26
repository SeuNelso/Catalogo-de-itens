// Script de teste rápido do servidor
require('dotenv').config({ path: './server/.env' });

console.log('========================================');
console.log('  Teste de Configuração do Servidor');
console.log('========================================');
console.log('');

// Verificar variáveis de ambiente
console.log('1. Variáveis de Ambiente:');
console.log('   PORT:', process.env.PORT || '3001 (padrão)');
console.log('   NODE_ENV:', process.env.NODE_ENV || 'development (padrão)');
console.log('   DATABASE_URL:', process.env.DATABASE_URL ? '✅ Configurado' : '❌ Não configurado');
console.log('   DB_HOST:', process.env.DB_HOST || '❌ Não configurado');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ Configurado' : '❌ Não configurado');
console.log('   R2_ENDPOINT:', process.env.R2_ENDPOINT ? '✅ Configurado' : '⚠️  Não configurado (opcional)');
console.log('');

// Verificar módulos principais
console.log('2. Verificando Módulos:');
try {
  require('express');
  console.log('   ✅ express');
} catch(e) {
  console.log('   ❌ express - Execute: npm install');
}

try {
  require('pg');
  console.log('   ✅ pg (PostgreSQL)');
} catch(e) {
  console.log('   ❌ pg - Execute: npm install');
}

try {
  require('dotenv');
  console.log('   ✅ dotenv');
} catch(e) {
  console.log('   ❌ dotenv - Execute: npm install');
}

try {
  require('concurrently');
  console.log('   ✅ concurrently');
} catch(e) {
  console.log('   ❌ concurrently - Execute: npm install');
}

try {
  require('nodemon');
  console.log('   ✅ nodemon');
} catch(e) {
  console.log('   ❌ nodemon - Execute: npm install');
}

console.log('');

// Verificar arquivo do servidor
const fs = require('fs');
const path = require('path');

console.log('3. Verificando Arquivos:');
const serverFile = path.join(__dirname, 'server', 'index.js');
if (fs.existsSync(serverFile)) {
  console.log('   ✅ server/index.js existe');
} else {
  console.log('   ❌ server/index.js não encontrado');
}

const envFile = path.join(__dirname, 'server', '.env');
if (fs.existsSync(envFile)) {
  console.log('   ✅ server/.env existe');
} else {
  console.log('   ⚠️  server/.env não encontrado (crie a partir de env.example)');
}

console.log('');

// Teste de conexão com banco (sem conectar de fato)
console.log('4. Configuração do Banco de Dados:');
if (process.env.DATABASE_URL) {
  console.log('   ✅ DATABASE_URL configurado');
  console.log('   💡 Para testar conexão, execute o servidor');
} else if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD) {
  console.log('   ✅ Variáveis individuais do banco configuradas');
  console.log('   💡 Para testar conexão, execute o servidor');
} else {
  console.log('   ❌ Banco de dados não configurado');
  console.log('   💡 Configure DATABASE_URL ou variáveis individuais no .env');
}

console.log('');
console.log('========================================');
console.log('  Próximos Passos');
console.log('========================================');
console.log('');

const hasEnv = fs.existsSync(envFile);
const hasNodeModules = fs.existsSync(path.join(__dirname, 'node_modules'));

if (!hasNodeModules) {
  console.log('1. Instale as dependências:');
  console.log('   npm install');
  console.log('');
}

if (!hasEnv) {
  console.log('2. Crie o arquivo .env:');
  console.log('   cp server/env.example server/.env');
  console.log('   (ou copie manualmente)');
  console.log('');
}

console.log('3. Execute o servidor:');
console.log('   npm run dev        # Backend + Frontend');
console.log('   npm run server     # Apenas Backend');
console.log('   npm run client     # Apenas Frontend');
console.log('');
