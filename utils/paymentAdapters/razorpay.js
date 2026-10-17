const crypto = require("crypto");
const ApiError = require("../ApiError");

/**
 * Razorpay Payment Adapter
 * Official API interaction and signature verification using Node.js crypto.
 */
class RazorpayAdapter {
  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || "";
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || this.keySecret;
  }

  isConfigured() {
    return Boolean(this.keyId && this.keySecret);
  }

  /**
   * Create an order on Razorpay
   */
  async createOrder({ orderId, amountPaise, currency = "INR", receipt, notes = {} }) {
    if (!this.isConfigured()) {
      throw new ApiError(503, "Razorpay API credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured.");
    }

    const payload = {
      amount: amountPaise,
      currency: currency.toUpperCase(),
      receipt: String(receipt || orderId),
      notes: {
        orderId: String(orderId),
        ...notes,
      },
    };

    const authHeader = "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data?.error?.description || "Failed to create order on Razorpay";
      throw new ApiError(502, `Razorpay error: ${msg}`);
    }

    return {
      provider: "razorpay",
      providerOrderId: data.id,
      amountPaise: data.amount,
      currency: data.currency,
      keyId: this.keyId,
    };
  }

  /**
   * Verify frontend checkout payment signature
   */
  verifyPayment({ providerOrderId, providerPaymentId, signature }) {
    if (!this.isConfigured()) return false;
    if (!providerOrderId || !providerPaymentId || !signature) return false;

    const payload = `${providerOrderId}|${providerPaymentId}`;
    const expected = crypto
      .createHmac("sha256", this.keySecret)
      .update(payload)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const sigBuf = Buffer.from(signature, "utf8");

    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature({ rawBody, signature }) {
    if (!signature || !rawBody) return false;
    const secret = this.webhookSecret;
    if (!secret) return false;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "utf8");
    const sigBuf = Buffer.from(signature, "utf8");

    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }
}

module.exports = new RazorpayAdapter();
