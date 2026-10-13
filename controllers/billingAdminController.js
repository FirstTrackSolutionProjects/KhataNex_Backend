const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { normalizeCode, fulfillOrder } = require("../utils/subscriptionLogic");

/**
 * GET /api/superadmin/billing/overview
 * Returns real database-backed KPIs for the Superadmin Billing Dashboard
 */
const getBillingOverview = asyncHandler(async (req, res) => {
  // 1. User access status based on latest subscription ends_at
  const [userSubs] = await pool.query(
    `SELECT user_id, MAX(ends_at) AS latest_end, COUNT(*) AS term_count
     FROM subscriptions
     GROUP BY user_id`
  );

  const now = new Date();
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  let activeCount = 0;
  let expiring7dCount = 0;
  let expiringMonthCount = 0;
  let expiredCount = 0;
  let renewedCount = 0;

  userSubs.forEach((sub) => {
    const endDate = new Date(sub.latest_end);
    if (endDate > now) {
      activeCount++;
      if (endDate <= sevenDaysFromNow) {
        expiring7dCount++;
      }
      if (endDate.getFullYear() === currentYear && endDate.getMonth() === currentMonth) {
        expiringMonthCount++;
      }
    } else {
      expiredCount++;
    }

    if (sub.term_count > 1) {
      renewedCount++;
    }
  });

  // 2. Collected revenue from paid orders (excluding zero-value and manual complimentary grants)
  const [revRows] = await pool.query(
    `SELECT COALESCE(SUM(total_paise), 0) AS total_revenue_paise, COUNT(*) AS paid_order_count
     FROM subscription_orders
     WHERE status = 'paid' AND provider != 'manual' AND total_paise > 0`
  );
  const collectedRevenuePaise = Number(revRows[0]?.total_revenue_paise || 0);

  // 3. Expected renewal revenue: Active users expiring within next 30 days multiplied by regular plan price
  const [renewalForecast] = await pool.query(
    `SELECT COALESCE(SUM(p.price_paise), 0) AS forecast_paise
     FROM subscriptions s
     JOIN (
       SELECT user_id, MAX(ends_at) AS max_end
       FROM subscriptions
       WHERE is_complimentary = 0
       GROUP BY user_id
     ) latest ON s.user_id = latest.user_id AND s.ends_at = latest.max_end
     JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.ends_at > NOW() AND s.ends_at <= NOW() + INTERVAL 30 DAY`
  );
  const expectedRenewalRevenuePaise = Number(renewalForecast[0]?.forecast_paise || 0);

  res.json({
    success: true,
    metrics: {
      activeSubscriptions: activeCount,
      expiringWithin7Days: expiring7dCount,
      expiringThisMonth: expiringMonthCount,
      expiredSubscriptions: expiredCount,
      renewedSubscriptions: renewedCount,
      collectedRevenuePaise,
      expectedRenewalRevenuePaise,
    },
  });
});

/**
 * GET /api/superadmin/billing/expiry-cohorts
 * Monthly expiry distribution and user cohort lists
 */
const getExpiryCohorts = asyncHandler(async (req, res) => {
  const selectedMonth = req.query.month; // e.g. "2026-10"

  // Aggregate monthly counts
  const [monthlyCounts] = await pool.query(
    `SELECT 
       DATE_FORMAT(s.latest_end, '%Y-%m') AS month,
       COUNT(*) AS user_count
     FROM (
       SELECT user_id, MAX(ends_at) AS latest_end
       FROM subscriptions
       GROUP BY user_id
     ) s
     WHERE s.latest_end >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
     GROUP BY DATE_FORMAT(s.latest_end, '%Y-%m')
     ORDER BY month ASC`
  );

  let cohortUsers = [];
  if (selectedMonth) {
    const [users] = await pool.query(
      `SELECT 
         u.id AS user_id,
         u.name AS user_name,
         u.email AS user_email,
         u.phone AS user_phone,
         u.business_name,
         p.name AS plan_name,
         p.code AS plan_code,
         s.ends_at,
         s.is_complimentary,
         IF(s.ends_at > NOW(), 'active', 'expired') AS subscription_status
       FROM (
         SELECT s1.user_id, s1.plan_id, s1.ends_at, s1.is_complimentary
         FROM subscriptions s1
         JOIN (
           SELECT user_id, MAX(ends_at) AS max_end
           FROM subscriptions
           GROUP BY user_id
         ) s2 ON s1.user_id = s2.user_id AND s1.ends_at = s2.max_end
       ) s
       JOIN users u ON s.user_id = u.id
       JOIN subscription_plans p ON s.plan_id = p.id
       WHERE DATE_FORMAT(s.ends_at, '%Y-%m') = ?
       ORDER BY s.ends_at ASC`,
      [selectedMonth]
    );
    cohortUsers = users;
  }

  res.json({
    success: true,
    cohorts: monthlyCounts,
    selectedMonth: selectedMonth || null,
    users: cohortUsers,
  });
});

