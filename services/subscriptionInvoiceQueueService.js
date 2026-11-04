const { SendMessageCommand } = require("@aws-sdk/client-sqs");
const pool = require("../config/db");
const { getSqsClient, isSqsConfigured } = require("../config/aws");

/**
 * Enqueues a subscription invoice generation event into the durable outbox table.
 * MUST be executed within the payment fulfillment database transaction.
 *
 * @param {import("mysql2/promise").PoolConnection} conn
 * @param {object} params
 * @param {number} params.orderId
 * @param {number} params.userId
 * @param {string} params.invoiceNumber
 */
async function enqueueInvoiceEvent(conn, { orderId, userId, invoiceNumber }) {
  const eventPayload = {
    user_id: Number(userId),
    subscription_order_id: Number(orderId),
    invoice_number: String(invoiceNumber).trim(),
  };

  await conn.query(
    `INSERT INTO subscription_invoice_events_outbox
       (order_id, user_id, invoice_number, event_payload, status, attempts)
     VALUES (?, ?, ?, ?, 'pending', 0)
     ON DUPLICATE KEY UPDATE
       invoice_number = VALUES(invoice_number),
       event_payload = VALUES(event_payload),
       status = IF(status = 'published', 'published', 'pending'),
       updated_at = NOW()`,
    [orderId, userId, invoiceNumber, JSON.stringify(eventPayload)]
  );
}

/**
 * Publishes a specific order's outbox event to AWS SQS FIFO.
 * Invoked immediately after database transaction commit.
 *
 * @param {number} orderId
 */
async function publishInvoiceEventForOrder(orderId) {
  const [rows] = await pool.query(
    "SELECT * FROM subscription_invoice_events_outbox WHERE order_id = ?",
    [orderId]
  );
  if (!rows || rows.length === 0) return { success: false, reason: "not_found" };

  const event = rows[0];
  if (event.status === "published") {
    return { success: true, alreadyPublished: true };
  }

  if (!isSqsConfigured()) {
    console.warn(
      `[SubscriptionInvoiceQueue] SUBSCRIPTION_INVOICE_QUEUE_URL not configured. Outbox event #${event.id} (order #${orderId}) kept pending.`
    );
    return { success: false, reason: "sqs_not_configured" };
  }

  const sqsClient = getSqsClient();
  const queueUrl = process.env.SUBSCRIPTION_INVOICE_QUEUE_URL;
  const payload = typeof event.event_payload === "string" ? event.event_payload : JSON.stringify(event.event_payload);

  try {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: payload,
      MessageGroupId: `order-${orderId}`,
      MessageDeduplicationId: `sub-inv-${orderId}`,
    });

    await sqsClient.send(command);

    await pool.query(
      `UPDATE subscription_invoice_events_outbox
       SET status = 'published', published_at = NOW(), attempts = attempts + 1, last_error = NULL
       WHERE id = ?`,
      [event.id]
    );

    console.log(
      `[SubscriptionInvoiceQueue] Successfully dispatched invoice SQS event for order #${orderId} (invoice #${event.invoice_number})`
    );
    return { success: true, published: true };
  } catch (err) {
    console.error(
      `[SubscriptionInvoiceQueue] Failed to dispatch SQS message for order #${orderId}:`,
      err.message || err
    );

    await pool.query(
      `UPDATE subscription_invoice_events_outbox
       SET status = 'failed', attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
      [err.message || "Unknown SQS error", event.id]
    );

    return { success: false, error: err.message };
  }
}

/**
 * Scans the outbox table for pending or failed events and dispatches them.
 * Safe to be called on a scheduler or on demand.
 */
async function publishPendingInvoiceEvents(batchSize = 25) {
  if (!isSqsConfigured()) return { published: 0, reason: "sqs_not_configured" };

  const [rows] = await pool.query(
    `SELECT * FROM subscription_invoice_events_outbox
     WHERE status IN ('pending', 'failed') AND attempts < max_attempts
     ORDER BY id ASC LIMIT ?`,
    [batchSize]
  );

  let publishedCount = 0;
  for (const row of rows) {
    const res = await publishInvoiceEventForOrder(row.order_id);
    if (res.success && res.published) publishedCount++;
  }

  return { published: publishedCount, totalPending: rows.length };
}

/**
 * Recovers paid subscription orders that missed outbox recording or invoice creation.
 */
async function recoverMissingInvoiceEvents() {
  const [unrecordedOrders] = await pool.query(`
    SELECT o.id, o.user_id, o.paid_at, o.invoice_number
    FROM subscription_orders o
    LEFT JOIN subscription_invoices i ON i.order_id = o.id
    LEFT JOIN subscription_invoice_events_outbox ob ON ob.order_id = o.id
    WHERE o.status = 'paid'
      AND i.id IS NULL
      AND (ob.id IS NULL OR ob.status = 'failed')
  `);

  for (const order of unrecordedOrders) {
    const year = new Date(order.paid_at || Date.now()).getFullYear();
    const invoiceNumber = order.invoice_number || `SUB-${year}-${String(order.id).padStart(5, "0")}`;

    const eventPayload = {
      user_id: Number(order.user_id),
      subscription_order_id: Number(order.id),
      invoice_number: invoiceNumber,
    };

    await pool.query(`
      INSERT INTO subscription_invoice_events_outbox
        (order_id, user_id, invoice_number, event_payload, status)
      VALUES (?, ?, ?, ?, 'pending')
      ON DUPLICATE KEY UPDATE
        status = IF(status = 'published', 'published', 'pending'),
        invoice_number = VALUES(invoice_number),
        event_payload = VALUES(event_payload)
    `, [order.id, order.user_id, invoiceNumber, JSON.stringify(eventPayload)]);

    await publishInvoiceEventForOrder(order.id);
  }

  return { recovered: unrecordedOrders.length };
}

module.exports = {
  enqueueInvoiceEvent,
  publishInvoiceEventForOrder,
  publishPendingInvoiceEvents,
  recoverMissingInvoiceEvents,
};
