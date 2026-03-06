const { RekognitionClient, DetectLabelsCommand } = require('@aws-sdk/client-rekognition');
require('dotenv').config();

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
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
  const data = await rekognition.send(new DetectLabelsCommand(params));
  return data.Labels;
}

module.exports = { detectLabelsFromS3 }; 