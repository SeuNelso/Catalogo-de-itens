const https = require('https');
const AWS = require('aws-sdk');

/** Cliente S3/R2 configurado a partir do ambiente */
function createS3Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.warn('⚠️ [S3] Credenciais R2 não configuradas. Funcionalidades de upload serão limitadas.');
    return null;
  }

  return new AWS.S3({
    endpoint,
    accessKeyId,
    secretAccessKey,
    signatureVersion: 'v4',
    region: 'auto',
    s3ForcePathStyle: true,
    maxRetries: 3,
    httpOptions: {
      timeout: 30000,
      agent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
        rejectUnauthorized: false,
      }),
    },
  });
}

module.exports = { createS3Client };
