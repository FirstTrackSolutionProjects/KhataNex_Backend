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
    this.keyId = this.readEnvKeyId();
    this.keySecret = this.readEnvKeySecret();
    this.webhookSecret = this.readEnvWebhookSecret();
  }

  readEnvKeyId() {
    const raw =
      process.env.RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_LIVE_KEY_ID ||
      process.env.RAZOR_PAY_KEY_ID ||
      process.env.RZP_KEY_ID ||
      process.env.RAZORPAY_KEY ||
      "";
    return String(raw).trim();
  }

  readEnvKeySecret() {
    const raw =
      process.env.RAZORPAY_KEY_SECRET ||
      process.env.RAZORPAY_LIVE_KEY_SECRET ||
      process.env.RAZOR_PAY_KEY_SECRET ||
      process.env.RZP_KEY_SECRET ||
      process.env.RAZORPAY_SECRET ||
      "";
    return String(raw).trim();
  }

  readEnvWebhookSecret() {
    const raw =
      process.env.RAZORPAY_WEBHOOK_SECRET ||
      process.env.RAZOR_PAY_WEBHOOK_SECRET ||
      process.env.RZP_WEBHOOK_SECRET ||
      "";
    const trimmed = String(raw).trim();
    if (trimmed) return trimmed;
    // In production, do not silently fall back to the API Key Secret.
    if (process.env.NODE_ENV === "production") {
      return "";
    }
    return this.readEnvKeySecret();
  }

  getKeyId() {
    const envVal = this.readEnvKeyId();
    if (envVal) return envVal;
    if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_MOCK_GATEWAY === "true") {
      return "rzp_test_mock_suite";
    }
    return "";
  }

  getKeySecret() {
    const envVal = this.readEnvKeySecret();
    if (envVal) return envVal;
    if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_MOCK_GATEWAY === "true") {
      return "mock_razorpay_secret_for_tests";
    }
    return "";
  }

  getWebhookSecret() {
    const envVal = this.readEnvWebhookSecret();
    if (envVal) return envVal;
    if (process.env.NODE_ENV === "production") {
      return "";
    }
    return this.getKeySecret();
  }

  isConfigured() {
    if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_MOCK_GATEWAY === "true") return true;
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

    // Safety guard: prevent accidental live charges if test mode is explicitly enforced in non-production
    if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_FORCE_TEST_MODE === "true" && !this.isTestMode()) {
      throw new ApiError(400, "Live mode Razorpay key blocked: RAZORPAY_FORCE_TEST_MODE is enabled.");
    }

    // Deterministic mock order creation for automated test suites (strictly forbidden in production)
    if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_MOCK_GATEWAY === "true") {
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