/**
 * Plans Management
 */
const listAdminPlans = asyncHandler(async (req, res) => {
  const [plans] = await pool.query("SELECT * FROM subscription_plans ORDER BY duration_months ASC");
  res.json({ success: true, plans });
});

const createPlan = asyncHandler(async (req, res) => {
  const { code, name, duration_months, price_paise, introductory_price_paise, is_active } = req.body;
  const cleanCode = normalizeCode(code).toLowerCase();

  if (!cleanCode || !name || !duration_months || price_paise === undefined) {
    throw new ApiError(400, "code, name, duration_months, and price_paise are required.");
  }

  const [resInsert] = await pool.query(
    `INSERT INTO subscription_plans 
       (code, name, duration_months, price_paise, introductory_price_paise, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      cleanCode,
      name,
      Number(duration_months),
      Number(price_paise),
      Number(introductory_price_paise || price_paise),
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
    ]
  );

  const [newPlan] = await pool.query("SELECT * FROM subscription_plans WHERE id = ?", [resInsert.insertId]);
  res.status(201).json({ success: true, plan: newPlan[0] });
});

const updatePlan = asyncHandler(async (req, res) => {
  const planId = Number(req.params.id);
  const { name, duration_months, price_paise, introductory_price_paise, is_active } = req.body;

  const [existing] = await pool.query("SELECT * FROM subscription_plans WHERE id = ?", [planId]);
  if (!existing.length) throw new ApiError(404, "Plan not found.");

  await pool.query(
    `UPDATE subscription_plans 
     SET name = COALESCE(?, name),
         duration_months = COALESCE(?, duration_months),
         price_paise = COALESCE(?, price_paise),
         introductory_price_paise = COALESCE(?, introductory_price_paise),
         is_active = COALESCE(?, is_active)
     WHERE id = ?`,
    [
      name,
      duration_months ? Number(duration_months) : null,
      price_paise !== undefined ? Number(price_paise) : null,
      introductory_price_paise !== undefined ? Number(introductory_price_paise) : null,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      planId,
    ]
  );

  const [updated] = await pool.query("SELECT * FROM subscription_plans WHERE id = ?", [planId]);
  res.json({ success: true, plan: updated[0] });
});

/**
 * Coupons Management
 */
const listAdminCoupons = asyncHandler(async (req, res) => {
  const [coupons] = await pool.query(
    `SELECT c.*, u.name AS creator_name
     FROM coupons c
     LEFT JOIN users u ON c.created_by = u.id
     ORDER BY c.created_at DESC`
  );
  res.json({ success: true, coupons });
});

const createCoupon = asyncHandler(async (req, res) => {
  const {
    code,
    discount_type,
    discount_value,
    max_discount_paise,
    min_order_paise,
    max_redemptions,
    per_user_limit,
    plan_code,
    valid_from,
    valid_until,
    is_active,
    target_cohort,
  } = req.body;

  const cleanCode = normalizeCode(code);
  if (!cleanCode) throw new ApiError(400, "Coupon code is required.");
  if (!["percent", "flat"].includes(discount_type)) {
    throw new ApiError(400, "discount_type must be 'percent' or 'flat'.");
  }
  if (!discount_value || Number(discount_value) <= 0) {
    throw new ApiError(400, "discount_value must be greater than 0.");
  }
  if (discount_type === "percent" && Number(discount_value) > 100) {
    throw new ApiError(400, "Percentage discount cannot exceed 100%.");
  }

  const [ins] = await pool.query(
    `INSERT INTO coupons 
       (code, discount_type, discount_value, max_discount_paise, min_order_paise,
        max_redemptions, per_user_limit, plan_code, valid_from, valid_until,
        is_active, target_cohort, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cleanCode,
      discount_type,
      Number(discount_value),
      max_discount_paise ? Number(max_discount_paise) : null,
      min_order_paise ? Number(min_order_paise) : 0,
      max_redemptions ? Number(max_redemptions) : null,
      per_user_limit ? Number(per_user_limit) : 1,
      plan_code ? String(plan_code).trim().toLowerCase() : null,
      valid_from ? new Date(valid_from) : null,
      valid_until ? new Date(valid_until) : null,
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
      target_cohort || null,
      req.user.id,
    ]
  );

  const [created] = await pool.query("SELECT * FROM coupons WHERE id = ?", [ins.insertId]);
  res.status(201).json({ success: true, coupon: created[0] });
});

