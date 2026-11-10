const { SendMessageCommand, SQSClient } = require("@aws-sdk/client-sqs");

const sqsClient = new SQSClient({
  region: process.env.AWS_REGION,
});

const sendInvoiceGenerationMessage = async (subscriptionOrderId) => {
  const queueUrl = process.env.GENERATE_INVOICE_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("GENERATE_INVOICE_QUEUE_URL is not configured");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ subscription_order_id: subscriptionOrderId }),
      MessageGroupId: String(subscriptionOrderId),
      MessageDeduplicationId: `invoice-generate-${subscriptionOrderId}`,
    })
  );
};

module.exports = sendInvoiceGenerationMessage;
