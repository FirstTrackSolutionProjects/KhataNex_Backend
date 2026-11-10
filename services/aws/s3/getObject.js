const { GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
});

const getObject = async (key) => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME is not configured");
  }

  return s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
};

module.exports = getObject;
