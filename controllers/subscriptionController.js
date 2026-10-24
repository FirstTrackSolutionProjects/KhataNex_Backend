const fs = require("fs");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const gateway = require("../utils/paymentGateway");
const {
  TAX_PERCENT,
  getSubscriptionSettings,
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
 * Returns active plans, regular & intro pricing, summary, description, and current user eligibility
 */
const listPlans = asyncHandler(async (req, res) => {
  const settings = await getSubscriptionSettings();
  const [plans] = await pool.query(
    "SELECT id, code, name, duration_months, billing_interval, price_paise, introductory_price_paise, description, summary, features, promotional_badge, display_order, is_highlighted, is_active FROM subscription_plans WHERE is_active = 1 ORDER BY display_order ASC, duration_months ASC"
  );

  let isIntroductoryEligible = false;
  if (req.user && settings.intro_offers_enabled) {
    isIntroductoryEligible = await isEligibleForIntroductoryOffer(req.user.id);
  }

  const enrichedPlans = plans.map((plan) => {
    let parsedFeatures = [];
    if (Array.isArray(plan.features)) {
      parsedFeatures = plan.features;
    } else if (typeof plan.features === "string") {
      try {
        parsedFeatures = JSON.parse(plan.features);
      } catch (_) {
        parsedFeatures = [];
      }
    }

    const effectivePricePaise = isIntroductoryEligible ? plan.introductory_price_paise : plan.price_paise;
    const savingsPaise = Math.max(0, plan.price_paise - effectivePricePaise);
    return {
      ...plan,
      features: parsedFeatures,
      is_eligible_for_introductory: isIntroductoryEligible,
      effective_price_paise: effectivePricePaise,
      savings_paise: savingsPaise,
    };
  });

  res.json({
    success: true,
    isIntroductoryEligible,
    taxPercent: settings.tax_percent,
    taxInclusive: settings.tax_inclusive,
    plans: enrichedPlans,
  });
});

/**
 * POST /api/subscriptions/price
 * Computes server-authoritative price breakdown with intro, promo & coupon logic.
 * Gracefully handles invalid/inactive coupons so checkout breakdown is preserved.
 */
const previewPrice = asyncHandler(async (req, res) => {
  const { plan_code, coupon_code, promo_code } = req.body;
  if (!plan_code) throw new ApiError(400, "plan_code is required.");

  const [plans] = await pool.query(
    "SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1",
    [String(plan_code).trim()]
  );
  if (!plans.length) throw new ApiError(404, "Subscription plan not found or inactive.");
  const plan = plans[0];

  const isEligible = await isEligibleForIntroductoryOffer(req.user.id);

  let pricing;
  let couponError = null;
  let couponApplied = false;

  if (coupon_code) {
    try {
      pricing = await priceOrder({
        plan,
        isIntroductoryEligible: isEligible,
        couponCode: coupon_code,
        promoCode: promo_code,
        userId: req.user.id,
      });
      couponApplied = Boolean(pricing.couponId);
    } catch (err) {
      couponError = err.message || "Invalid or inactive coupon.";
      // Compute base pricing without coupon
      pricing = await priceOrder({
        plan,
        isIntroductoryEligible: isEligible,
        couponCode: null,
        promoCode: promo_code,
        userId: req.user.id,
      });
    }
  } else {
    pricing = await priceOrder({
      plan,
      isIntroductoryEligible: isEligible,
      couponCode: null,
      promoCode: promo_code,
      userId: req.user.id,
    });
  }

  res.json({
    success: true,
    plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      duration_months: plan.duration_months,
      summary: plan.summary,
      description: plan.description,
    },
    pricing,
    couponApplied,
    couponError,
  });
});

/**
 * POST /api/subscriptions/orders
 * Creates a durable order, reserves coupon, and initializes provider checkout
 */
