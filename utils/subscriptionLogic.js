const pool = require("../config/db");
const ApiError = require("./ApiError");

const TAX_PERCENT = Number(process.env.SUBSCRIPTION_TAX_PERCENT || 0);

const normalizeCode = (val) =>
  String(val || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");

// Settings cache (30 seconds TTL)
let cachedSettings = null;
let settingsCacheExpiry = 0;

async function getSubscriptionSettings() {
  const now = Date.now();
  if (cachedSettings && now < settingsCacheExpiry) {
    return cachedSettings;
  }

  try {
    const [rows] = await pool.query("SELECT * FROM subscription_settings WHERE id = 1");
    if (rows && rows.length > 0) {
      cachedSettings = {
        intro_offers_enabled: Boolean(rows[0].intro_offers_enabled),
        tax_percent: Number(rows[0].tax_percent || 0),
        tax_inclusive: Boolean(rows[0].tax_inclusive === 1 || rows[0].tax_inclusive === true),
        subscription_enforcement: String(rows[0].subscription_enforcement || "off").toLowerCase(),
        reminders_enabled: Boolean(rows[0].reminders_enabled),
        reminder_days: String(rows[0].reminder_days || "7,3,1"),
      };
      settingsCacheExpiry = now + 30000;
      return cachedSettings;
    }
  } catch (err) {
    // If settings table not yet created or DB error, fall back to environment defaults
  }

  cachedSettings = {
    intro_offers_enabled: true,
    tax_percent: TAX_PERCENT,
    tax_inclusive: true,
    subscription_enforcement: process.env.SUBSCRIPTION_ENFORCEMENT === "on" ? "on" : "off",
    reminders_enabled: true,
    reminder_days: "7,3,1",
  };
  settingsCacheExpiry = now + 10000;
  return cachedSettings;
}

function invalidateSettingsCache() {
  cachedSettings = null;
  settingsCacheExpiry = 0;
}

/**
 * Checks whether a user is eligible for the one-time introductory pricing.
 * Enforced strictly on backend:
 * 1. Checks global settings.intro_offers_enabled
 * 2. Checks users.has_used_intro_offer flag
 * 3. Checks if user has any successful order with is_introductory = 1
 * 4. Checks if user has any active/previous non-complimentary subscriptions
 */
async function isEligibleForIntroductoryOffer(userId) {
  if (!userId) return false;

  const settings = await getSubscriptionSettings();
  if (!settings.intro_offers_enabled) {
    return false;
  }

  const [users] = await pool.query(
    "SELECT has_used_intro_offer FROM users WHERE id = ?",
    [userId]
  );
  if (!users.length || users[0].has_used_intro_offer) {
    return false;
  }

  const [paidIntroOrders] = await pool.query(
    "SELECT id FROM subscription_orders WHERE user_id = ? AND status = 'paid' AND is_introductory = 1 LIMIT 1",
    [userId]
  );
  if (paidIntroOrders.length > 0) {
    return false;
  }

  const [paidSubs] = await pool.query(
    "SELECT id FROM subscriptions WHERE user_id = ? AND is_complimentary = 0 LIMIT 1",
    [userId]
  );
  if (paidSubs.length > 0) {
    return false;
  }

  return true;
}

/**
 * Evaluates coupon validity and calculates discount.
 * Concurrency-safe: takes into account recent reservations and redeemed count.
 */
async function evaluateCoupon(couponCode, plan, basePaise, userId) {
  const code = normalizeCode(couponCode);
  if (!code) throw new ApiError(400, "Coupon code is required.");

  const [coupons] = await pool.query(
    "SELECT * FROM coupons WHERE code = ? AND is_active = 1",
    [code]
  );
  if (!coupons.length) {
    throw new ApiError(400, `Coupon "${code}" is invalid or inactive.`);
  }

  const coupon = coupons[0];
  const now = new Date();

  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    throw new ApiError(400, `Coupon "${code}" is not yet active.`);
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    throw new ApiError(400, `Coupon "${code}" has expired.`);
  }
  if (coupon.plan_code && coupon.plan_code.toLowerCase() !== plan.code.toLowerCase()) {
    throw new ApiError(400, `Coupon "${code}" is not valid for plan ${plan.name}.`);
  }
  if (basePaise < coupon.min_order_paise) {
    const minRs = (coupon.min_order_paise / 100).toFixed(2);
    throw new ApiError(400, `Minimum purchase of Rs. ${minRs} required for coupon "${code}".`);
  }

  // Global redemptions check: redeemed + active reservations within 30 min
  if (coupon.max_redemptions !== null && coupon.max_redemptions !== undefined) {
    const [counts] = await pool.query(
      `SELECT COUNT(*) as active_count FROM coupon_redemptions
       WHERE coupon_id = ? AND (status = 'redeemed' OR (status = 'reserved' AND created_at >= NOW() - INTERVAL 30 MINUTE))`,
      [coupon.id]
    );
    if ((counts[0]?.active_count || 0) >= coupon.max_redemptions) {
      throw new ApiError(400, `Coupon "${code}" redemption limit has been reached.`);
    }
  }

  // Per-user redemptions check
  if (userId && coupon.per_user_limit) {
    const [userCounts] = await pool.query(
      `SELECT COUNT(*) as user_count FROM coupon_redemptions
       WHERE coupon_id = ? AND user_id = ? AND (status = 'redeemed' OR (status = 'reserved' AND created_at >= NOW() - INTERVAL 30 MINUTE))`,
      [coupon.id, userId]
    );
    if ((userCounts[0]?.user_count || 0) >= coupon.per_user_limit) {
      throw new ApiError(400, `You have already redeemed coupon "${code}".`);
    }
  }

  let discountPaise = 0;
  if (coupon.discount_type === "percent") {
    discountPaise = Math.floor((basePaise * coupon.discount_value) / 100);
    if (coupon.max_discount_paise) {
      discountPaise = Math.min(discountPaise, coupon.max_discount_paise);
    }
  } else if (coupon.discount_type === "flat") {
    discountPaise = Math.min(coupon.discount_value, basePaise);
  }

  return { valid: true, coupon, discountPaise };
}

