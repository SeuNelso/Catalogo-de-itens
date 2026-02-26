const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

// Função para criar cliente S3 configurado
function createS3Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_KEY;
  
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }
  
  return new AWS.S3({
    endpoint: endpoint,
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    signatureVersion: 'v4',
    region: 'auto',
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
}

const s3 = createS3Client();
const BUCKET = process.env.R2_BUCKET;

async function uploadToS3(filePath, fileName, mimeType) {
  console.log('🔧 [UPLOAD] Iniciando upload para S3:', fileName);
  
  // Verificar se o cliente S3 está configurado
  if (!s3 || !BUCKET) {
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