const fs = require("fs");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const gateway = require("../utils/paymentGateway");
const {
  TAX_PERCENT,
  isEligibleForIntroductoryOffer,
  priceOrder,
  fulfillOrder,
} = require("../utils/subscriptionLogic");
const {
  issueInvoice,
  invoiceFilePath,
  sendInvoiceEmail,
} = require("../utils/subscriptionInvoice");

/**
 * GET /api/subscriptions/plans
 * Returns active plans, regular & intro pricing, and current user eligibility
 */
const listPlans = asyncHandler(async (req, res) => {
  const [plans] = await pool.query(
    "SELECT id, code, name, duration_months, price_paise, introductory_price_paise, is_active FROM subscription_plans WHERE is_active = 1 ORDER BY duration_months ASC"
  );

  let isIntroductoryEligible = false;
  if (req.user) {
    isIntroductoryEligible = await isEligibleForIntroductoryOffer(req.user.id);
  }

  const enrichedPlans = plans.map((plan) => {
    const effectivePricePaise = isIntroductoryEligible ? plan.introductory_price_paise : plan.price_paise;
    const savingsPaise = Math.max(0, plan.price_paise - effectivePricePaise);
    return {
      ...plan,
      is_eligible_for_introductory: isIntroductoryEligible,
      effective_price_paise: effectivePricePaise,
      savings_paise: savingsPaise,
    };
  });

  res.json({
    success: true,
    isIntroductoryEligible,
    taxPercent: TAX_PERCENT,
    plans: enrichedPlans,
  });
});

/**
 * POST /api/subscriptions/price
 * Computes server-authoritative price breakdown with intro & coupon logic
 */
const previewPrice = asyncHandler(async (req, res) => {
  const { plan_code, coupon_code } = req.body;
  if (!plan_code) throw new ApiError(400, "plan_code is required.");

  const [plans] = await pool.query(
    "SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1",
    [String(plan_code).trim()]
  );
  if (!plans.length) throw new ApiError(404, "Subscription plan not found or inactive.");
  const plan = plans[0];

  const isEligible = await isEligibleForIntroductoryOffer(req.user.id);
  const pricing = await priceOrder({
    plan,
    isIntroductoryEligible: isEligible,
    couponCode: coupon_code,
    userId: req.user.id,
  });

  res.json({
    success: true,
    plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      duration_months: plan.duration_months,
    },
    pricing,
  });
});

/**
 * POST /api/subscriptions/orders
 * Creates a durable order, reserves coupon, and initializes provider checkout
 */
const createOrder = asyncHandler(async (req, res) => {
  const { plan_code, coupon_code } = req.body;
  if (!plan_code) throw new ApiError(400, "plan_code is required.");

  const [plans] = await pool.query(
    "SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1",
    [String(plan_code).trim()]
  );
  if (!plans.length) throw new ApiError(404, "Subscription plan not found or inactive.");
  const plan = plans[0];

  const isEligible = await isEligibleForIntroductoryOffer(req.user.id);
  const pricing = await priceOrder({
    plan,
    isIntroductoryEligible: isEligible,
    couponCode: coupon_code,
    userId: req.user.id,
  });

  const orderNumber = `ORD-${Date.now()}-${req.user.id}`;

  const [ins] = await pool.query(
    `INSERT INTO subscription_orders 
       (order_number, user_id, plan_id, is_introductory, list_price_paise, introductory_discount_paise,
        coupon_id, coupon_code, coupon_discount_paise, discount_paise, taxable_paise, tax_percent,
        tax_paise, total_paise, currency, status, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'created', 'razorpay')`,
    [
      orderNumber,
      req.user.id,
      plan.id,
      pricing.isIntroductory ? 1 : 0,
      pricing.listPricePaise,
      pricing.introductoryDiscountPaise,
      pricing.couponId,
      pricing.couponCode,
      pricing.couponDiscountPaise,
      pricing.discountPaise,
      pricing.taxablePaise,
      pricing.taxPercent,
      pricing.taxPaise,
      pricing.totalPaise,
    ]
  );

  const orderId = ins.insertId;

  // Reserve coupon redemption if coupon applied
  if (pricing.couponId) {
    try {
      await pool.query(
        `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, status)
         VALUES (?, ?, ?, 'reserved')`,
        [pricing.couponId, req.user.id, orderId]
      );
    } catch (couponErr) {
      console.warn(`[CreateOrder] Coupon reservation failed for order ${orderId}:`, couponErr.message);
    }
  }

  // Handle 100% off zero-payable orders immediately without gateway
  if (pricing.totalPaise === 0) {
    await fulfillOrder(orderId, null, null);
    return res.status(201).json({
      success: true,
      free: true,
      order: {
        id: orderId,
        orderNumber,
        status: "paid",
        ...pricing,
      },
    });
  }

  // Initialize checkout with payment provider
  const checkout = await gateway.createOrder({
    orderId,
    amountPaise: pricing.totalPaise,
    currency: "INR",
    receipt: orderNumber,
    notes: {
      orderId,
      orderNumber,
      userId: req.user.id,
      planCode: plan.code,
    },
  });

  // Update order record with provider details
  await pool.query(
    "UPDATE subscription_orders SET provider = ?, provider_order_id = ? WHERE id = ?",
    [checkout.provider, checkout.providerOrderId, orderId]
  );

  res.status(201).json({
    success: true,
    free: false,
    order: {
      id: orderId,
      orderNumber,
      amountPaise: pricing.totalPaise,
      currency: checkout.currency,
      provider: checkout.provider,
      providerOrderId: checkout.providerOrderId,
      keyId: checkout.keyId,
      planName: plan.name,
      userName: req.user.name,
      userEmail: req.user.email,
      userPhone: req.user.phone,
    },
  });
});

