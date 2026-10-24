const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const emailService = require("../services/emailService");

/**
 * Superadmin SaaS Business Owner Dashboard Controller
 * Aggregates high-level business intelligence, subscriber metrics, online presence,
 * email queue operations, and revenue analytics for the SaaS platform owner.
 */

// Online timeout threshold: 15 minutes
const ONLINE_WINDOW_MINUTES = 15;

/**
 * GET /api/superadmin/dashboard/stats
 * Overview KPI metrics for SaaS Business Owner Dashboard
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const { period = "all", from, to } = req.query;

  // 1. Total Registered Users (distinct accounts, excluding soft-deleted)
  const [totalUsersRows] = await pool.query(
    "SELECT COUNT(DISTINCT id) AS count FROM users WHERE role = 'user' AND deleted_at IS NULL"
  );
  const totalRegisteredUsers = Number(totalUsersRows[0]?.count || 0);

  // 2. Currently Online (Recently Active within 15 minutes)
  const [onlineRows] = await pool.query(
    `SELECT COUNT(DISTINCT id) AS count FROM users 
     WHERE role = 'user' AND deleted_at IS NULL 
       AND last_active_at >= NOW() - INTERVAL ? MINUTE`,
    [ONLINE_WINDOW_MINUTES]
  );
  const onlineUsers = Number(onlineRows[0]?.count || 0);

  // 3. Active Subscribed Users (distinct users with at least one active, unexpired subscription)
  const [activeUsersRows] = await pool.query(
    `SELECT COUNT(DISTINCT user_id) AS count FROM subscriptions 
     WHERE status = 'active' AND ends_at > NOW()`
  );
  const activeSubscribedUsers = Number(activeUsersRows[0]?.count || 0);

  // 4. Users without active subscription
  const unsubscribedUsers = Math.max(0, totalRegisteredUsers - activeSubscribedUsers);

  // 5. Active Paid Subscriptions (non-complimentary)
  const [activePaidRows] = await pool.query(
    `SELECT COUNT(*) AS count FROM subscriptions 
     WHERE status = 'active' AND ends_at > NOW() AND is_complimentary = 0`
  );
  const activePaidSubscriptions = Number(activePaidRows[0]?.count || 0);

  // 6. Complimentary / Trial / Free Subscriptions
  const [complimentaryRows] = await pool.query(
    `SELECT COUNT(*) AS count FROM subscriptions 
     WHERE status = 'active' AND ends_at > NOW() AND is_complimentary = 1`
  );
  const complimentarySubscriptions = Number(complimentaryRows[0]?.count || 0);

  // 7. Subscription Revenue for selected period
  let revDateSql = "";
  const revParams = [];
  if (from && to) {
    revDateSql = " AND paid_at >= ? AND paid_at <= ?";
    revParams.push(from, to);
  } else if (period === "today") {
    revDateSql = " AND DATE(paid_at) = CURDATE()";
  } else if (period === "this_week") {
    revDateSql = " AND YEARWEEK(paid_at, 1) = YEARWEEK(CURDATE(), 1)";
  } else if (period === "this_month") {
    revDateSql = " AND YEAR(paid_at) = YEAR(CURDATE()) AND MONTH(paid_at) = MONTH(CURDATE())";
  } else if (period === "this_year") {
    revDateSql = " AND YEAR(paid_at) = YEAR(CURDATE())";
  }

  const [revRows] = await pool.query(
    `SELECT 
       COALESCE(SUM(total_paise), 0) AS revenue_paise,
       COALESCE(SUM(tax_paise), 0) AS tax_paise,
       COALESCE(SUM(discount_paise), 0) AS discount_paise,
       COUNT(*) AS paid_count
     FROM subscription_orders
     WHERE status = 'paid' AND provider != 'manual' AND provider != 'mock' AND total_paise > 0 ${revDateSql}`,
    revParams
  );
  const subscriptionRevenuePaise = Number(revRows[0]?.revenue_paise || 0);
  const successfulPayments = Number(revRows[0]?.paid_count || 0);
  const taxCollectedPaise = Number(revRows[0]?.tax_paise || 0);
  const discountsGrantedPaise = Number(revRows[0]?.discount_paise || 0);

  // 8. Total successful payments all-time
  const [totalPaidOrdersRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM subscription_orders WHERE status = 'paid'"
  );
  const allTimeSuccessfulPayments = Number(totalPaidOrdersRows[0]?.count || 0);

  // 9. Failed or Pending Payments
  const [failedPendingRows] = await pool.query(
    `SELECT 
       SUM(CASE WHEN status IN ('failed', 'cancelled') THEN 1 ELSE 0 END) AS failed_count,
       SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) AS pending_count
     FROM subscription_orders`
  );
  const failedPayments = Number(failedPendingRows[0]?.failed_count || 0);
  const pendingPayments = Number(failedPendingRows[0]?.pending_count || 0);

  // 10. Upcoming Subscription Expirations (next 7 days)
  const [expiringRows] = await pool.query(
    `SELECT COUNT(*) AS count FROM subscriptions 
     WHERE status = 'active' AND ends_at > NOW() AND ends_at <= NOW() + INTERVAL 7 DAY`
  );
  const upcomingExpirations = Number(expiringRows[0]?.count || 0);

  // 11. Active Coupons and Campaigns
  const [couponsRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM coupons WHERE is_active = 1 AND deleted_at IS NULL"
  );
  const [promosRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM promotions WHERE is_active = 1"
  );
  const activeCoupons = Number(couponsRows[0]?.count || 0);
  const activePromotions = Number(promosRows[0]?.count || 0);
  const activeCouponsAndCampaigns = activeCoupons + activePromotions;

  // 12. Email Outbox Status
  const [outboxRows] = await pool.query(
    `SELECT 
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
       SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count
     FROM email_outbox`
  );
  const failedEmailDeliveries = Number(outboxRows[0]?.failed_count || 0);
  const pendingEmailDeliveries = Number(outboxRows[0]?.pending_count || 0);
  const sentEmailDeliveries = Number(outboxRows[0]?.sent_count || 0);

  // 13. Recent 6 Subscription Orders
  const [recentOrders] = await pool.query(
    `SELECT o.id, o.user_id, o.order_number, o.total_paise, o.list_price_paise, o.discount_paise, o.tax_paise,
            o.status, o.created_at, o.paid_at,
            u.name AS user_name, u.email AS user_email, p.name AS plan_name,
            i.invoice_number
     FROM subscription_orders o
     JOIN users u ON o.user_id = u.id
     JOIN subscription_plans p ON o.plan_id = p.id
     LEFT JOIN subscription_invoices i ON i.order_id = o.id
     ORDER BY o.created_at DESC LIMIT 6`
  );

  res.json({
    success: true,
    metrics: {
      totalRegisteredUsers,
      onlineUsers,
      onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      activeSubscribedUsers,
      unsubscribedUsers,
      activePaidSubscriptions,
      complimentarySubscriptions,
      subscriptionRevenue: subscriptionRevenuePaise / 100,
      subscriptionRevenuePaise,
      successfulPayments,
      allTimeSuccessfulPayments,
      failedPayments,
      pendingPayments,
      upcomingExpirations,
      activeCouponsAndCampaigns,
      activeCoupons,
      activePromotions,
      failedEmailDeliveries,
      pendingEmailDeliveries,
      sentEmailDeliveries,
      taxCollected: taxCollectedPaise / 100,
      discountsGranted: discountsGrantedPaise / 100,
    },
    recentOrders,
  });
});

/**
 * GET /api/superadmin/dashboard/drilldown
 * Paginated, searchable drilldown dataset for any clicked KPI metric card
 */
