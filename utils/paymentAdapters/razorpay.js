const crypto = require("crypto");
const ApiError = require("../ApiError");

/**
 * Razorpay Payment Adapter
 * Official API interaction, order creation, and signature verification using Node.js crypto.
 * Supports explicit distinction between TEST MODE (rzp_test_*) and LIVE MODE (rzp_live_*).
 * Supports deterministic simulated responses for automated test suites when RAZORPAY_MOCK_GATEWAY=true.
 */
class RazorpayAdapter {
  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || "";
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || this.keySecret;
  }

  getKeyId() {
    return process.env.RAZORPAY_KEY_ID || this.keyId || (process.env.RAZORPAY_MOCK_GATEWAY === "true" ? "rzp_test_mock_suite" : "");
  }

  getKeySecret() {
    return process.env.RAZORPAY_KEY_SECRET || this.keySecret || (process.env.RAZORPAY_MOCK_GATEWAY === "true" ? "mock_razorpay_secret_for_tests" : "");
  }

  getWebhookSecret() {
    return process.env.RAZORPAY_WEBHOOK_SECRET || this.webhookSecret || this.getKeySecret();
  }

  isConfigured() {
    if (process.env.RAZORPAY_MOCK_GATEWAY === "true") return true;
    return Boolean(this.getKeyId() && this.getKeySecret());
  }

  isTestMode() {
    return this.getKeyId().startsWith("rzp_test_");
  }

  isLiveMode() {
    return this.getKeyId().startsWith("rzp_live_");
  }

  getMode() {
    if (this.isTestMode()) return "test";
    if (this.isLiveMode()) return "live";
    return this.isConfigured() ? "custom" : "unconfigured";
  }

  /**
   * Create an order on Razorpay
   */
  async createOrder({ orderId, amountPaise, currency = "INR", receipt, notes = {} }) {
    if (!this.isConfigured()) {
      throw new ApiError(503, "Razorpay API credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured.");
    }

    // Safety guard: prevent accidental live charges if test mode is explicitly enforced
    if (process.env.RAZORPAY_FORCE_TEST_MODE === "true" && !this.isTestMode()) {
      throw new ApiError(400, "Live mode Razorpay key blocked: RAZORPAY_FORCE_TEST_MODE is enabled.");
    }

    // Deterministic mock order creation for automated test suites
    if (process.env.RAZORPAY_MOCK_GATEWAY === "true") {
      return {
        provider: "razorpay",
        providerOrderId: `order_test_${orderId}_${Date.now()}`,
        amountPaise,
        currency: currency.toUpperCase(),
        keyId: this.getKeyId(),
        mode: "test",
      };
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

    const keyId = this.getKeyId();
    const keySecret = this.getKeySecret();
    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

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
      keyId,
      mode: this.getMode(),
    };
  }

  /**
   * Verify frontend checkout payment signature using official HMAC-SHA256
   */
  verifyPayment({ providerOrderId, providerPaymentId, signature }) {
    if (!this.isConfigured()) return false;
    if (!providerOrderId || !providerPaymentId || !signature) return false;

    const secret = this.getKeySecret();
    if (!secret) return false;

    const payload = `${providerOrderId}|${providerPaymentId}`;
    const expected = crypto
      .createHmac("sha256", secret)
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
   * Verify webhook signature using official raw body HMAC-SHA256
   */
  verifyWebhookSignature({ rawBody, signature }) {
    if (!signature || !rawBody) return false;
    const secret = this.getWebhookSecret();
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
