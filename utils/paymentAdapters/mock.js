const ApiError = require("../ApiError");

/**
 * Development & Testing Mock Payment Adapter.
 * STRICTLY disabled in production.
 */
class MockAdapter {
  isConfigured() {
    return process.env.NODE_ENV !== "production";
  }

  async createOrder({ orderId, amountPaise, currency = "INR", receipt, notes = {} }) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(500, "Mock payment adapter is strictly disabled in production.");
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
    // In mock development, accept valid mock identifiers
    return Boolean(providerOrderId && providerPaymentId);
  }

  verifyWebhookSignature({ rawBody, signature }) {
    if (process.env.NODE_ENV === "production") return false;
    return signature === "mock_webhook_signature";
  }
}

module.exports = new MockAdapter();