/**
 * POST /api/subscriptions/orders/:id/verify
 * Verifies client payment completion and fulfills the subscription
 */
const verifyOrderPayment = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const { provider_payment_id, provider_signature } = req.body;

  const [orders] = await pool.query(
    "SELECT * FROM subscription_orders WHERE id = ? AND user_id = ?",
    [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status === "paid") {
    return res.json({ success: true, status: "paid", message: "Order is already fulfilled." });
  }

  const isValid = gateway.verifyPayment({
    providerOrderId: order.provider_order_id,
    providerPaymentId: provider_payment_id,
    signature: provider_signature,
  });

  if (!isValid) {
    throw new ApiError(400, "Payment verification signature failed.");
  }

  await fulfillOrder(order.id, provider_payment_id, provider_signature);

  res.json({
    success: true,
    status: "paid",
    message: "Payment successfully verified and subscription activated.",
  });
});

/**
 * GET /api/subscriptions/orders/:id
 * Fetches order status for authenticated owner or superadmin
 */
const getOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const isSuperadmin = req.user.role === "superadmin";

  const [orders] = await pool.query(
    `SELECT o.*, p.name AS plan_name, p.duration_months, i.invoice_number, i.pdf_filename
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     LEFT JOIN subscription_invoices i ON i.order_id = o.id
     WHERE o.id = ? ${isSuperadmin ? "" : "AND o.user_id = ?"}`,
    isSuperadmin ? [orderId] : [orderId, req.user.id]
  );

  if (!orders.length) throw new ApiError(404, "Order not found.");

  res.json({
    success: true,
    order: orders[0],
  });
});

/**
 * GET /api/subscriptions/me
 * Returns current user's active subscription, remaining days, and billing history
 */
const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user.role === "employee" && req.user.created_by_admin
    ? req.user.created_by_admin
    : req.user.id;

  // Active subscription
  const [activeSubs] = await pool.query(
    `SELECT s.*, p.name AS plan_name, p.code AS plan_code, p.duration_months
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.user_id = ? AND s.ends_at > NOW()
     ORDER BY s.ends_at DESC LIMIT 1`,
    [userId]
  );

  const activeSubscription = activeSubs[0] || null;
  let remainingDays = 0;
  if (activeSubscription) {
    const diffMs = new Date(activeSubscription.ends_at) - new Date();
    remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  }

  // Billing history
  const [orders] = await pool.query(
    `SELECT o.id, o.order_number, o.created_at, o.paid_at, o.status, o.total_paise,
            o.list_price_paise, o.discount_paise, o.is_introductory, o.coupon_code,
            p.name AS plan_name, i.invoice_number, i.pdf_filename
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     LEFT JOIN subscription_invoices i ON i.order_id = o.id
     WHERE o.user_id = ?
     ORDER BY o.created_at DESC`,
    [userId]
  );

  const isIntroductoryEligible = await isEligibleForIntroductoryOffer(userId);

  res.json({
    success: true,
    activeSubscription,
    remainingDays,
    isIntroductoryEligible,
    billingHistory: orders,
  });
});

/**
 * GET /api/subscriptions/orders/:id/invoice
 * Streams the private invoice PDF securely to the authorized owner or superadmin
 */
const downloadInvoice = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const isSuperadmin = req.user.role === "superadmin";

  const [orders] = await pool.query(
    `SELECT * FROM subscription_orders WHERE id = ? ${isSuperadmin ? "" : "AND user_id = ?"}`,
    isSuperadmin ? [orderId] : [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status !== "paid") {
    throw new ApiError(400, "Invoice is only available for paid orders.");
  }

  let [invoices] = await pool.query(
    "SELECT * FROM subscription_invoices WHERE order_id = ?",
    [order.id]
  );

  let invoice = invoices[0];
  if (!invoice) {
    invoice = await issueInvoice(order.id);
  }

  const filePath = invoiceFilePath(invoice.pdf_filename);
  if (!fs.existsSync(filePath)) {
    await issueInvoice(order.id);
  }

  if (!fs.existsSync(filePath)) {
    throw new ApiError(500, "Invoice file could not be generated.");
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.pdf_filename}"`);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  fs.createReadStream(filePath).pipe(res);
});

/**
 * POST /api/subscriptions/orders/:id/invoice/resend
 * Resends the invoice to the customer's email address
 */
const resendInvoice = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const isSuperadmin = req.user.role === "superadmin";

  const [orders] = await pool.query(
    `SELECT o.*, p.name AS plan_name, u.email AS user_email
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     JOIN users u ON o.user_id = u.id
     WHERE o.id = ? ${isSuperadmin ? "" : "AND o.user_id = ?"}`,
    isSuperadmin ? [orderId] : [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status !== "paid") {
    throw new ApiError(400, "Invoice can only be resent for paid orders.");
  }

  let [invoices] = await pool.query(
    "SELECT * FROM subscription_invoices WHERE order_id = ?",
    [order.id]
  );
  let invoice = invoices[0] || (await issueInvoice(order.id));

  const filePath = invoiceFilePath(invoice.pdf_filename);
  const result = await sendInvoiceEmail(order.user_email, invoice.invoice_number, order.plan_name, filePath);

  if (!result.sent) {
    throw new ApiError(502, `Failed to send email: ${result.error}`);
  }

  await pool.query("UPDATE subscription_invoices SET emailed_at = NOW() WHERE id = ?", [invoice.id]);

  res.json({
    success: true,
    message: `Invoice ${invoice.invoice_number} sent to ${order.user_email}.`,
  });
});

module.exports = {
  listPlans,
  previewPrice,
  createOrder,
  verifyOrderPayment,
  getOrder,
  getMySubscription,
  downloadInvoice,
  resendInvoice,
};

