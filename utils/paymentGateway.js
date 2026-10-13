const razorpay = require("./paymentAdapters/razorpay");
const mock = require("./paymentAdapters/mock");
const ApiError = require("./ApiError");

/**
 * Payment Gateway Manager
 * Dispatches payment operations to the configured provider (Razorpay).
 * Falls back to mock adapter only in non-production development if Razorpay keys are not yet provided.
 */
function getAdapter() {
  const provider = (process.env.PAYMENT_PROVIDER || "razorpay").toLowerCase();

  if (provider === "razorpay") {
    if (razorpay.isConfigured()) {
      return razorpay;
    }
    if (process.env.NODE_ENV !== "production") {
      console.warn("⚠️ [PaymentGateway] Razorpay keys not found in dev environment. Falling back to Mock adapter.");
      return mock;
    }
    throw new ApiError(500, "Razorpay credentials are missing in production.");
  }

  if (provider === "mock") {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(500, "Mock provider cannot be used in production.");
    }
    return mock;
  }

  throw new ApiError(500, `Unknown payment provider: ${provider}`);
}

module.exports = {
  getProviderName() {
    const adapter = getAdapter();
    return adapter === razorpay ? "razorpay" : "mock";
  },

  async createOrder(params) {
    const adapter = getAdapter();
    return adapter.createOrder(params);
  },

  verifyPayment(params) {
    const adapter = getAdapter();
    return adapter.verifyPayment(params);
  },

  verifyWebhookSignature(params) {
    const adapter = getAdapter();
    return adapter.verifyWebhookSignature(params);
  },
};