const createOrder = asyncHandler(async (req, res) => {
  const { plan_code, coupon_code, promo_code } = req.body;
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
    promoCode: promo_code,
    userId: req.user.id,
  });

  const orderNumber = `ORD-${Date.now()}-${req.user.id}`;

  const conn = await pool.getConnection();
  let orderId;
  try {
    await conn.beginTransaction();

    if (pricing.couponId) {
      const [lockedCoupons] = await conn.query(
        "SELECT * FROM coupons WHERE id = ? FOR UPDATE",
        [pricing.couponId]
      );
      const lockedCoupon = lockedCoupons[0];
      if (!lockedCoupon || !lockedCoupon.is_active || lockedCoupon.deleted_at) {
        throw new ApiError(400, "Coupon is no longer available.");
      }

      if (lockedCoupon.max_redemptions !== null && lockedCoupon.max_redemptions !== undefined) {
        const [counts] = await conn.query(
          `SELECT COUNT(*) as active_count FROM coupon_redemptions
           WHERE coupon_id = ? AND (status = 'redeemed' OR (status = 'reserved' AND created_at >= NOW() - INTERVAL 30 MINUTE))`,
          [lockedCoupon.id]
        );
        if ((counts[0]?.active_count || 0) >= lockedCoupon.max_redemptions) {
          throw new ApiError(400, `Coupon "${lockedCoupon.code}" redemption limit has been reached.`);
        }
      }

      if (lockedCoupon.per_user_limit) {
        const [userCounts] = await conn.query(
          `SELECT COUNT(*) as user_count FROM coupon_redemptions
           WHERE coupon_id = ? AND user_id = ? AND (status = 'redeemed' OR (status = 'reserved' AND created_at >= NOW() - INTERVAL 30 MINUTE))`,
          [lockedCoupon.id, req.user.id]
        );
        if ((userCounts[0]?.user_count || 0) >= lockedCoupon.per_user_limit) {
          throw new ApiError(400, `You have already redeemed coupon "${lockedCoupon.code}".`);
        }
      }
    }

    const [ins] = await conn.query(
      `INSERT INTO subscription_orders 
         (order_number, user_id, plan_id, is_introductory, list_price_paise, introductory_discount_paise,
          promotion_id, coupon_id, coupon_code, coupon_discount_paise, discount_paise, taxable_paise, tax_percent,
          tax_paise, total_paise, currency, status, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'created', 'razorpay')`,
      [
        orderNumber,
        req.user.id,
        plan.id,
        pricing.isIntroductory ? 1 : 0,
        pricing.listPricePaise,
        pricing.introductoryDiscountPaise,
        pricing.promotionId,
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

    orderId = ins.insertId;

    if (pricing.couponId) {
      await conn.query(
        `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, status)
         VALUES (?, ?, ?, 'reserved')`,
        [pricing.couponId, req.user.id, orderId]
      );
    }

    await conn.commit();
  } catch (txErr) {
    await conn.rollback();
    throw txErr;
  } finally {
    conn.release();
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
  const providerPaymentId = req.body.provider_payment_id || req.body.razorpay_payment_id;
  const providerSignature = req.body.provider_signature || req.body.razorpay_signature;
  const providerOrderId = req.body.provider_order_id || req.body.razorpay_order_id;

  if (!providerPaymentId || !providerSignature) {
    throw new ApiError(400, "Payment verification requires payment ID and signature.");
  }

  const [orders] = await pool.query(
    "SELECT * FROM subscription_orders WHERE id = ? AND user_id = ?",
    [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status === "paid") {
    return res.json({ success: true, status: "paid", message: "Order is already fulfilled." });
  }

  if (order.status === "cancelled" || order.status === "failed") {
    throw new ApiError(400, `Cannot verify payment for an order with status '${order.status}'. Please initiate a new checkout.`);
  }

  if (providerOrderId && order.provider_order_id && providerOrderId !== order.provider_order_id) {
    throw new ApiError(400, "Order ID mismatch: Payment does not match this subscription order.");
  }

  const isValid = gateway.verifyPayment({
    providerOrderId: order.provider_order_id,
    providerPaymentId,
    signature: providerSignature,
  });

  if (!isValid) {
    throw new ApiError(400, "Payment verification signature failed.");
  }

  await fulfillOrder(order.id, providerPaymentId, providerSignature);

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
     WHERE s.user_id = ? AND s.status = 'active' AND s.ends_at > NOW()
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
  const settings = await getSubscriptionSettings();

  res.json({
    success: true,
    activeSubscription,
    remainingDays,
    isIntroductoryEligible,
    enforcement: settings.subscription_enforcement,
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

/**
 * POST /api/subscriptions/orders/:id/cancel
 * Cancels a pending order and releases any reserved coupon.
 * Does not consume introductory eligibility.
 */
const cancelOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const [orders] = await pool.query(
    "SELECT * FROM subscription_orders WHERE id = ? AND user_id = ?",
    [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status === "paid") {
    throw new ApiError(400, "Paid orders cannot be cancelled.");
  }

  await pool.query("UPDATE subscription_orders SET status = 'cancelled' WHERE id = ?", [orderId]);
  if (order.coupon_id) {
    await pool.query(
      "UPDATE coupon_redemptions SET status = 'released' WHERE order_id = ?",
      [orderId]
    );
  }

  res.json({
    success: true,
    message: "Order cancelled successfully. Introductory offer remains intact.",
  });
});

/**
 * POST /api/subscriptions/orders/:id/fail
 * Marks order as failed and releases any reserved coupon.
 * Does not consume introductory eligibility.
 */
const failOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const { reason = "Payment failed" } = req.body;
  const [orders] = await pool.query(
    "SELECT * FROM subscription_orders WHERE id = ? AND user_id = ?",
    [orderId, req.user.id]
  );
  if (!orders.length) throw new ApiError(404, "Order not found.");
  const order = orders[0];

  if (order.status === "paid") {
    throw new ApiError(400, "Paid orders cannot be marked as failed.");
  }

  await pool.query("UPDATE subscription_orders SET status = 'failed', notes = ? WHERE id = ?", [reason, orderId]);
  if (order.coupon_id) {
    await pool.query(
      "UPDATE coupon_redemptions SET status = 'released' WHERE order_id = ?",
      [orderId]
    );
  }

  res.json({
    success: true,
    message: "Order marked as failed. You can retry anytime.",
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
  cancelOrder,
  failOrder,
};

