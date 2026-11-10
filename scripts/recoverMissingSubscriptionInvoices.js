require("dotenv").config();

const mysql = require("mysql2/promise");
const sendInvoiceGenerationMessage = require("../services/aws/sqs/sendInvoiceGenerationMessage");

const main = async () => {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--dry-run", "--send"].includes(arg)) ||
      (args.includes("--dry-run") && args.includes("--send")) ||
      args.length > 1) {
    throw new Error("Usage: node scripts/recoverMissingSubscriptionInvoices.js [--dry-run | --send]");
  }

  const shouldSend = args.includes("--send");
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "first_track_khatanex",
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0,
    decimalNumbers: true,
  });

  try {
    const [orders] = await pool.query(
      `SELECT o.id
       FROM subscription_orders o
       LEFT JOIN subscription_invoices i ON i.order_id = o.id
       WHERE o.status = 'paid'
         AND (i.id IS NULL OR i.s3_key IS NULL OR i.s3_key = '')
       ORDER BY o.id`
    );

    for (const order of orders) {
      if (!shouldSend) {
        console.log(order.id);
        continue;
      }

      // FIFO queues suppress a repeated deduplication ID for five minutes after the first send.
      await sendInvoiceGenerationMessage(order.id);
      console.log(`Queued invoice generation for order ${order.id}`);
    }
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error("[InvoiceRecovery] Failed:", error.message || error);
  process.exitCode = 1;
});
