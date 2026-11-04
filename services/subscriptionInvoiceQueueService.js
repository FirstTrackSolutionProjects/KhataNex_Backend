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
 * Invoked immediately after database transaction commit or via background retry.
 *
 * Implements atomic status claiming ('publishing') to guarantee concurrent dispatchers
 * cannot publish the same event unsafely or race each other.
 *
 * @param {number} orderId
 */
async function publishInvoiceEventForOrder(orderId) {
  if (!isSqsConfigured()) {
    console.warn(
      `[SubscriptionInvoiceQueue] SUBSCRIPTION_INVOICE_QUEUE_URL not configured. Outbox event (order #${orderId}) kept pending.`
    );
    return { success: false, reason: "sqs_not_configured" };
  }

  // Atomic claim: Transition event to 'publishing' to prevent concurrent dispatchers from racing.
  // Re-claims stale 'publishing' entries if older than 5 minutes.
  const [claimResult] = await pool.query(
    `UPDATE subscription_invoice_events_outbox
     SET status = 'publishing', updated_at = NOW()
     WHERE order_id = ?
       AND (
         status IN ('pending', 'failed')
         OR (status = 'publishing' AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
       )
       AND attempts < max_attempts`,
    [orderId]
  );

  if (claimResult.affectedRows === 0) {
    // Check why it was not claimed: already published, actively publishing, or max attempts reached
    const [existing] = await pool.query(
      "SELECT status, attempts, max_attempts FROM subscription_invoice_events_outbox WHERE order_id = ?",
      [orderId]
    );
    if (!existing || existing.length === 0) {
      return { success: false, reason: "not_found" };
    }
    const current = existing[0];
    if (current.status === "published") {
      return { success: true, alreadyPublished: true };
    }
    if (current.status === "publishing") {
      return { success: true, skipped: true, inFlight: true, reason: "already_in_flight" };
    }
    if (current.attempts >= current.max_attempts) {
      return { success: false, reason: "max_attempts_exceeded" };
    }
    return { success: false, reason: "cannot_claim" };
  }

  // Fetch the claimed event payload
  const [rows] = await pool.query(
    "SELECT * FROM subscription_invoice_events_outbox WHERE order_id = ?",
    [orderId]
  );
  if (!rows || rows.length === 0) return { success: false, reason: "not_found" };

  const event = rows[0];
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
    `SELECT order_id FROM subscription_invoice_events_outbox
     WHERE (
       status IN ('pending', 'failed')
       OR (status = 'publishing' AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
     ) AND attempts < max_attempts
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
      AND (
        ob.id IS NULL
        OR ob.status = 'failed'
        OR (ob.status = 'publishing' AND ob.updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
      )
  `);

  for (const order of unrecordedOrders) {
    const year = new Date(order.paid_at || Date.now()).getFullYear();
    const invoiceNumber = order.invoice_number || `SUB-${year}-${String(order.id).padStart(5, "0")}`;

    if (!order.invoice_number) {
      await pool.query(
        "UPDATE subscription_orders SET invoice_number = ? WHERE id = ? AND (invoice_number IS NULL OR invoice_number = '')",
        [invoiceNumber, order.id]
      );
    }

    const eventPayload = {
      user_id: Number(order.user_id),
      subscription_order_id: Number(order.id),
      invoice_number: invoiceNumber,
    };

    await pool.query(`
      INSERT INTO subscription_invoice_events_outbox
        (order_id, user_id, invoice_number, event_payload, status, attempts)
      VALUES (?, ?, ?, ?, 'pending', 0)
      ON DUPLICATE KEY UPDATE
        status = IF(status = 'published', 'published', 'pending'),
        invoice_number = VALUES(invoice_number),
        event_payload = VALUES(event_payload),
        updated_at = NOW()
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