/**
 * Calculates complete pricing breakdown for an order.
 * Ensures advertised amounts are final customer checkout totals (tax-inclusive).
 * Taxable value and included tax reconcile exactly: taxablePaise + taxPaise === totalPaise.
 */
async function priceOrder({ plan, isIntroductoryEligible, couponCode, userId }) {
  const settings = await getSubscriptionSettings();
  const taxPercent = Number(settings.tax_percent !== undefined ? settings.tax_percent : TAX_PERCENT);
  const taxInclusive = Boolean(settings.tax_inclusive !== undefined ? settings.tax_inclusive : 1);

  const listPricePaise = plan.price_paise;
  let isIntroductory = false;
  let basePaise = listPricePaise;
  let introductoryDiscountPaise = 0;

  if (isIntroductoryEligible && plan.introductory_price_paise > 0) {
    basePaise = plan.introductory_price_paise;
    introductoryDiscountPaise = Math.max(0, listPricePaise - plan.introductory_price_paise);
    isIntroductory = true;
  }

  let coupon = null;
  let couponDiscountPaise = 0;

  if (couponCode) {
    const evalResult = await evaluateCoupon(couponCode, plan, basePaise, userId);
    coupon = evalResult.coupon;
    couponDiscountPaise = evalResult.discountPaise;
  }

  const discountPaise = introductoryDiscountPaise + couponDiscountPaise;
  const effectiveCheckoutPaise = Math.max(0, basePaise - couponDiscountPaise);

  let taxablePaise = 0;
  let taxPaise = 0;
  let totalPaise = 0;

  if (taxInclusive) {
    // Final customer-facing checkout total equals effectiveCheckoutPaise
    totalPaise = effectiveCheckoutPaise;
    if (taxPercent > 0) {
      // Reverse calculate included GST: Taxable = Total / (1 + Rate/100)
      taxablePaise = Math.round(effectiveCheckoutPaise / (1 + taxPercent / 100));
      taxPaise = effectiveCheckoutPaise - taxablePaise;
    } else {
      taxablePaise = effectiveCheckoutPaise;
      taxPaise = 0;
    }
  } else {
    // Exclusive tax calculation
    taxablePaise = effectiveCheckoutPaise;
    taxPaise = Math.round((taxablePaise * taxPercent) / 100);
    totalPaise = taxablePaise + taxPaise;
  }

  return {
    listPricePaise,
    isIntroductory,
    introductoryDiscountPaise,
    couponId: coupon ? coupon.id : null,
    couponCode: coupon ? coupon.code : null,
    couponDiscountPaise,
    discountPaise,
    taxablePaise,
    taxPercent,
    taxInclusive,
    taxPaise,
    totalPaise,
  };
}

