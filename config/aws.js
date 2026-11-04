const { SQSClient } = require("@aws-sdk/client-sqs");
const { S3Client } = require("@aws-sdk/client-s3");

const region = process.env.AWS_REGION || "ap-south-1";

const awsConfig = {
  region,
};

// If explicit credentials are provided in environment, use them; otherwise SDK uses default credential chain
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  awsConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

let sqsClient = null;
let s3Client = null;

function getSqsClient() {
  if (!sqsClient) {
    sqsClient = new SQSClient(awsConfig);
  }
  return sqsClient;
}

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client(awsConfig);
  }
  return s3Client;
}

function isSqsConfigured() {
  return Boolean(process.env.SUBSCRIPTION_INVOICE_QUEUE_URL);
}

function isS3Configured() {
  return Boolean(process.env.S3_BUCKET_NAME);
}

module.exports = {
  getSqsClient,
  getS3Client,
  isSqsConfigured,
  isS3Configured,
};
