const AWS = require('aws-sdk');
const https = require('https');
require('dotenv').config();

// Configuração do S3 para Cloudflare R2
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT || 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com',
  accessKeyId: process.env.R2_ACCESS_KEY || '32f0b3b31955b3878e1c2c107ef33fd5',
  secretAccessKey: process.env.R2_SECRET_KEY || '580539e25b1580ce1c37425fb3eeb45be831ec029b352f6375614399e7ab714f',
  signatureVersion: 'v4',
  region: 'us-east-1',
  s3ForcePathStyle: true,
  maxRetries: 3,
  httpOptions: {
    timeout: 30000,
    agent: new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      rejectUnauthorized: false
    })
  }
});

const bucket = process.env.R2_BUCKET || 'catalogo-imagens';

console.log('🔧 Testando conectividade com Cloudflare R2...');
console.log('🔧 Endpoint:', process.env.R2_ENDPOINT || 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com');
console.log('🔧 Bucket:', bucket);

// Testar listagem de objetos
async function testConnection() {
  try {
    console.log('📋 Listando objetos no bucket...');
    const result = await s3.listObjectsV2({
      Bucket: bucket,
      MaxKeys: 5
    }).promise();
    
    console.log('✅ Conectividade OK!');
    console.log('📊 Objetos encontrados:', result.Contents ? result.Contents.length : 0);
    
    if (result.Contents && result.Contents.length > 0) {
      console.log('📋 Primeiros objetos:');
      result.Contents.slice(0, 3).forEach((obj, index) => {
        console.log(`   ${index + 1}. ${obj.Key} (${obj.Size} bytes)`);
      });
    }
    
  } catch (error) {
    console.error('❌ Erro na conectividade:', error.message);
    console.error('🔧 Detalhes:', error);
  }
}

testConnection(); 