const getDashboardDrilldown = asyncHandler(async (req, res) => {
  const {
    type = "total_users",
    search = "",
    page = 1,
    limit = 15,
    sortBy = "id",
    sortOrder = "DESC",
    period = "all",
    from = "",
    to = "",
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 15));
  const offset = (pageNum - 1) * limitNum;
  const cleanSearch = String(search || "").trim();

  let querySql = "";
  let countSql = "";
  let params = [];
  let countParams = [];

  switch (type) {
    case "online_users":
      countSql = `
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        WHERE u.role = 'user' AND u.deleted_at IS NULL
          AND u.last_active_at >= NOW() - INTERVAL ? MINUTE
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)" : ""}
      `;
      countParams = [ONLINE_WINDOW_MINUTES];
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.role, u.business_name, u.created_at, u.last_active_at,
               s.status AS subscription_status, p.name AS plan_name, s.ends_at,
               TIMESTAMPDIFF(MINUTE, u.last_active_at, NOW()) AS minutes_ago
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW()
        LEFT JOIN subscription_plans p ON s.plan_id = p.id
        WHERE u.role = 'user' AND u.deleted_at IS NULL
          AND u.last_active_at >= NOW() - INTERVAL ? MINUTE
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)" : ""}
        ORDER BY u.last_active_at DESC
        LIMIT ? OFFSET ?
      `;
      params = [ONLINE_WINDOW_MINUTES];
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "active_subscribers":
    case "subscribed_users":
    case "active_paid":
      const paidOnlySql = type === "active_paid" ? "AND s.is_complimentary = 0" : "";
      countSql = `
        SELECT COUNT(DISTINCT u.id) AS count
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        WHERE s.status = 'active' AND s.ends_at > NOW() ${paidOnlySql}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.business_name, u.created_at, u.last_active_at,
               s.id AS subscription_id, s.starts_at, s.ends_at, s.is_complimentary,
               p.name AS plan_name, p.duration_months,
               o.total_paise, o.order_number, i.invoice_number
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        JOIN subscription_plans p ON s.plan_id = p.id
        LEFT JOIN subscription_orders o ON s.order_id = o.id
        LEFT JOIN subscription_invoices i ON i.order_id = o.id
        WHERE s.status = 'active' AND s.ends_at > NOW() ${paidOnlySql}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
        ORDER BY s.ends_at ASC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "complimentary":
      countSql = `
        SELECT COUNT(DISTINCT u.id) AS count
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        WHERE s.status = 'active' AND s.ends_at > NOW() AND s.is_complimentary = 1
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.business_name, u.created_at, u.last_active_at,
               s.id AS subscription_id, s.starts_at, s.ends_at, s.is_complimentary,
               p.name AS plan_name, p.duration_months,
               o.total_paise, o.order_number, i.invoice_number
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        JOIN subscription_plans p ON s.plan_id = p.id
        LEFT JOIN subscription_orders o ON s.order_id = o.id
        LEFT JOIN subscription_invoices i ON i.order_id = o.id
        WHERE s.status = 'active' AND s.ends_at > NOW() AND s.is_complimentary = 1
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
        ORDER BY s.ends_at ASC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "revenue":
      let revDateSql = "";
      const revDateParams = [];
      if (from && to) {
        revDateSql = " AND o.paid_at >= ? AND o.paid_at <= ?";
        revDateParams.push(from, to);
      } else if (period === "today") {
        revDateSql = " AND DATE(o.paid_at) = CURDATE()";
      } else if (period === "this_week") {
        revDateSql = " AND YEARWEEK(o.paid_at, 1) = YEARWEEK(CURDATE(), 1)";
      } else if (period === "this_month") {
        revDateSql = " AND YEAR(o.paid_at) = YEAR(CURDATE()) AND MONTH(o.paid_at) = MONTH(CURDATE())";
      } else if (period === "this_year") {
        revDateSql = " AND YEAR(o.paid_at) = YEAR(CURDATE())";
      }

      countSql = `
        SELECT COUNT(*) AS count
        FROM subscription_orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.status = 'paid' AND o.total_paise > 0 ${revDateSql}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR o.order_number LIKE ? OR o.provider_payment_id LIKE ?)" : ""}
      `;
      countParams = [...revDateParams];
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT o.id, o.order_number, o.total_paise, o.list_price_paise, o.discount_paise, o.tax_paise,
               o.status, o.provider, o.provider_payment_id, o.provider_order_id, o.created_at, o.paid_at,
               u.id AS user_id, u.id, u.name AS user_name, u.name, u.email AS user_email, u.email, u.phone AS user_phone,
               p.name AS plan_name, i.invoice_number
        FROM subscription_orders o
        JOIN users u ON o.user_id = u.id
        JOIN subscription_plans p ON o.plan_id = p.id
        LEFT JOIN subscription_invoices i ON i.order_id = o.id
        WHERE o.status = 'paid' AND o.total_paise > 0 ${revDateSql}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR o.order_number LIKE ? OR o.provider_payment_id LIKE ?)" : ""}
        ORDER BY o.paid_at DESC
        LIMIT ? OFFSET ?
      `;
      params = [...revDateParams];
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "successful_payments":
    case "payments_successful":
    case "failed_pending":
    case "payments_failed":
      const statusFilter = (type === "successful_payments" || type === "payments_successful")
        ? "o.status = 'paid'"
        : "o.status IN ('failed', 'cancelled', 'created', 'pending')";
      countSql = `
        SELECT COUNT(*) AS count
        FROM subscription_orders o
        JOIN users u ON o.user_id = u.id
        WHERE ${statusFilter}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR o.order_number LIKE ? OR o.provider_payment_id LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT o.id, o.order_number, o.total_paise, o.list_price_paise, o.discount_paise, o.tax_paise,
               o.status, o.provider, o.provider_payment_id, o.provider_order_id, o.created_at, o.paid_at,
               u.id AS user_id, u.id, u.name AS user_name, u.name, u.email AS user_email, u.email, u.phone AS user_phone,
               p.name AS plan_name, i.invoice_number
        FROM subscription_orders o
        JOIN users u ON o.user_id = u.id
        JOIN subscription_plans p ON o.plan_id = p.id
        LEFT JOIN subscription_invoices i ON i.order_id = o.id
        WHERE ${statusFilter}
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR o.order_number LIKE ? OR o.provider_payment_id LIKE ?)" : ""}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "upcoming_expirations":
    case "expiring_soon":
      countSql = `
        SELECT COUNT(*) AS count
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        WHERE s.status = 'active' AND s.ends_at > NOW() AND s.ends_at <= NOW() + INTERVAL 7 DAY
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.business_name, u.last_active_at,
               s.id AS subscription_id, s.starts_at, s.ends_at,
               p.name AS plan_name, DATEDIFF(s.ends_at, NOW()) AS days_left, DATEDIFF(s.ends_at, NOW()) AS days_remaining
        FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        JOIN subscription_plans p ON s.plan_id = p.id
        WHERE s.status = 'active' AND s.ends_at > NOW() AND s.ends_at <= NOW() + INTERVAL 7 DAY
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)" : ""}
        ORDER BY s.ends_at ASC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "campaigns_coupons":
      countSql = `
        SELECT (
          (SELECT COUNT(*) FROM coupons c WHERE c.deleted_at IS NULL ${cleanSearch ? "AND (c.code LIKE ? OR c.name LIKE ?)" : ""}) +
          (SELECT COUNT(*) FROM promotions pr WHERE pr.deleted_at IS NULL ${cleanSearch ? "AND (pr.code LIKE ? OR pr.name LIKE ?)" : ""})
        ) AS count
      `;
      if (cleanSearch) {
        countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      }

      querySql = `
        SELECT c.id, c.code, c.name, c.discount_type, c.discount_value, c.max_redemptions, c.redemptions_count,
               c.valid_until, c.is_active, 'coupon' AS campaign_type
        FROM coupons c
        WHERE c.deleted_at IS NULL
          ${cleanSearch ? "AND (c.code LIKE ? OR c.name LIKE ?)" : ""}
        UNION ALL
        SELECT pr.id, pr.code, pr.name, pr.discount_type, pr.discount_value, pr.max_redemptions, pr.redemptions_count,
               pr.ends_at AS valid_until, pr.is_active, 'promotion' AS campaign_type
        FROM promotions pr
        WHERE pr.deleted_at IS NULL
          ${cleanSearch ? "AND (pr.code LIKE ? OR pr.name LIKE ?)" : ""}
        ORDER BY is_active DESC, valid_until DESC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) {
        params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      }
      params.push(limitNum, offset);
      break;

    case "email_outbox":
      countSql = `
        SELECT COUNT(*) AS count FROM email_outbox
        WHERE 1=1 ${cleanSearch ? "AND (recipient_email LIKE ? OR subject LIKE ? OR reference_id LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT id, recipient_email, subject, category, reference_type, reference_id,
               status, attempts, max_attempts, last_error, next_retry_at, sent_at, created_at
        FROM email_outbox
        WHERE 1=1 ${cleanSearch ? "AND (recipient_email LIKE ? OR subject LIKE ? OR reference_id LIKE ?)" : ""}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "unsubscribed_users":
      countSql = `
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW()
        WHERE u.role = 'user' AND u.deleted_at IS NULL AND s.id IS NULL
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.business_name, u.created_at, u.last_active_at,
               u.has_used_intro_offer,
               (SELECT COUNT(*) FROM subscription_orders WHERE user_id = u.id AND status = 'paid') AS previous_purchases_count
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.ends_at > NOW()
        WHERE u.role = 'user' AND u.deleted_at IS NULL AND s.id IS NULL
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;

    case "total_users":
    default:
      countSql = `
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        WHERE u.role = 'user' AND u.deleted_at IS NULL
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
      `;
      if (cleanSearch) countParams.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);

      querySql = `
        SELECT u.id, u.id AS user_id, u.name, u.name AS user_name, u.email, u.email AS user_email, u.phone, u.role, u.business_name, u.business_type, u.gstin,
               u.created_at, u.last_active_at, u.status, u.has_used_intro_offer,
               s.status AS subscription_status, s.starts_at AS sub_starts_at, s.ends_at AS sub_ends_at,
               p.name AS plan_name
        FROM users u
        LEFT JOIN (
          SELECT s1.* FROM subscriptions s1
          JOIN (
            SELECT user_id, MAX(ends_at) as max_end FROM subscriptions GROUP BY user_id
          ) s2 ON s1.user_id = s2.user_id AND s1.ends_at = s2.max_end
        ) s ON s.user_id = u.id
        LEFT JOIN subscription_plans p ON s.plan_id = p.id
        WHERE u.role = 'user' AND u.deleted_at IS NULL
          ${cleanSearch ? "AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.business_name LIKE ?)" : ""}
        ORDER BY u.id DESC
        LIMIT ? OFFSET ?
      `;
      if (cleanSearch) params.push(`%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`, `%${cleanSearch}%`);
      params.push(limitNum, offset);
      break;
  }

  const [countRows] = await pool.query(countSql, countParams);
  const totalCount = Number(countRows[0]?.count || 0);
  const totalPages = Math.ceil(totalCount / limitNum);

  const [rows] = await pool.query(querySql, params);

  res.json({
    success: true,
    type,
    pagination: {
      totalCount,
      total_items: totalCount,
      totalPages,
      total_pages: totalPages,
      currentPage: pageNum,
      page: pageNum,
      limit: limitNum,
    },
    rows,
  });
});

/**
 * GET /api/superadmin/dashboard/user-detail/:id
 * Dedicated SaaS administration modal/drawer view for any selected user
 */
const getUserDetail = asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);

  // User profile
  const [users] = await pool.query(
    `SELECT id, name, email, phone, business_name, business_type, gstin, pan,
            address, city, state, pincode, role, status, created_at, last_active_at, last_login_at,
            has_used_intro_offer
     FROM users WHERE id = ?`,
    [userId]
  );
  if (!users.length) throw new ApiError(404, "User not found.");
  const user = users[0];

  // Subscription history
  const [subscriptions] = await pool.query(
    `SELECT s.*, p.name AS plan_name, p.code AS plan_code, p.duration_months,
            o.order_number, o.total_paise
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     LEFT JOIN subscription_orders o ON s.order_id = o.id
     WHERE s.user_id = ?
     ORDER BY s.ends_at DESC`,
    [userId]
  );

  // Subscription orders & invoices
  const [orders] = await pool.query(
    `SELECT o.*, p.name AS plan_name, i.invoice_number, i.pdf_filename, i.email_status, i.emailed_at
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     LEFT JOIN subscription_invoices i ON i.order_id = o.id
     WHERE o.user_id = ?
     ORDER BY o.created_at DESC`,
    [userId]
  );

  // Coupon usage
  const [couponRedemptions] = await pool.query(
    `SELECT cr.*, c.code, c.name AS coupon_name, c.discount_type, c.discount_value, o.order_number
     FROM coupon_redemptions cr
     JOIN coupons c ON cr.coupon_id = c.id
     LEFT JOIN subscription_orders o ON cr.order_id = o.id
     WHERE cr.user_id = ?
     ORDER BY cr.created_at DESC`,
    [userId]
  );

  // Email delivery logs for this user
  const [emailLogs] = await pool.query(
    `SELECT id, subject, category, status, attempts, last_error, sent_at, created_at
     FROM email_outbox
     WHERE recipient_email = ?
     ORDER BY created_at DESC LIMIT 10`,
    [user.email]
  );

  res.json({
    success: true,
    user,
    subscriptions,
    orders,
    couponRedemptions,
    emailLogs,
  });
});

/**
 * POST /api/superadmin/dashboard/email-retry/:id
 * Retries a failed email in the outbox
 */
const retryEmail = asyncHandler(async (req, res) => {
  const outboxId = Number(req.params.id);
  const result = await emailService.retryItem(outboxId);

  res.json({
    success: result.delivered,
    message: result.delivered ? "Email sent successfully." : `Email retry failed: ${result.error}`,
  });
});

/**
 * GET /api/superadmin/dashboard/campaign-analytics
 * Performance metrics for campaigns and coupons (gross value, discounts, collected revenue)
 */
const getCampaignAnalytics = asyncHandler(async (req, res) => {
  // Coupons analytics
  const [couponStats] = await pool.query(
    `SELECT 
       c.id, c.code, c.name, c.discount_type, c.discount_value, c.max_discount_paise,
       c.max_redemptions, c.redemptions_count, c.valid_from, c.valid_until, c.is_active,
       COUNT(DISTINCT o.id) AS total_orders,
       SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.list_price_paise ELSE 0 END), 0) AS gross_order_paise,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.coupon_discount_paise ELSE 0 END), 0) AS discount_granted_paise,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_paise ELSE 0 END), 0) AS net_revenue_paise,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.tax_paise ELSE 0 END), 0) AS tax_paise
     FROM coupons c
     LEFT JOIN subscription_orders o ON o.coupon_id = c.id
     WHERE c.deleted_at IS NULL
     GROUP BY c.id
     ORDER BY c.created_at DESC`
  );

  // Promotions analytics
  const [promoStats] = await pool.query(
    `SELECT 
       p.id, p.name, p.code, p.discount_type, p.discount_value, p.max_discount_paise,
       p.plan_code, p.starts_at, p.ends_at, p.is_active, p.redemptions_count,
       COUNT(DISTINCT o.id) AS total_orders,
       SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_paise ELSE 0 END), 0) AS net_revenue_paise,
       COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.discount_paise ELSE 0 END), 0) AS discount_granted_paise
     FROM promotions p
     LEFT JOIN subscription_orders o ON o.promotion_id = p.id
     GROUP BY p.id
     ORDER BY p.created_at DESC`
  );

  res.json({
    success: true,
    coupons: couponStats.map((c) => ({
      ...c,
      grossOrderValue: Number(c.gross_order_paise) / 100,
      discountsGranted: Number(c.discount_granted_paise) / 100,
      netRevenue: Number(c.net_revenue_paise) / 100,
      taxCollected: Number(c.tax_paise) / 100,
    })),
    promotions: promoStats.map((p) => ({
      ...p,
      netRevenue: Number(p.net_revenue_paise) / 100,
      discountsGranted: Number(p.discount_granted_paise) / 100,
    })),
  });
});

module.exports = {
  getDashboardStats,
  getDashboardDrilldown,
  getUserDetail,
  retryEmail,
  getCampaignAnalytics,
};
