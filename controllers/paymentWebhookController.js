const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const gateway = require("../utils/paymentGateway");
const { fulfillOrder } = require("../utils/subscriptionLogic");

/**
 * Handles incoming webhooks from Razorpay or configured payment provider.
 * Enforces:
 * 1. Raw body cryptographic signature verification.
 * 2. Idempotent event tracking via payment_webhook_events.
 * 3. Amount and currency validation against durable orders.
 * 4. Safe coupon reservation release on failed payments.
 */
const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

  const isValid = gateway.verifyWebhookSignature({
    rawBody,
    signature,
  });

  if (!isValid) {
    throw new ApiError(400, "Invalid webhook signature.");
  }

  const payload = req.body || {};
  const eventId = payload.event_id || payload.id || `evt_${Date.now()}`;
  const eventType = payload.event || "unknown";

  // Check for duplicate processed events
  const [existingEvents] = await pool.query(
    "SELECT id FROM payment_webhook_events WHERE provider = 'razorpay' AND event_id = ?",
    [eventId]
  );
  if (existingEvents.length > 0) {
    return res.status(200).json({ success: true, duplicate: true, message: "Event already processed." });
  }

  // Insert event log
  const [ins] = await pool.query(
    `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload, status)
     VALUES ('razorpay', ?, ?, ?, 'processed')`,
    [eventId, eventType, JSON.stringify(payload)]
  );
  const logId = ins.insertId;

  const finish = (status, errorMsg = null) => {
    pool.query(
      "UPDATE payment_webhook_events SET status = ?, error_message = ? WHERE id = ?",
      [status, errorMsg, logId]
    ).catch(console.error);
    return res.status(200).json({ success: true, event: eventType, status });
  };

  // Handle payment success / order paid
  if (eventType === "order.paid" || eventType === "payment.captured") {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const orderEntity = payload.payload?.order?.entity || {};

    const providerOrderId = paymentEntity.order_id || orderEntity.id;
    const providerPaymentId = paymentEntity.id;
    const amountPaise = paymentEntity.amount || orderEntity.amount;
    const currency = (paymentEntity.currency || orderEntity.currency || "INR").toUpperCase();

    if (!providerOrderId) {
      return finish("ignored", "Missing provider order id in webhook payload");
    }

    const [orders] = await pool.query(
      "SELECT * FROM subscription_orders WHERE provider_order_id = ?",
      [providerOrderId]
    );

    if (!orders.length) {
      return finish("ignored", `No local order found matching provider order: ${providerOrderId}`);
    }

    const order = orders[0];

    // Amount & currency verification
    if (order.total_paise !== Number(amountPaise) || order.currency !== currency) {
      return finish("failed", `Amount or currency mismatch: expected ${order.total_paise} ${order.currency}, received ${amountPaise} ${currency}`);
    }

    const result = await fulfillOrder(order.id, providerPaymentId, signature);
    return finish(result.alreadyPaid ? "already_paid" : "fulfilled");
  }

  // Handle payment failure
  if (eventType === "payment.failed") {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const providerOrderId = paymentEntity.order_id;

    if (providerOrderId) {
      const [orders] = await pool.query(
        "SELECT id, status FROM subscription_orders WHERE provider_order_id = ?",
        [providerOrderId]
      );
      if (orders.length && ["created", "pending"].includes(orders[0].status)) {
        const orderId = orders[0].id;
        await pool.query("UPDATE subscription_orders SET status = 'failed' WHERE id = ?", [orderId]);
        // Safely release coupon reservation
        await pool.query("UPDATE coupon_redemptions SET status = 'released' WHERE order_id = ?", [orderId]);
      }
    }
    return finish("processed");
  }

  return finish("ignored");
});

module.exports = {
  handlePaymentWebhook,
};

