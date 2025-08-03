const AWS = require('aws-sdk');
const https = require('https');
require('dotenv').config();

console.log('🔧 Testando diferentes configurações do Cloudflare R2...');
console.log('🔧 Variáveis de ambiente:');
console.log('  R2_BUCKET:', process.env.R2_BUCKET);
console.log('  R2_ENDPOINT:', process.env.R2_ENDPOINT);
console.log('  R2_ACCESS_KEY:', process.env.R2_ACCESS_KEY ? '***PRESENTE***' : '***AUSENTE***');
console.log('  R2_SECRET_KEY:', process.env.R2_SECRET_KEY ? '***PRESENTE***' : '***AUSENTE***');

// Teste 1: Configuração padrão
async function testConfig1() {
  console.log('\n🔧 Teste 1: Configuração padrão');
  const s3 = new AWS.S3({
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    signatureVersion: 'v4',
    region: 'auto',
    s3ForcePathStyle: true
  });
  
  try {
    const result = await s3.listBuckets().promise();
    console.log('✅ Teste 1 OK:', result.Buckets.length, 'buckets encontrados');
  } catch (error) {
    console.log('❌ Teste 1 falhou:', error.message);
  }
}

// Teste 2: Configuração com região específica
async function testConfig2() {
  console.log('\n🔧 Teste 2: Região us-east-1');
  const s3 = new AWS.S3({
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    signatureVersion: 'v4',
    region: 'us-east-1',
    s3ForcePathStyle: true
  });
  
  try {
    const result = await s3.listBuckets().promise();
    console.log('✅ Teste 2 OK:', result.Buckets.length, 'buckets encontrados');
  } catch (error) {
    console.log('❌ Teste 2 falhou:', error.message);
  }
}

// Teste 3: Configuração sem região
async function testConfig3() {
  console.log('\n🔧 Teste 3: Sem região');
  const s3 = new AWS.S3({
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    signatureVersion: 'v4',
    s3ForcePathStyle: true
  });
  
  try {
    const result = await s3.listBuckets().promise();
    console.log('✅ Teste 3 OK:', result.Buckets.length, 'buckets encontrados');
  } catch (error) {
    console.log('❌ Teste 3 falhou:', error.message);
  }
}

// Teste 4: Testar endpoint alternativo
async function testConfig4() {
  console.log('\n🔧 Teste 4: Endpoint alternativo');
  const s3 = new AWS.S3({
    endpoint: 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com',
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    signatureVersion: 'v4',
    region: 'auto',
    s3ForcePathStyle: true
  });
  
  try {
    const result = await s3.listBuckets().promise();
    console.log('✅ Teste 4 OK:', result.Buckets.length, 'buckets encontrados');
  } catch (error) {
    console.log('❌ Teste 4 falhou:', error.message);
  }
}

// Executar todos os testes
async function runAllTests() {
  await testConfig1();
  await testConfig2();
  await testConfig3();
  await testConfig4();
  
  console.log('\n🔧 Testes concluídos!');
}

runAllTests(); 