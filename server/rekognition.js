const AWS = require('aws-sdk');
require('dotenv').config();

const rekognition = new AWS.Rekognition({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

async function detectLabelsFromS3(bucket, key, maxLabels = 10, minConfidence = 70) {
  const params = {
    Image: {
      S3Object: {
        Bucket: bucket,
        Name: key
      }
    },
    MaxLabels: maxLabels,
    MinConfidence: minConfidence
  };
  return new Promise((resolve, reject) => {
    rekognition.detectLabels(params, (err, data) => {
      if (err) reject(err);
      else resolve(data.Labels);
    });
  });
}

module.exports = { detectLabelsFromS3 }; 