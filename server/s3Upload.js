const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT, // Ex: https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'auto',
  s3ForcePathStyle: true,
  // Configurações específicas para Cloudflare R2
  maxRetries: 3,
  httpOptions: {
    timeout: 30000
  }
});

const BUCKET = process.env.R2_BUCKET;

async function uploadToS3(filePath, fileName, mimeType) {
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
        reject(err);
      } else {
        resolve({
          url: data.Location,
          key: data.Key
        });
      }
    });
  });
}

module.exports = { uploadToS3 }; 