/**
 * Fulfills an order idempotently inside a database transaction:
 * - Locks order row
 * - Checks introductory offer concurrency
 * - Updates coupon redemption status to 'redeemed'
 * - Serializes user renewals
 * - Calculates calendar duration with early renewal preservation
 * - Inserts subscription row
 * - Marks order as paid
 * - Issues invoice asynchronously
 */
async function fulfillOrder(orderId, providerPaymentId, providerSignature = null, { invoice = true } = {}) {
  const conn = await pool.getConnection();
  let order;

  try {
    await conn.beginTransaction();

    const [orders] = await conn.query(
      "SELECT * FROM subscription_orders WHERE id = ? FOR UPDATE",
      [orderId]
    );
    order = orders[0];
    if (!order) throw new ApiError(404, "Order not found.");

    if (order.status === "paid") {
      await conn.rollback();
      return { alreadyPaid: true, order };
    }

    // Serialise per user to prevent concurrent race conditions
    const [userRows] = await conn.query(
      "SELECT id, has_used_intro_offer FROM users WHERE id = ? FOR UPDATE",
      [order.user_id]
    );
    const currentUser = userRows[0];

    // Concurrency defense: If this order claims an introductory price, verify user hasn't
    // already consumed the offer via a parallel fulfilled checkout
    if (order.is_introductory && currentUser?.has_used_intro_offer) {
      // Check if this user had another paid intro order
      const [otherPaid] = await conn.query(
        "SELECT id FROM subscription_orders WHERE user_id = ? AND status = 'paid' AND is_introductory = 1 AND id != ?",
        [order.user_id, order.id]
      );
      if (otherPaid.length > 0) {
        await conn.rollback();
        throw new ApiError(400, "Introductory offer has already been consumed by your account.");
      }
    }

    const [plans] = await conn.query(
      "SELECT duration_months FROM subscription_plans WHERE id = ?",
      [order.plan_id]
    );
    const durationMonths = plans[0]?.duration_months || 1;

    // Calendar arithmetic: if active subscription exists, start when that term ends; otherwise start NOW
    await conn.query(
      `INSERT INTO subscriptions (user_id, plan_id, order_id, starts_at, ends_at, status, is_complimentary)
       SELECT ?, ?, ?, s.start_at, DATE_ADD(s.start_at, INTERVAL ? MONTH), 'active', ?
       FROM (SELECT GREATEST(NOW(), COALESCE(MAX(ends_at), NOW())) AS start_at
             FROM subscriptions WHERE user_id = ?) s`,
      [order.user_id, order.plan_id, order.id, durationMonths, order.provider === "manual" ? 1 : 0, order.user_id]
    );

    // Update order status
    await conn.query(
      `UPDATE subscription_orders
       SET status = 'paid', provider_payment_id = ?, provider_signature = ?, paid_at = NOW()
       WHERE id = ?`,
      [providerPaymentId || null, providerSignature || null, order.id]
    );

    // If introductory offer used, mark user as having consumed the offer
    if (order.is_introductory) {
      await conn.query("UPDATE users SET has_used_intro_offer = 1 WHERE id = ?", [order.user_id]);
    }

    // Mark coupon redemption as completed & update redemptions_count
    if (order.coupon_id) {
      await conn.query(
        "UPDATE coupon_redemptions SET status = 'redeemed' WHERE order_id = ?",
        [order.id]
      );
      await conn.query(
        "UPDATE coupons SET redemptions_count = redemptions_count + 1 WHERE id = ?",
        [order.coupon_id]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Issue invoice asynchronously if required and not zero-priced complimentary
  if (invoice && order.total_paise > 0) {
    try {
      const { issueInvoice } = require("./subscriptionInvoice");
      await issueInvoice(order.id);
    } catch (err) {
      console.error(`[SubscriptionLogic] Invoice generation failed for order ${order.id}:`, err.message || err);
    }
  }

  return { alreadyPaid: false, order };
}

module.exports = {
  TAX_PERCENT,
  normalizeCode,
  getSubscriptionSettings,
  invalidateSettingsCache,
  isEligibleForIntroductoryOffer,
  evaluateCoupon,
  priceOrder,
  fulfillOrder,
};
