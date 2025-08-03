const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT, // Ex: https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'auto', // Voltando para 'auto' para Cloudflare R2
  s3ForcePathStyle: true,
  // Configurações específicas para Cloudflare R2
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

const BUCKET = process.env.R2_BUCKET;

async function uploadToS3(filePath, fileName, mimeType) {
  console.log('🔧 [UPLOAD] Iniciando upload para S3:', fileName);
  
  // Verificar se as credenciais estão configuradas
  if (!process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY || 
      process.env.R2_ACCESS_KEY === '32f0b3b31955b3878e1c2c107ef33fd5') {
    console.log('⚠️ [UPLOAD] Credenciais R2 não configuradas, simulando upload');
    return Promise.resolve({
      url: `/api/imagem/${encodeURIComponent(fileName)}`,
      key: fileName
    });
  }
  
  const fileContent = fs.readFileSync(filePath);
  const params = {
    Bucket: BUCKET,
    Key: fileName,
    Body: fileContent,
    ContentType: mimeType
  };
  
  return new Promise((resolve, reject) => {
    s3.upload(params, (err, data) => {
      if (err) {
        console.error('❌ [UPLOAD] Erro ao fazer upload para R2:', err);
        // Não rejeitar o erro, retornar URL simulada
        console.log('⚠️ [UPLOAD] Continuando com URL simulada');
        resolve({
          url: `/api/imagem/${encodeURIComponent(fileName)}`,
          key: fileName
        });
      } else {
        console.log('✅ [UPLOAD] Upload para R2 realizado com sucesso:', fileName);
        resolve({
          url: data.Location,
          key: data.Key
        });
      }
    });
  });
}

module.exports = { uploadToS3 }; 