const updateCoupon = asyncHandler(async (req, res) => {
  const couponId = Number(req.params.id);
  const {
    discount_type,
    discount_value,
    max_discount_paise,
    min_order_paise,
    max_redemptions,
    per_user_limit,
    plan_code,
    valid_from,
    valid_until,
    is_active,
    target_cohort,
  } = req.body;

  const [existing] = await pool.query("SELECT * FROM coupons WHERE id = ?", [couponId]);
  if (!existing.length) throw new ApiError(404, "Coupon not found.");

  await pool.query(
    `UPDATE coupons
     SET discount_type = COALESCE(?, discount_type),
         discount_value = COALESCE(?, discount_value),
         max_discount_paise = ?,
         min_order_paise = COALESCE(?, min_order_paise),
         max_redemptions = ?,
         per_user_limit = COALESCE(?, per_user_limit),
         plan_code = ?,
         valid_from = ?,
         valid_until = ?,
         is_active = COALESCE(?, is_active),
         target_cohort = ?
     WHERE id = ?`,
    [
      discount_type || null,
      discount_value ? Number(discount_value) : null,
      max_discount_paise !== undefined ? (max_discount_paise ? Number(max_discount_paise) : null) : existing[0].max_discount_paise,
      min_order_paise !== undefined ? Number(min_order_paise) : null,
      max_redemptions !== undefined ? (max_redemptions ? Number(max_redemptions) : null) : existing[0].max_redemptions,
      per_user_limit !== undefined ? Number(per_user_limit) : null,
      plan_code !== undefined ? (plan_code ? String(plan_code).trim().toLowerCase() : null) : existing[0].plan_code,
      valid_from !== undefined ? (valid_from ? new Date(valid_from) : null) : existing[0].valid_from,
      valid_until !== undefined ? (valid_until ? new Date(valid_until) : null) : existing[0].valid_until,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      target_cohort !== undefined ? target_cohort : existing[0].target_cohort,
      couponId,
    ]
  );

  const [updated] = await pool.query("SELECT * FROM coupons WHERE id = ?", [couponId]);
  res.json({ success: true, coupon: updated[0] });
});

/**
 * GET /api/superadmin/billing/orders
 * Orders listing with filters, pagination and search
 */
const listAdminOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const { status, search, from, to } = req.query;

  let query = `
    SELECT o.*, u.name AS user_name, u.email AS user_email, u.business_name,
           p.name AS plan_name, i.invoice_number, i.pdf_filename
    FROM subscription_orders o
    JOIN users u ON o.user_id = u.id
    JOIN subscription_plans p ON o.plan_id = p.id
    LEFT JOIN subscription_invoices i ON i.order_id = o.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += " AND o.status = ?";
    params.push(status);
  }
  if (from) {
    query += " AND o.created_at >= ?";
    params.push(new Date(from));
  }
  if (to) {
    query += " AND o.created_at <= ?";
    params.push(new Date(to));
  }
  if (search) {
    query += " AND (o.order_number LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.business_name LIKE ?)";
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  // Count total matching
  const countQuery = `SELECT COUNT(*) AS total FROM (${query}) AS filtered`;
  const [countRows] = await pool.query(countQuery, params);
  const total = countRows[0]?.total || 0;

  query += " ORDER BY o.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const [orders] = await pool.query(query, params);

  res.json({
    success: true,
    orders,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * GET /api/superadmin/billing/users/:id
 * Lookup a specific user's subscription and billing history
 */
const getUserBillingDetails = asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);

  const [users] = await pool.query(
    "SELECT id, name, email, phone, business_name, role, status, has_used_intro_offer, created_at FROM users WHERE id = ?",
    [userId]
  );
  if (!users.length) throw new ApiError(404, "User not found.");
  const user = users[0];

  const [subscriptions] = await pool.query(
    `SELECT s.*, p.name AS plan_name, p.code AS plan_code, o.order_number, o.total_paise
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     JOIN subscription_orders o ON s.order_id = o.id
     WHERE s.user_id = ?
     ORDER BY s.ends_at DESC`,
    [userId]
  );

  const [orders] = await pool.query(
    `SELECT o.*, p.name AS plan_name, i.invoice_number
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     LEFT JOIN subscription_invoices i ON i.order_id = o.id
     WHERE o.user_id = ?
     ORDER BY o.created_at DESC`,
    [userId]
  );

  res.json({
    success: true,
    user,
    subscriptions,
    orders,
  });
});

/**
 * POST /api/superadmin/billing/grant
 * Gives a user a complimentary term (no charge, no payment gateway).
 * Creates manual order and fulfills subscription with is_complimentary = 1.
 */
const grantSubscription = asyncHandler(async (req, res) => {
  const { user_id, plan_code, notes } = req.body;

  if (!user_id || !plan_code) {
    throw new ApiError(400, "user_id and plan_code are required.");
  }

  const [users] = await pool.query("SELECT id, name, email FROM users WHERE id = ?", [user_id]);
  if (!users.length) throw new ApiError(404, "User not found.");

  const [plans] = await pool.query(
    "SELECT * FROM subscription_plans WHERE code = ?",
    [String(plan_code).trim().toLowerCase()]
  );
  if (!plans.length) throw new ApiError(404, "Plan not found.");
  const plan = plans[0];

  const orderNumber = `GRANT-${Date.now()}-${user_id}`;

  const [ins] = await pool.query(
    `INSERT INTO subscription_orders 
       (order_number, user_id, plan_id, is_introductory, list_price_paise,
        discount_paise, taxable_paise, tax_percent, tax_paise, total_paise,
        currency, status, provider, notes)
     VALUES (?, ?, ?, 0, ?, ?, 0, 0, 0, 0, 'INR', 'created', 'manual', ?)`,
    [orderNumber, user_id, plan.id, plan.price_paise, plan.price_paise, notes || "Superadmin complimentary grant"]
  );

  const orderId = ins.insertId;

  // Fulfill without charging or generating paid invoice
  await fulfillOrder(orderId, null, null, { invoice: false });

  const [subs] = await pool.query(
    `SELECT s.*, p.name AS plan_name 
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.order_id = ?`,
    [orderId]
  );

  res.status(201).json({
    success: true,
    message: `Complimentary subscription granted for ${users[0].name}.`,
    subscription: subs[0],
  });
});

module.exports = {
  getBillingOverview,
  getExpiryCohorts,
  listAdminPlans,
  createPlan,
  updatePlan,
  listAdminCoupons,
  createCoupon,
  updateCoupon,
  listAdminOrders,
  getUserBillingDetails,
  grantSubscription,
};
