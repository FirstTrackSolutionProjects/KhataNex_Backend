const ApiError = require("../ApiError");

/**
 * Development & Testing Mock Payment Adapter.
 * STRICTLY disabled in production.
 * Requires explicit opt-in via ALLOW_MOCK_PAYMENTS=true in non-production.
 */
class MockAdapter {
  isConfigured() {
    return process.env.NODE_ENV !== "production" && process.env.ALLOW_MOCK_PAYMENTS === "true";
  }

  async createOrder({ orderId, amountPaise, currency = "INR", receipt, notes = {} }) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(500, "Mock payment adapter is strictly disabled in production.");
    }
    if (process.env.ALLOW_MOCK_PAYMENTS !== "true") {
      throw new ApiError(500, "Mock payment adapter requires explicit opt-in: set ALLOW_MOCK_PAYMENTS=true in .env.");
    }

    const providerOrderId = `mock_order_${orderId}_${Date.now()}`;
    return {
      provider: "mock",
      providerOrderId,
      amountPaise,
      currency,
      keyId: "mock_test_key",
    };
  }

  verifyPayment({ providerOrderId, providerPaymentId, signature }) {
    if (process.env.NODE_ENV === "production") return false;
    if (process.env.ALLOW_MOCK_PAYMENTS !== "true") return false;
    return Boolean(providerOrderId && providerPaymentId);
  }

  verifyWebhookSignature({ rawBody, signature }) {
    if (process.env.NODE_ENV === "production") return false;
    if (process.env.ALLOW_MOCK_PAYMENTS !== "true") return false;
    return signature === "mock_webhook_signature";
  }
}

module.exports = new MockAdapter();
