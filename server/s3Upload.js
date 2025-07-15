const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const BUCKET = process.env.AWS_S3_BUCKET;

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