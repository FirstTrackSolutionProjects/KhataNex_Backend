const razorpay = require("./paymentAdapters/razorpay");
const mock = require("./paymentAdapters/mock");
const ApiError = require("./ApiError");

/**
 * Payment Gateway Manager
 * Dispatches payment operations to the configured provider (Razorpay).
 * In production: Razorpay credentials are required. Mock is strictly forbidden.
 * In development: Opt-in mock adapter is enabled only if ALLOW_MOCK_PAYMENTS=true.
 */
function getAdapter() {
  const isProd = process.env.NODE_ENV === "production";
  const provider = (process.env.PAYMENT_PROVIDER || "razorpay").toLowerCase();

  if (isProd) {
    if (provider === "mock") {
      throw new ApiError(500, "Mock payment provider cannot be used in production.");
    }
    if (!razorpay.isConfigured()) {
      throw new ApiError(503, "Payment checkout is currently unconfigured in production. Live Razorpay credentials are required.");
    }
    return razorpay;
  }

  // Development / Test
  if (provider === "razorpay") {
    if (razorpay.isConfigured()) {
      return razorpay;
    }
    if (process.env.ALLOW_MOCK_PAYMENTS === "true") {
      console.warn("⚠️ [PaymentGateway] Razorpay keys not configured in dev. Using explicit opt-in Mock adapter.");
      return mock;
    }
    throw new ApiError(503, "Razorpay credentials are not configured. To test checkout in development, set ALLOW_MOCK_PAYMENTS=true in .env.");
  }

  if (provider === "mock") {
    if (process.env.ALLOW_MOCK_PAYMENTS !== "true") {
      throw new ApiError(500, "Mock provider requires explicit opt-in: set ALLOW_MOCK_PAYMENTS=true in .env.");
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

  isConfigured() {
    return razorpay.isConfigured();
  },

  getStatus() {
    const isProd = process.env.NODE_ENV === "production";
    const razorpayConfigured = razorpay.isConfigured();
    const mockOptIn = !isProd && (process.env.ALLOW_MOCK_PAYMENTS === "true" || process.env.PAYMENT_PROVIDER === "mock");
    return {
      provider: razorpayConfigured ? "razorpay" : (mockOptIn ? "mock" : "unconfigured"),
      isConfigured: razorpayConfigured,
      keyIdPreview: razorpayConfigured ? `${(process.env.RAZORPAY_KEY_ID || "").slice(0, 8)}...` : null,
      webhookConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
      mockAllowed: !isProd,
      mockActive: !razorpayConfigured && mockOptIn,
      environment: isProd ? "production" : "development",
    };
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
