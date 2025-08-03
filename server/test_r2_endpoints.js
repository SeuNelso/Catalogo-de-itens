const AWS = require('aws-sdk');
require('dotenv').config();

console.log('🔧 Testando diferentes formatos de endpoint do Cloudflare R2...');

// Lista de endpoints para testar
const endpoints = [
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com',
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com/',
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com:443',
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com:443/',
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com:80',
  'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com:80/'
];

async function testEndpoint(endpoint, testNumber) {
  console.log(`\n🔧 Teste ${testNumber}: ${endpoint}`);
  
  const s3 = new AWS.S3({
    endpoint: endpoint,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    signatureVersion: 'v4',
    region: 'auto',
    s3ForcePathStyle: true,
    maxRetries: 1,
    httpOptions: {
      timeout: 5000
    }
  });
  
  try {
    const result = await s3.listBuckets().promise();
    console.log(`✅ Teste ${testNumber} OK: ${result.Buckets.length} buckets encontrados`);
    return true;
  } catch (error) {
    console.log(`❌ Teste ${testNumber} falhou: ${error.message}`);
    return false;
  }
}

async function runEndpointTests() {
  console.log('🔧 Credenciais configuradas:', {
    accessKey: process.env.R2_ACCESS_KEY ? 'PRESENTE' : 'AUSENTE',
    secretKey: process.env.R2_SECRET_KEY ? 'PRESENTE' : 'AUSENTE',
    bucket: process.env.R2_BUCKET
  });
  
  let successCount = 0;
  
  for (let i = 0; i < endpoints.length; i++) {
    const success = await testEndpoint(endpoints[i], i + 1);
    if (success) successCount++;
  }
  
  console.log(`\n🔧 Resultado: ${successCount}/${endpoints.length} endpoints funcionaram`);
  
  if (successCount === 0) {
    console.log('\n⚠️ Nenhum endpoint funcionou. Possíveis problemas:');
    console.log('1. Credenciais incorretas');
    console.log('2. Bucket não existe');
    console.log('3. Endpoint incorreto');
    console.log('4. Problemas de rede/firewall');
  }
}

runEndpointTests(); 