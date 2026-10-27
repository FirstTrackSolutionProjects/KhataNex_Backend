const bcrypt = require("bcrypt");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");
const { calculateReportMetrics, calculateGraphPoints, resolvePeriodRange, executeReportDrilldown } = require("./reportController");

const {
  ALL_ALLOWED_PERMISSIONS,
  normalizePermissions: normalizePermissionsHelper,
} = require("../utils/tenantContext");

const ALLOWED_EMPLOYEE_PERMISSIONS = ALL_ALLOWED_PERMISSIONS;

const normalizePermissions = (permissions) => {
  if (permissions === undefined || permissions === null) return null;
  return normalizePermissionsHelper(permissions);
};

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  secondary_phone: u.secondary_phone,
  business_name: u.business_name,
  address: u.address,
  business_type: u.business_type,
  gstin: u.gstin,
  pan: u.pan,
  website: u.website,
  address_line1: u.address_line1,
  address_line2: u.address_line2,
  city: u.city,
  state: u.state,
  pincode: u.pincode,
  country: u.country,
  employee_title: u.employee_title,
  employee_code: u.employee_code,
  joining_date: u.joining_date,
  emergency_contact: u.emergency_contact,
  notes: u.notes,
  assigned_modules: typeof u.assigned_modules === "string" ? JSON.parse(u.assigned_modules) : (u.assigned_modules || []),
  permissions: u.permissions,
  date_of_birth: u.date_of_birth,
  employee_age: u.employee_age,
  aadhaar_number: u.aadhaar_number,
  passport_number: u.passport_number,
  profile_photo_path: u.profile_photo_path,
  last_login_at: u.last_login_at,
  last_active_at: u.last_active_at,
  role: u.role,
  employee_role_type: u.employee_role_type,
  status: u.status,
  created_at: u.created_at,
});

/**
 * Ensures employees belonging to a specific business owner cannot access
 * or leak another tenant's profile or business data.
 */
const checkTenantAccess = async (reqUser, targetUserId) => {
  if (reqUser && reqUser.role === "employee" && reqUser.created_by_admin) {
    const [creatorRows] = await pool.query("SELECT id, role FROM users WHERE id = ?", [reqUser.created_by_admin]);
    if (creatorRows.length && creatorRows[0].role === "user" && Number(targetUserId) !== Number(reqUser.created_by_admin)) {
      throw new ApiError(403, "Access denied: you cannot access data from another business tenant.");
    }
  }
};

// GET /api/superadmin/users
// Full overview of every user account, including financial and activity
// summaries built from the existing transaction/document tables.
const listUsers = asyncHandler(async (req, res) => {
  let tenantFilter = "";
  const queryParams = [];

  // Tenant isolation: if employee belongs to a specific business owner, isolate strictly to that owner
  if (req.user && req.user.role === "employee" && req.user.created_by_admin) {
    const [creatorRows] = await pool.query("SELECT id, role FROM users WHERE id = ?", [req.user.created_by_admin]);
    if (creatorRows.length && creatorRows[0].role === "user") {
      tenantFilter = " AND u.id = ?";
      queryParams.push(req.user.created_by_admin);
    }
  }

  const tab = (req.query.tab || "active").toLowerCase();
  let tabCondition = "";
  if (tab === "deleted") {
    tabCondition = " AND (u.deleted_at IS NOT NULL OR u.status = 'deleted')";
  } else if (tab === "active") {
    tabCondition = " AND u.deleted_at IS NULL AND u.status != 'deleted'";
  }

  const [countRows] = await pool.query(
    `SELECT
       COUNT(CASE WHEN u.deleted_at IS NULL AND u.status != 'deleted' THEN 1 END) AS active_count,
       COUNT(CASE WHEN u.deleted_at IS NOT NULL OR u.status = 'deleted' THEN 1 END) AS deleted_count,
       COUNT(*) AS total_count
     FROM users u
     WHERE u.role = 'user'${tenantFilter}`,
    queryParams
  );

  const [rows] = await pool.query(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.phone,
       u.secondary_phone,
       u.business_name,
       u.business_type,
       u.gstin,
       u.pan,
       u.website,
       u.address,
       u.address_line1,
       u.address_line2,
       u.city,
       u.state,
       u.pincode,
       u.country,
       u.role,
       u.employee_role_type,
       u.employee_title,
       u.permissions,
       u.profile_photo_path,
       u.status,
       u.last_login_at,
       u.last_active_at,
       u.deleted_at,
       u.deleted_by,
       deleter.name AS deleted_by_name,
       u.deletion_reason,
       u.restored_at,
       u.restored_by,
       restorer.name AS restored_by_name,
       u.restoration_reason,
       CASE
         WHEN u.deleted_at IS NOT NULL OR u.status = 'deleted' THEN 1
         ELSE 0
       END AS is_deleted,
       CASE
         WHEN u.last_active_at IS NOT NULL
          AND u.last_active_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         THEN 'logged_in'
         ELSE 'logged_out'
       END AS activity_status,
       u.created_by_admin,
       u.created_at,
       u.updated_at,

       COALESCE((
         SELECT SUM(c.amount)
         FROM collections c
         WHERE c.created_by = u.id
           AND c.payment_type = 'due'
       ), 0) AS credit,

       COALESCE((
         SELECT SUM(p.amount)
         FROM payments p
         WHERE p.created_by = u.id
           AND p.payment_category = 'due_received'
       ), 0) AS used_credits,

       (
         COALESCE((
           SELECT SUM(c.amount)
           FROM collections c
           WHERE c.created_by = u.id
             AND c.payment_type = 'due'
         ), 0)
         -
         COALESCE((
           SELECT SUM(p.amount)
           FROM payments p
           WHERE p.created_by = u.id
             AND p.payment_category = 'due_received'
         ), 0)
       ) AS net_credit,

       COALESCE((
         SELECT SUM(p.amount)
           FROM payments p
           WHERE p.created_by = u.id
             AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill' OR p.purchase_bill_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1
               FROM payments p2
               WHERE p2.created_by = p.created_by
                 AND (p2.payment_category IN ('paid_by_business', 'purchase_bill') OR p2.purpose = 'Purchase Bill' OR p2.purchase_bill_id IS NOT NULL)
                 AND COALESCE(NULLIF(p2.purchase_bill_id, 0), p2.id) = COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
                 AND (
                   p2.amount > p.amount
                   OR (p2.amount = p.amount AND p2.id < p.id)
                 )
             )
       ), 0) AS debit,

       (
         COALESCE((
           SELECT SUM(c.amount)
           FROM collections c
           WHERE c.created_by = u.id
         ), 0)
         +
         COALESCE((
           SELECT SUM(ke.amount)
           FROM khata_entries ke
           WHERE ke.created_by = u.id
             AND ke.type = 'credit'
         ), 0)
       ) AS total_revenue,

       (
         COALESCE((
           SELECT SUM(c.amount)
           FROM collections c
           WHERE c.created_by = u.id
         ), 0)
         +
         COALESCE((
           SELECT SUM(ke.amount)
           FROM khata_entries ke
           WHERE ke.created_by = u.id
             AND ke.type = 'credit'
         ), 0)
       ) AS total_sales,

       (
         COALESCE((
           SELECT SUM(e.amount)
           FROM expenses e
           WHERE e.created_by = u.id
         ), 0)
         +
         COALESCE((
           SELECT SUM(p.amount)
           FROM payments p
           WHERE p.created_by = u.id
             AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill' OR p.purchase_bill_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1
               FROM payments p2
               WHERE p2.created_by = p.created_by
                 AND (p2.payment_category IN ('paid_by_business', 'purchase_bill') OR p2.purpose = 'Purchase Bill' OR p2.purchase_bill_id IS NOT NULL)
                 AND COALESCE(NULLIF(p2.purchase_bill_id, 0), p2.id) = COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
                 AND (
                   p2.amount > p.amount
                   OR (p2.amount = p.amount AND p2.id < p.id)
                 )
             )
         ), 0)
         +
         COALESCE((
           SELECT SUM(ke.amount)
           FROM khata_entries ke
           WHERE ke.created_by = u.id
             AND ke.type = 'debit'
             AND (ke.is_linked_to_payment = 0 OR ke.is_linked_to_payment IS NULL)
         ), 0)
       ) AS expenses,

       COALESCE((
         SELECT SUM(e.amount)
         FROM expenses e
         WHERE e.created_by = u.id
       ), 0) AS direct_expenses,

       COALESCE((
         SELECT SUM(p.amount)
         FROM payments p
         WHERE p.created_by = u.id
           AND (p.payment_category = 'advance_from_investor' OR p.purpose IN ('Investor Advance', 'Advance'))
       ), 0) AS investor_advance,

       (
         (
           COALESCE((
             SELECT SUM(c.amount)
             FROM collections c
             WHERE c.created_by = u.id
           ), 0)
           +
           COALESCE((
             SELECT SUM(ke.amount)
             FROM khata_entries ke
             WHERE ke.created_by = u.id
               AND ke.type = 'credit'
           ), 0)
         )
         -
         (
           COALESCE((
             SELECT SUM(e.amount)
             FROM expenses e
             WHERE e.created_by = u.id
           ), 0)
           +
           COALESCE((
             SELECT SUM(p.amount)
           FROM payments p
           WHERE p.created_by = u.id
             AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill' OR p.purchase_bill_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1
               FROM payments p2
               WHERE p2.created_by = p.created_by
                 AND (p2.payment_category IN ('paid_by_business', 'purchase_bill') OR p2.purpose = 'Purchase Bill' OR p2.purchase_bill_id IS NOT NULL)
                 AND COALESCE(NULLIF(p2.purchase_bill_id, 0), p2.id) = COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
                 AND (
                   p2.amount > p.amount
                   OR (p2.amount = p.amount AND p2.id < p.id)
                 )
             )
           ), 0)
           +
           COALESCE((
             SELECT SUM(ke.amount)
             FROM khata_entries ke
             WHERE ke.created_by = u.id
               AND ke.type = 'debit'
               AND (ke.is_linked_to_payment = 0 OR ke.is_linked_to_payment IS NULL)
           ), 0)
         )
       ) AS net_profit,

       (
         (
           COALESCE((
             SELECT SUM(c.amount)
             FROM collections c
             WHERE c.created_by = u.id
           ), 0)
           +
           COALESCE((
             SELECT SUM(ke.amount)
             FROM khata_entries ke
             WHERE ke.created_by = u.id
               AND ke.type = 'credit'
           ), 0)
         )
         -
         (
           COALESCE((
             SELECT SUM(e.amount)
             FROM expenses e
             WHERE e.created_by = u.id
           ), 0)
           +
           COALESCE((
             SELECT SUM(p.amount)
           FROM payments p
           WHERE p.created_by = u.id
             AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill' OR p.purchase_bill_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1
               FROM payments p2
               WHERE p2.created_by = p.created_by
                 AND (p2.payment_category IN ('paid_by_business', 'purchase_bill') OR p2.purpose = 'Purchase Bill' OR p2.purchase_bill_id IS NOT NULL)
                 AND COALESCE(NULLIF(p2.purchase_bill_id, 0), p2.id) = COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
                 AND (
                   p2.amount > p.amount
                   OR (p2.amount = p.amount AND p2.id < p.id)
                 )
             )
           ), 0)
           +
           COALESCE((
             SELECT SUM(ke.amount)
             FROM khata_entries ke
             WHERE ke.created_by = u.id
               AND ke.type = 'debit'
               AND (ke.is_linked_to_payment = 0 OR ke.is_linked_to_payment IS NULL)
           ), 0)
         )
       ) AS profit_or_loss,

       (
         SELECT COUNT(*)
         FROM invoices i
         WHERE i.created_by = u.id
       ) AS invoice_count,

       (
         SELECT COUNT(*)
         FROM quotations q
         WHERE q.created_by = u.id
       ) AS quotation_count,

       (
         SELECT COUNT(*)
         FROM money_receipts mr
         WHERE mr.created_by = u.id
       ) AS money_receipt_count,

       (
         SELECT COUNT(*)
         FROM customers c
         WHERE c.created_by = u.id
       ) AS customer_count,

       (
         SELECT COUNT(*)
         FROM stock s
         WHERE s.created_by = u.id
       ) AS stock_item_count,

       (
         SELECT COUNT(*)
         FROM vehicle_trips v
         WHERE v.created_by = u.id
       ) AS vehicle_trip_count,

       latest_sub.plan_name AS subscription_plan_name,
       latest_sub.plan_code AS subscription_plan_code,
       latest_sub.ends_at AS subscription_ends_at,
       latest_sub.is_complimentary AS subscription_is_complimentary,
       latest_sub.status AS subscription_status,
       CASE
         WHEN latest_sub.ends_at IS NULL THEN 'none'
         WHEN latest_sub.ends_at > NOW() THEN 'active'
         ELSE 'expired'
       END AS subscription_display_status

     FROM users u
     LEFT JOIN users deleter ON u.deleted_by = deleter.id
     LEFT JOIN users restorer ON u.restored_by = restorer.id
     LEFT JOIN (
       SELECT s1.user_id, s1.plan_id, s1.ends_at, s1.is_complimentary, s1.status, p.name AS plan_name, p.code AS plan_code
       FROM subscriptions s1
       JOIN (
         SELECT user_id, MAX(ends_at) AS max_end
         FROM subscriptions
         GROUP BY user_id
       ) s2 ON s1.user_id = s2.user_id AND s1.ends_at = s2.max_end
       JOIN subscription_plans p ON s1.plan_id = p.id
     ) latest_sub ON latest_sub.user_id = u.id
     WHERE u.role = 'user'${tenantFilter}${tabCondition}
     ORDER BY u.created_at DESC`,
    queryParams
  );

  const users = rows.map((user) => {
    const totalSales = Math.round(Number(user.total_sales || user.total_revenue || 0) * 100) / 100;
    const totalExpenses = Math.round(Number(user.expenses || 0) * 100) / 100;
    const netProfit = Math.round((totalSales - totalExpenses) * 100) / 100;

    return {
      ...user,
      is_deleted: Boolean(user.is_deleted || user.deleted_at || user.status === "deleted"),
      total_sales: totalSales,
      total_revenue: totalSales,
      expenses: totalExpenses,
      net_profit: netProfit,
      profit_or_loss: netProfit,
      subscription: {
        plan_name: user.subscription_plan_name || null,
        plan_code: user.subscription_plan_code || null,
        ends_at: user.subscription_ends_at || null,
        remaining_days: user.subscription_ends_at
          ? Math.max(0, Math.ceil((new Date(user.subscription_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
          : 0,
        status: user.subscription_display_status || "none",
        is_complimentary: Boolean(user.subscription_is_complimentary),
      },
      financials: {
        credit: Number(user.credit || 0),
        used_credits: Number(user.used_credits || 0),
        net_credit: Number(user.net_credit || 0),
        debit: Number(user.debit || 0),
        total_sales: totalSales,
        total_revenue: totalSales,
        expenses: totalExpenses,
        direct_expenses: Number(user.direct_expenses || 0),
        investor_advance: Number(user.investor_advance || 0),
        net_profit: netProfit,
        profit_or_loss: netProfit,
      },
      counts: {
        invoices: Number(user.invoice_count || 0),
        quotations: Number(user.quotation_count || 0),
        money_receipts: Number(user.money_receipt_count || 0),
        customers: Number(user.customer_count || 0),
        stock_items: Number(user.stock_item_count || 0),
        vehicle_trips: Number(user.vehicle_trip_count || 0),
      },
    };
  });

  res.json({
    success: true,
    count: users.length,
    counts: {
      active: Number(countRows[0]?.active_count || 0),
      deleted: Number(countRows[0]?.deleted_count || 0),
      total: Number(countRows[0]?.total_count || 0),
    },
    users,
  });
});

// GET /api/superadmin/users/:id
const getUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);

  const [rows] = await pool.query(
    `SELECT
       u.id, u.name, u.email, u.phone, u.secondary_phone, u.business_name, u.business_type,
       u.gstin, u.pan, u.website, u.address, u.address_line1, u.address_line2,
       u.city, u.state, u.pincode, u.country, u.role, u.employee_role_type,
       u.employee_title, u.permissions, u.profile_photo_path, u.status,
       u.last_login_at, u.last_active_at, u.created_by_admin, u.created_at, u.updated_at,
       u.deleted_at, u.deleted_by, deleter.name AS deleted_by_name, u.deletion_reason,
       u.restored_at, u.restored_by, restorer.name AS restored_by_name, u.restoration_reason,
       CASE WHEN (u.deleted_at IS NOT NULL OR u.status = 'deleted') THEN 1 ELSE 0 END AS is_deleted
     FROM users u
     LEFT JOIN users deleter ON u.deleted_by = deleter.id
     LEFT JOIN users restorer ON u.restored_by = restorer.id
     WHERE u.id = ?`,
    [id]
  );
  if (!rows.length) throw new ApiError(404, "User not found.");
  const user = rows[0];
  user.is_deleted = Boolean(user.is_deleted || user.deleted_at || user.status === "deleted");
  res.json({ success: true, user });
});

// GET /api/superadmin/users/:id/overview
const getUserOverview = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);

  const [userRows] = await pool.query(
    `SELECT
       u.id, u.name, u.email, u.phone,
       u.business_name, u.business_type, u.gstin, u.pan, u.website,
       u.logo_path, u.signature_path,
       u.address, u.address_line1, u.address_line2, u.city, u.state, u.pincode, u.country,
       u.currency, u.tax_type, u.tcs_enabled, u.tds_enabled, u.payment_terms,
       u.role, u.status, u.created_at, u.last_login_at, u.last_active_at,
       u.deleted_at, u.deleted_by, deleter.name AS deleted_by_name, u.deletion_reason,
       u.restored_at, u.restored_by, restorer.name AS restored_by_name, u.restoration_reason,
       CASE WHEN (u.deleted_at IS NOT NULL OR u.status = 'deleted') THEN 1 ELSE 0 END AS is_deleted
     FROM users u
     LEFT JOIN users deleter ON u.deleted_by = deleter.id
     LEFT JOIN users restorer ON u.restored_by = restorer.id
     WHERE u.id = ? AND u.role = 'user'`,
    [id]
  );

  if (!userRows.length) {
    throw new ApiError(404, "User not found.");
  }

  const user = userRows[0];
  user.is_deleted = Boolean(user.is_deleted || user.deleted_at || user.status === "deleted");

  const [subRows] = await pool.query(
    `SELECT s.id, s.status, s.plan_id, s.starts_at, s.ends_at, s.is_complimentary,
            p.name AS plan_name, p.code AS plan_code, p.price_paise, p.duration_months
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.user_id = ?
     ORDER BY s.ends_at DESC
     LIMIT 1`,
    [id]
  );

  let subscription = null;
  if (subRows.length > 0) {
    const sub = subRows[0];
    const now = new Date();
    const endsAt = sub.ends_at ? new Date(sub.ends_at) : null;
    const isActive = sub.status === "active" && endsAt && endsAt > now;
    const remainingDays = endsAt ? Math.max(0, Math.ceil((endsAt - now) / (1000 * 60 * 60 * 24))) : 0;
    subscription = {
      id: sub.id,
      plan_name: sub.plan_name,
      plan_code: sub.plan_code,
      starts_at: sub.starts_at,
      ends_at: sub.ends_at,
      remaining_days: remainingDays,
      status: isActive ? "active" : (endsAt && endsAt <= now ? "expired" : sub.status),
      is_complimentary: Boolean(sub.is_complimentary),
    };
  }
  user.subscription = subscription;

  const [grantRows] = await pool.query(
    `SELECT a.id, a.actor_id, a.action, a.target_id, a.details, a.created_at,
            u.name AS granted_by_name, u.email AS granted_by_email
     FROM admin_audit_logs a
     LEFT JOIN users u ON a.actor_id = u.id
     WHERE a.action = 'GRANT_COMPLIMENTARY_SUBSCRIPTION'
       AND (
         JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.user_id')) = ?
         OR a.target_id IN (SELECT CAST(id AS CHAR) FROM subscriptions WHERE user_id = ?)
       )
     ORDER BY a.created_at DESC`,
    [String(id), id]
  );

  user.grant_history = grantRows.map((r) => {
    let details = {};
    try {
      details = typeof r.details === "string" ? JSON.parse(r.details) : (r.details || {});
    } catch (_) {}
    return {
      id: r.id,
      created_at: r.created_at,
      granted_by_name: r.granted_by_name || details.granted_by_name || "Superadmin",
      granted_by_email: r.granted_by_email || details.granted_by_email || "",
      plan_name: details.plan_name || details.plan_code || "Complimentary Plan",
      plan_code: details.plan_code || "",
      duration_months: details.duration_months || 1,
      notes: details.notes || "",
    };
  });

  const [
    customerResult,
    invoiceResult,
    quotationResult,
    receiptResult,
    paymentResult,
    stockResult,
    vehicleResult,
    khataResult,
    creditResult,
    usedCreditResult,
    debitResult,
    reports,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM invoices WHERE created_by = ? AND doc_type = 'invoice'", [id]),
    pool.query("SELECT COUNT(*) AS count FROM quotations WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM money_receipts WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM payments WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM stock WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM vehicle_trips WHERE created_by = ?", [id]),
    pool.query(
      `SELECT (
         (SELECT COUNT(*) FROM collections WHERE created_by = ?)
         +
         (SELECT COUNT(*) FROM payments WHERE created_by = ?)
       ) AS count`,
      [id, id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM collections
       WHERE created_by = ? AND payment_type = 'due'`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE created_by = ? AND payment_category = 'due_received'`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(sub.amount), 0) AS total
       FROM (
         SELECT MAX(p.amount) AS amount
         FROM payments p
         WHERE created_by = ? AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill' OR p.purchase_bill_id IS NOT NULL)
         GROUP BY COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
       ) sub`,
      [id]
    ),
    calculateUserReports(id),
  ]);

  const credit = Number(creditResult[0][0].total || 0);
  const usedCredits = Number(usedCreditResult[0][0].total || 0);

  const overview = {
    customer_count: Number(customerResult[0][0].count || 0),
    invoice_count: Number(invoiceResult[0][0].count || 0),
    quotation_count: Number(quotationResult[0][0].count || 0),
    money_receipt_count: Number(receiptResult[0][0].count || 0),
    payment_count: Number(paymentResult[0][0].count || 0),
    stock_count: Number(stockResult[0][0].count || 0),
    vehicle_trip_count: Number(vehicleResult[0][0].count || 0),
    khata_count: Number(khataResult[0][0].count || 0),

    total_sales: reports.total_sales,
    total_revenue: reports.total_sales,
    credit: credit,
    used_credits: usedCredits,
    net_credit: Math.round((credit - usedCredits) * 100) / 100,
    debit: Number(debitResult[0][0].total || 0),

    expenses: reports.expenses,
    direct_expenses: reports.expenses_breakdown.direct_expenses,
    due_received: reports.due_received,
    paid_by_business: reports.expenses_breakdown.paid_by_business_payments,

    net_profit: reports.net_profit,
    profit_or_loss: reports.net_profit,

    credit_entries: reports.credit_entries,
    debit_entries: reports.debit_entries,
    reports: reports,
  };

  res.json({
    success: true,
    user,
    overview,
  });
});
const createEmployee = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    password,
    phone,
    secondary_phone,
    employee_code,
    joining_date,
    emergency_contact,
    notes,
    employee_role_type,
    employee_title,
    date_of_birth,
    employee_age,
    address,
    pan,
    aadhaar_number,
    passport_number,
    permissions,
    assigned_modules,
  } = req.body;

  if (!email || !password) {
    throw new ApiError(400, "email and password are required to create an employee login.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const [existing] = await pool.query(
    "SELECT id FROM users WHERE email = ? AND (deleted_at IS NULL AND status != 'deleted')",
    [normalizedEmail]
  );
  if (existing.length) throw new ApiError(409, "An account with this email already exists.");

  const normalizedPermissions = normalizePermissions(permissions);
  let assignedModulesJson;
  if (Array.isArray(assigned_modules)) {
    assignedModulesJson = JSON.stringify(assigned_modules);
  } else if (typeof assigned_modules === "string" && assigned_modules.trim().startsWith("[")) {
    try {
      assignedModulesJson = JSON.stringify(JSON.parse(assigned_modules));
    } catch (_) {
      assignedModulesJson = JSON.stringify([assigned_modules]);
    }
  } else if (typeof assigned_modules === "string" && assigned_modules.trim()) {
    assignedModulesJson = JSON.stringify([assigned_modules.trim()]);
  } else {
    assignedModulesJson = JSON.stringify(["users", "help_centre"]);
  }
  const hashed = await bcrypt.hash(password, 10);

  let result;
  try {
    const [insertResult] = await pool.query(
      `INSERT INTO users (
         name, email, phone, secondary_phone, employee_code, joining_date, emergency_contact, notes,
         password, role, employee_role_type, employee_title, date_of_birth, employee_age,
         address, pan, aadhaar_number, passport_number, profile_photo_path,
         permissions, assigned_modules, created_by_admin
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name || null,
        normalizedEmail,
        phone || null,
        secondary_phone || null,
        employee_code && employee_code.trim() ? employee_code.trim() : null,
        joining_date && String(joining_date).trim() ? String(joining_date).trim().slice(0, 10) : null,
        emergency_contact && emergency_contact.trim() ? emergency_contact.trim() : null,
        notes && notes.trim() ? notes.trim() : null,
        hashed,
        employee_role_type && employee_role_type.trim() ? employee_role_type.trim() : "staff",
        employee_title && employee_title.trim() ? employee_title.trim() : null,
        date_of_birth && String(date_of_birth).trim() ? String(date_of_birth).trim().slice(0, 10) : null,
        employee_age !== "" && employee_age !== null && !isNaN(Number(employee_age)) ? parseInt(employee_age, 10) : null,
        address && address.trim() ? address.trim() : null,
        pan && pan.trim() ? pan.trim() : null,
        aadhaar_number && aadhaar_number.trim() ? aadhaar_number.trim() : null,
        passport_number && passport_number.trim() ? passport_number.trim() : null,
        req.file ? relativeUploadPath(req.file.path) : null,
        normalizedPermissions ? JSON.stringify(normalizedPermissions) : null,
        assignedModulesJson,
        req.user.id,
      ]
    );
    result = insertResult;
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "An account with this email already exists.");
    }
    throw err;
  }

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);

  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
       VALUES (?, ?, 'CREATE_EMPLOYEE', 'employee', ?, NULL, ?, ?, ?)`,
      [
        req.user.id,
        req.user.role || "superadmin",
        String(result.insertId),
        JSON.stringify(publicUser(rows[0])),
        JSON.stringify({ name: rows[0].name, email: rows[0].email }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  res.status(201).json({ success: true, employee: publicUser(rows[0]) });
});

// GET /api/superadmin/employees
const listEmployees = asyncHandler(async (req, res) => {
  const { search, status, page, limit } = req.query;

  let query = `
    SELECT u.id, u.name, u.email, u.phone, u.secondary_phone,
           u.employee_code, u.joining_date, u.emergency_contact, u.notes, u.assigned_modules,
           u.employee_title, u.employee_role_type, u.date_of_birth, u.employee_age,
           u.address, u.pan, u.aadhaar_number, u.passport_number,
           u.profile_photo_path, u.permissions, u.status,
           u.last_login_at, u.last_active_at,
           CASE WHEN u.last_active_at IS NOT NULL AND u.last_active_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE) THEN 'logged_in' ELSE 'logged_out' END AS activity_status,
           u.created_by_admin, u.created_at, u.updated_at,
           COALESCE(fb.rating_avg, 0) AS rating_avg,
           COALESCE(fb.rating_count, 0) AS rating_count,
           COALESCE(tc.tickets_handled, 0) AS tickets_handled
    FROM users u
    LEFT JOIN (
      SELECT employee_id, ROUND(AVG(rating), 1) AS rating_avg, COUNT(*) AS rating_count
      FROM support_ticket_feedback
      GROUP BY employee_id
    ) fb ON fb.employee_id = u.id
    LEFT JOIN (
      SELECT assigned_employee_id, COUNT(*) AS tickets_handled
      FROM support_tickets
      GROUP BY assigned_employee_id
    ) tc ON tc.assigned_employee_id = u.id
    WHERE u.role = 'employee' AND u.deleted_at IS NULL
  `;
  const params = [];

  if (status && (status === "active" || status === "inactive")) {
    query += " AND u.status = ?";
    params.push(status);
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    query += " AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.employee_code LIKE ? OR u.employee_title LIKE ?)";
    params.push(s, s, s, s, s);
  }

  query += " ORDER BY u.created_at DESC";

  const [rows] = await pool.query(query, params);

  const formatted = rows.map((emp) => {
    let assigned = [];
    if (Array.isArray(emp.assigned_modules)) assigned = emp.assigned_modules;
    else if (typeof emp.assigned_modules === "string") {
      try { assigned = JSON.parse(emp.assigned_modules); } catch (_) { assigned = []; }
    }
    return {
      ...emp,
      rating_avg: Number(emp.rating_avg || 0),
      rating_count: Number(emp.rating_count || 0),
      tickets_handled: Number(emp.tickets_handled || 0),
      assigned_modules: assigned,
    };
  });

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 50));
  const total = formatted.length;
  const paginated = page ? formatted.slice((pageNum - 1) * limitNum, pageNum * limitNum) : formatted;

  res.json({
    success: true,
    count: paginated.length,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum) || 1,
    employees: paginated,
  });
});

// GET /api/superadmin/employees/:id
const getEmployee = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.secondary_phone,
            u.employee_code, u.joining_date, u.emergency_contact, u.notes, u.assigned_modules,
            u.employee_title, u.employee_role_type, u.date_of_birth, u.employee_age,
            u.address, u.pan, u.aadhaar_number, u.passport_number,
            u.profile_photo_path, u.permissions, u.status,
            u.last_login_at, u.last_active_at,
            CASE WHEN u.last_active_at IS NOT NULL AND u.last_active_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE) THEN 'logged_in' ELSE 'logged_out' END AS activity_status,
            u.created_by_admin, u.created_at, u.updated_at,
            COALESCE(fb.rating_avg, 0) AS rating_avg,
            COALESCE(fb.rating_count, 0) AS rating_count,
            COALESCE(tc.tickets_handled, 0) AS tickets_handled,
            COALESCE(tc.tickets_resolved, 0) AS tickets_resolved
     FROM users u
     LEFT JOIN (
       SELECT employee_id, ROUND(AVG(rating), 1) AS rating_avg, COUNT(*) AS rating_count
       FROM support_ticket_feedback
       GROUP BY employee_id
     ) fb ON fb.employee_id = u.id
     LEFT JOIN (
       SELECT assigned_employee_id,
              COUNT(*) AS tickets_handled,
              COUNT(CASE WHEN status IN ('resolved', 'closed') THEN 1 END) AS tickets_resolved
       FROM support_tickets
       GROUP BY assigned_employee_id
     ) tc ON tc.assigned_employee_id = u.id
     WHERE u.id = ? AND u.role = 'employee'`,
    [req.params.id]
  );

  if (!rows.length) throw new ApiError(404, "Employee not found.");

  const emp = rows[0];
  let assigned = [];
  if (Array.isArray(emp.assigned_modules)) assigned = emp.assigned_modules;
  else if (typeof emp.assigned_modules === "string") {
    try { assigned = JSON.parse(emp.assigned_modules); } catch (_) { assigned = []; }
  }

  // Rating distribution counts (5 down to 1)
  const [distRows] = await pool.query(
    `SELECT rating, COUNT(*) AS count
     FROM support_ticket_feedback
     WHERE employee_id = ?
     GROUP BY rating`,
    [req.params.id]
  );
  const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of distRows) {
    if (ratingDistribution[r.rating] !== undefined) {
      ratingDistribution[r.rating] = Number(r.count);
    }
  }

  // Recent customer feedback
  const [recentFeedback] = await pool.query(
    `SELECT stf.id, stf.rating, stf.comment, stf.created_at,
            st.ticket_number, st.subject AS ticket_subject,
            u.name AS customer_name, u.email AS customer_email
     FROM support_ticket_feedback stf
     JOIN support_tickets st ON st.id = stf.ticket_id
     JOIN users u ON u.id = stf.user_id
     WHERE stf.employee_id = ?
     ORDER BY stf.created_at DESC
     LIMIT 10`,
    [req.params.id]
  );

  // Employee action and target audit logs
  const [auditLogs] = await pool.query(
    `SELECT a.id, a.actor_id, a.actor_role, a.action, a.target_type, a.target_id, a.details, a.created_at, a.ip_address,
            COALESCE(i.invoice_number, '') AS invoice_number,
            COALESCE(i.total_amount, 0) AS invoice_total,
            COALESCE(i.to_name, '') AS invoice_recipient,
            COALESCE(i.pdf_path, '') AS invoice_pdf,
            COALESCE(q.quotation_number, '') AS quotation_number,
            COALESCE(q.total_amount, 0) AS quotation_total,
            COALESCE(q.to_name, '') AS quotation_recipient,
            COALESCE(q.pdf_path, '') AS quotation_pdf,
            COALESCE(mr.receipt_number, '') AS receipt_number,
            COALESCE(mr.amount_received, 0) AS receipt_amount,
            COALESCE(mr.received_from_name, '') AS receipt_recipient,
            COALESCE(mr.pdf_path, '') AS receipt_pdf
     FROM admin_audit_logs a
     LEFT JOIN invoices i ON a.target_type = 'invoice' AND i.id = CAST(a.target_id AS UNSIGNED)
     LEFT JOIN quotations q ON a.target_type = 'quotation' AND q.id = CAST(a.target_id AS UNSIGNED)
     LEFT JOIN money_receipts mr ON (a.target_type = 'receipt' OR a.target_type = 'money_receipt') AND mr.id = CAST(a.target_id AS UNSIGNED)
     WHERE a.actor_id = ? OR (a.target_type = 'employee' AND a.target_id = ?)
     ORDER BY a.created_at DESC
     LIMIT 100`,
    [req.params.id, String(req.params.id)]
  );

  res.json({
    success: true,
    employee: {
      ...emp,
      rating_avg: Number(emp.rating_avg || 0),
      rating_count: Number(emp.rating_count || 0),
      tickets_handled: Number(emp.tickets_handled || 0),
      tickets_resolved: Number(emp.tickets_resolved || 0),
      assigned_modules: assigned,
      rating_distribution: ratingDistribution,
      recent_feedback: recentFeedback,
      audit_logs: auditLogs,
    },
  });
});

// PATCH /api/superadmin/employees/:id
const updateEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    name,
    email,
    phone,
    secondary_phone,
    employee_code,
    joining_date,
    emergency_contact,
    notes,
    employee_role_type,
    employee_title,
    date_of_birth,
    employee_age,
    address,
    pan,
    aadhaar_number,
    passport_number,
    permissions,
    assigned_modules,
    status,
    password,
  } = req.body;

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ? AND role = 'employee'",
    [id]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found.");
  const current = rows[0];

  // If email is changing, ensure uniqueness among active accounts
  if (email && email.trim() && email.trim().toLowerCase() !== current.email.toLowerCase()) {
    const [conflict] = await pool.query(
      "SELECT id FROM users WHERE email = ? AND id != ? AND (deleted_at IS NULL AND status != 'deleted')",
      [email.trim().toLowerCase(), id]
    );
    if (conflict.length) {
      throw new ApiError(409, "An account with this email already exists.");
    }
  }

  // Sanitize values cleanly
  const nameVal = name !== undefined ? (name && name.trim() ? name.trim() : null) : current.name;
  const emailVal = email !== undefined ? (email && email.trim() ? email.trim().toLowerCase() : current.email) : current.email;
  const phoneVal = phone !== undefined ? (phone && phone.trim() ? phone.trim() : null) : current.phone;
  const secondaryPhoneVal = secondary_phone !== undefined ? (secondary_phone && secondary_phone.trim() ? secondary_phone.trim() : null) : current.secondary_phone;
  const employeeCodeVal = employee_code !== undefined ? (employee_code && employee_code.trim() ? employee_code.trim() : null) : current.employee_code;
  const joiningDateVal = joining_date !== undefined
    ? (joining_date && String(joining_date).trim() ? String(joining_date).trim().slice(0, 10) : null)
    : (current.joining_date ? new Date(current.joining_date).toISOString().slice(0, 10) : null);
  const emergencyContactVal = emergency_contact !== undefined ? (emergency_contact && emergency_contact.trim() ? emergency_contact.trim() : null) : current.emergency_contact;
  const notesVal = notes !== undefined ? (notes && notes.trim() ? notes.trim() : null) : current.notes;
  const roleTypeVal = employee_role_type !== undefined ? (employee_role_type && employee_role_type.trim() ? employee_role_type.trim() : "staff") : current.employee_role_type;
  const titleVal = employee_title !== undefined ? (employee_title && employee_title.trim() ? employee_title.trim() : null) : current.employee_title;
  const dobVal = date_of_birth !== undefined
    ? (date_of_birth && String(date_of_birth).trim() ? String(date_of_birth).trim().slice(0, 10) : null)
    : (current.date_of_birth ? new Date(current.date_of_birth).toISOString().slice(0, 10) : null);
  const ageVal = employee_age !== undefined
    ? (employee_age !== "" && employee_age !== null && !isNaN(Number(employee_age)) ? parseInt(employee_age, 10) : null)
    : current.employee_age;
  const addressVal = address !== undefined ? (address && address.trim() ? address.trim() : null) : current.address;
  const panVal = pan !== undefined ? (pan && pan.trim() ? pan.trim() : null) : current.pan;
  const aadhaarVal = aadhaar_number !== undefined ? (aadhaar_number && aadhaar_number.trim() ? aadhaar_number.trim() : null) : current.aadhaar_number;
  const passportVal = passport_number !== undefined ? (passport_number && passport_number.trim() ? passport_number.trim() : null) : current.passport_number;

  const photoPath = req.file ? relativeUploadPath(req.file.path) : null;
  const photoVal = photoPath !== null ? photoPath : current.profile_photo_path;

  let assignedModulesJson = current.assigned_modules;
  if (assigned_modules !== undefined) {
    if (Array.isArray(assigned_modules)) {
      assignedModulesJson = JSON.stringify(assigned_modules);
    } else if (typeof assigned_modules === "string" && assigned_modules.trim().startsWith("[")) {
      try {
        assignedModulesJson = JSON.stringify(JSON.parse(assigned_modules));
      } catch (_) {
        assignedModulesJson = JSON.stringify([assigned_modules]);
      }
    } else if (typeof assigned_modules === "string" && assigned_modules.trim()) {
      assignedModulesJson = JSON.stringify([assigned_modules.trim()]);
    } else {
      assignedModulesJson = JSON.stringify([]);
    }
  }

  const normalizedPermissions = permissions !== undefined ? normalizePermissions(permissions) : (current.permissions ? (typeof current.permissions === "string" ? JSON.parse(current.permissions) : current.permissions) : []);
  const permissionsJson = JSON.stringify(normalizedPermissions);

  let hashedPassword = current.password;
  if (password && password.trim()) {
    hashedPassword = await bcrypt.hash(password.trim(), 10);
  }

  const statusVal = status !== undefined ? (status && status.trim() ? status.trim() : current.status) : current.status;

  await pool.query(
    `UPDATE users SET
       name = ?,
       email = ?,
       phone = ?,
       secondary_phone = ?,
       employee_code = ?,
       joining_date = ?,
       emergency_contact = ?,
       notes = ?,
       employee_role_type = ?,
       employee_title = ?,
       date_of_birth = ?,
       employee_age = ?,
       address = ?,
       pan = ?,
       aadhaar_number = ?,
       passport_number = ?,
       profile_photo_path = ?,
       permissions = ?,
       assigned_modules = ?,
       status = ?,
       password = ?
     WHERE id = ?`,
    [
      nameVal,
      emailVal,
      phoneVal,
      secondaryPhoneVal,
      employeeCodeVal,
      joiningDateVal,
      emergencyContactVal,
      notesVal,
      roleTypeVal,
      titleVal,
      dobVal,
      ageVal,
      addressVal,
      panVal,
      aadhaarVal,
      passportVal,
      photoVal,
      permissionsJson,
      assignedModulesJson,
      statusVal,
      hashedPassword,
      id,
    ]
  );

  const [updated] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);

  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
       VALUES (?, ?, 'UPDATE_EMPLOYEE', 'employee', ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        req.user.role || "superadmin",
        String(id),
        JSON.stringify(publicUser(current)),
        JSON.stringify(publicUser(updated[0])),
        JSON.stringify({ name: updated[0].name, email: updated[0].email }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  res.json({ success: true, employee: publicUser(updated[0]) });
});

// DELETE /api/superadmin/employees/:id
const deleteEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ? AND role = 'employee'",
    [id]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found.");
  const target = rows[0];

  await pool.query(
    "UPDATE users SET status = 'inactive', deleted_at = NOW(), deleted_by = ?, last_active_at = NULL WHERE id = ?",
    [req.user.id, id]
  );

  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
       VALUES (?, ?, 'DELETE_EMPLOYEE', 'employee', ?, ?, NULL, ?, ?)`,
      [
        req.user.id,
        req.user.role || "superadmin",
        String(id),
        JSON.stringify(publicUser(target)),
        JSON.stringify({ name: target.name, email: target.email, action: "soft_deleted_and_deactivated" }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  res.json({
    success: true,
    message: `Employee "${target.name || target.email}" was deactivated and removed from active roster.`,
    employee: { id: target.id, email: target.email, name: target.name },
  });
});

// PATCH /api/superadmin/users/:id/status
// PATCH /api/superadmin/users/:id
// Superadmin updates user profile details with validation and audit logging
const updateUser = asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!targetId || Number.isNaN(targetId)) {
    throw new ApiError(400, "Invalid user ID provided.");
  }

  const [targets] = await pool.query("SELECT * FROM users WHERE id = ?", [targetId]);
  if (!targets.length) {
    throw new ApiError(404, "User not found.");
  }
  const existingUser = targets[0];

  const allowedFields = [
    "name",
    "email",
    "phone",
    "secondary_phone",
    "business_name",
    "business_type",
    "gstin",
    "pan",
    "address",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "pincode",
    "notes",
    "status",
  ];

  const updates = {};
  const changes = [];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      const val = req.body[field] === null ? null : String(req.body[field]).trim();
      if (field === "email" && val && val.toLowerCase() !== (existingUser.email || "").toLowerCase()) {
        const [conflict] = await pool.query(
          "SELECT id FROM users WHERE email = ? AND id != ? AND (deleted_at IS NULL AND status != 'deleted')",
          [val.toLowerCase(), targetId]
        );
        if (conflict.length > 0) {
          throw new ApiError(409, "Email address is already in use by another active account.");
        }
      }
      if (field === "status" && val && !["active", "inactive"].includes(val)) {
        throw new ApiError(400, "status must be 'active' or 'inactive'.");
      }
      updates[field] = val;
      if (existingUser[field] !== val) {
        changes.push({ field, old: existingUser[field], new: val });
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates).map((f) => `\`${f}\` = ?`).join(", ");
    const setValues = Object.values(updates);
    setValues.push(targetId);

    try {
      await pool.query(`UPDATE users SET ${setClauses}, updated_at = NOW() WHERE id = ?`, setValues);
    } catch (updateErr) {
      if (updateErr.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "Email address is already in use by another active account.");
      }
      throw updateErr;
    }

    try {
      await pool.query(
        `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          req.user.role || "superadmin",
          "UPDATE_USER_PROFILE",
          "user",
          String(targetId),
          JSON.stringify(existingUser),
          JSON.stringify(updates),
          JSON.stringify({ changes }),
          req.ip || "127.0.0.1",
        ]
      );
    } catch (auditErr) {
      console.warn("admin_audit_logs error:", auditErr.message);
    }
  }

  const [updatedRows] = await pool.query("SELECT * FROM users WHERE id = ?", [targetId]);
  const updatedUser = updatedRows[0];
  delete updatedUser.password;

  res.json({
    success: true,
    message: "User profile updated successfully.",
    user: updatedUser,
  });
});

// Activate/deactivate any account (user or employee).
const setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["active", "inactive"].includes(status)) {
    throw new ApiError(400, "status must be 'active' or 'inactive'.");
  }
  if (Number(id) === req.user.id) throw new ApiError(400, "You cannot deactivate your own account.");

  const [result] = await pool.query("UPDATE users SET status = ? WHERE id = ?", [status, id]);
  if (!result.affectedRows) throw new ApiError(404, "User not found.");

  res.json({ success: true, message: `Account status set to ${status}.` });
});

// DELETE /api/superadmin/users/:id
// Superadmin user soft deletion with referential integrity preservation & audit trail
const deleteUser = asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const { reason = "Superadmin initiated account deletion" } = req.body || {};

  if (!targetId || Number.isNaN(targetId)) {
    throw new ApiError(400, "Invalid user ID provided.");
  }

  // 1. Self-protection
  if (targetId === req.user.id) {
    throw new ApiError(400, "You cannot delete your own superadmin account.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [targets] = await conn.query("SELECT * FROM users WHERE id = ? FOR UPDATE", [targetId]);
    if (!targets.length) {
      await conn.rollback();
      throw new ApiError(404, "User not found.");
    }

    const targetUser = targets[0];

    // 2. Protect superadmin accounts
    if (targetUser.role === "superadmin") {
      await conn.rollback();
      throw new ApiError(403, "System superadmin accounts cannot be deleted.");
    }

    // 3. Idempotent check
    if (targetUser.deleted_at !== null || targetUser.status === "deleted") {
      await conn.rollback();
      return res.json({
        success: true,
        type: "already_deleted",
        message: `User "${targetUser.name || targetUser.email}" is already in the deleted users archive.`,
        user: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          status: "deleted",
          is_deleted: true,
          deleted_at: targetUser.deleted_at,
        },
      });
    }

    // 4. Count referential dependencies across financial and business ledger tables
    const [[{ count: custCount }]] = await conn.query("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?", [targetId]);
    const [[{ count: invCount }]] = await conn.query("SELECT COUNT(*) AS count FROM invoices WHERE created_by = ?", [targetId]);
    const [[{ count: quoCount }]] = await conn.query("SELECT COUNT(*) AS count FROM quotations WHERE created_by = ?", [targetId]);
    const [[{ count: payCount }]] = await conn.query("SELECT COUNT(*) AS count FROM payments WHERE created_by = ?", [targetId]);
    const [[{ count: colCount }]] = await conn.query("SELECT COUNT(*) AS count FROM collections WHERE created_by = ?", [targetId]);
    const [[{ count: expCount }]] = await conn.query("SELECT COUNT(*) AS count FROM expenses WHERE created_by = ?", [targetId]);
    const [[{ count: stockCount }]] = await conn.query("SELECT COUNT(*) AS count FROM stock WHERE created_by = ?", [targetId]);
    const [[{ count: purCount }]] = await conn.query("SELECT COUNT(*) AS count FROM purchase_bills WHERE created_by = ?", [targetId]);
    const [[{ count: subOrderCount }]] = await conn.query("SELECT COUNT(*) AS count FROM subscription_orders WHERE user_id = ?", [targetId]);
    const [[{ count: subCount }]] = await conn.query("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?", [targetId]);

    const totalRecords =
      custCount + invCount + quoCount + payCount + colCount + expCount + stockCount + purCount + subOrderCount + subCount;

    // 5. Soft-delete user: update status to 'deleted', record deleted_at, deleted_by, deletion_reason
    // DO NOT scramble password so that restoration is clean and preserves the original credentials
    await conn.query(
      `UPDATE users
       SET status = 'deleted',
           deleted_at = NOW(),
           deleted_by = ?,
           deletion_reason = ?,
           last_active_at = NULL
       WHERE id = ?`,
      [req.user.id, reason, targetId]
    );

    // Also deactivate any employees created by this business owner
    await conn.query(
      "UPDATE users SET status = 'inactive', last_active_at = NULL WHERE created_by_admin = ?",
      [targetId]
    );

    // 6. Record audit trail in user_audit_logs and admin_audit_logs
    await conn.query(
      `INSERT INTO user_audit_logs (superadmin_id, target_user_id, action, reason, details)
       VALUES (?, ?, 'soft_delete_user', ?, ?)`,
      [
        req.user.id,
        targetId,
        reason,
        JSON.stringify({
          target_email: targetUser.email,
          target_name: targetUser.name,
          target_role: targetUser.role,
          total_records_preserved: totalRecords,
          breakdown: {
            customers: custCount,
            invoices: invCount,
            quotations: quoCount,
            payments: payCount,
            collections: colCount,
            expenses: expCount,
            stock: stockCount,
            purchase_bills: purCount,
            subscriptions: subCount,
            subscription_orders: subOrderCount,
          },
        }),
      ]
    );

    try {
      await conn.query(
        `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
         VALUES (?, ?, 'SOFT_DELETE_USER', 'user', ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          req.user.role || "superadmin",
          String(targetId),
          JSON.stringify({ status: targetUser.status, deleted_at: targetUser.deleted_at }),
          JSON.stringify({ status: "deleted", deleted_at: new Date() }),
          JSON.stringify({ reason, name: targetUser.name, email: targetUser.email, total_records_preserved: totalRecords }),
          req.ip || null,
        ]
      );
    } catch (_) {}

    await conn.commit();

    res.json({
      success: true,
      type: "soft_deleted",
      message: `User "${targetUser.name || targetUser.email}" has been moved to the deleted users archive. All ${totalRecords} historical business and financial ledger records have been safely preserved.`,
      user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        status: "deleted",
        is_deleted: true,
      },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/superadmin/users/:id/restore
// Restore a previously soft-deleted user account and reactivate its employees
const restoreUser = asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const { reason = "Superadmin restored account" } = req.body || {};

  if (!targetId || Number.isNaN(targetId)) {
    throw new ApiError(400, "Invalid user ID provided.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [targets] = await conn.query("SELECT * FROM users WHERE id = ? FOR UPDATE", [targetId]);
    if (!targets.length) {
      await conn.rollback();
      throw new ApiError(404, "User not found.");
    }

    const targetUser = targets[0];

    // Idempotency check: if user is already active
    if (targetUser.deleted_at === null && targetUser.status !== "deleted") {
      await conn.rollback();
      return res.json({
        success: true,
        message: `User "${targetUser.name || targetUser.email}" is already active.`,
        user: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          status: targetUser.status,
          is_deleted: false,
        },
      });
    }

    // Check if another active account is currently using this email address
    const [conflictingActive] = await conn.query(
      "SELECT id, name, email FROM users WHERE email = ? AND (deleted_at IS NULL AND status != 'deleted') AND id != ? LIMIT 1",
      [targetUser.email.trim().toLowerCase(), targetId]
    );
    if (conflictingActive.length > 0) {
      await conn.rollback();
      const conflictUser = conflictingActive[0];
      throw new ApiError(
        409,
        `Cannot restore account: an active user (#${conflictUser.id} - "${conflictUser.name || conflictUser.email}") is currently using the email "${targetUser.email}". The active account must be renamed, deactivated, or deleted before this archived account can be restored.`
      );
    }

    // Restore user
    try {
      await conn.query(
        `UPDATE users
         SET status = 'active',
             deleted_at = NULL,
             deleted_by = NULL,
             deletion_reason = NULL,
             restored_at = NOW(),
             restored_by = ?,
             restoration_reason = ?
         WHERE id = ?`,
        [req.user.id, reason, targetId]
      );
    } catch (restoreErr) {
      if (restoreErr.code === "ER_DUP_ENTRY") {
        await conn.rollback();
        throw new ApiError(
          409,
          `Cannot restore account: an active user is currently using the email "${targetUser.email}". The active account must be renamed, deactivated, or deleted before this archived account can be restored.`
        );
      }
      throw restoreErr;
    }

    // Also reactivate employees belonging to this business owner
    await conn.query(
      "UPDATE users SET status = 'active' WHERE created_by_admin = ?",
      [targetId]
    );

    // Audit logs
    await conn.query(
      `INSERT INTO user_audit_logs (superadmin_id, target_user_id, action, reason, details)
       VALUES (?, ?, 'restore_user', ?, ?)`,
      [
        req.user.id,
        targetId,
        reason,
        JSON.stringify({
          target_email: targetUser.email,
          target_name: targetUser.name,
          previous_status: targetUser.status,
          previous_deleted_at: targetUser.deleted_at,
        }),
      ]
    );

    try {
      await conn.query(
        `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
         VALUES (?, ?, 'RESTORE_USER', 'user', ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          req.user.role || "superadmin",
          String(targetId),
          JSON.stringify({ status: targetUser.status, deleted_at: targetUser.deleted_at }),
          JSON.stringify({ status: "active", restored_at: new Date() }),
          JSON.stringify({ reason, name: targetUser.name, email: targetUser.email }),
          req.ip || null,
        ]
      );
    } catch (_) {}

    await conn.commit();

    res.json({
      success: true,
      message: `User "${targetUser.name || targetUser.email}" has been successfully restored to active status.`,
      user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        status: "active",
        is_deleted: false,
      },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});


/*
 * ============================================================
 * OWNER CONSOLE - SELECTED USER DATA
 * Read-only access for Super Admin only.
 * Normal operational endpoints remain owner-scoped.
 * ============================================================
 */

const calculateUserReports = async (id, rangeFrom = null, rangeTo = null, period = null) => {
  const [
    customerResult,
    metrics,
    graphPoints,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?", [id]),
    calculateReportMetrics(id, rangeFrom, rangeTo),
    calculateGraphPoints(id, period || "last_6_months", rangeFrom, rangeTo),
  ]);

  const customerCount = Number(customerResult[0][0]?.count || 0);
  const creditEntries = metrics.creditEntriesCount;
  const debitEntries = metrics.debitEntriesCount;

  return {
    total_sales: metrics.totalSales,
    total_revenue: metrics.totalSales,
    sales: metrics.totalSales,
    purchases: metrics.totalPurchases,
    total_purchases: metrics.totalPurchases,
    expenses: metrics.totalExpenses,
    total_expenses: metrics.totalExpenses,
    total_expense: metrics.totalExpenses,
    due_received: 0,
    advance_receivable: metrics.advanceReceivable,
    investor_advance: metrics.advanceReceivable,
    advance_payable: metrics.advancePayable,
    cash_in_hand: metrics.cashInHand,
    cash_in_bank: metrics.cashInBank,
    net_profit: metrics.netProfit,
    profit_or_loss: metrics.netProfit,
    credit_entries: creditEntries,
    debit_entries: debitEntries,
    credit_entries_count: creditEntries,
    debit_entries_count: debitEntries,
    expenses_breakdown: {
      purchases: metrics.breakdown.purchases,
      debit_entries: metrics.breakdown.debit_entries,
      debit_entries_count: debitEntries,
      credit_entries: creditEntries,
      credit_entries_count: creditEntries,
      business_pay_out: metrics.breakdown.business_pay_out,
      advance_payable: metrics.breakdown.advance_payable,
      other_expenses: metrics.breakdown.other_expenses,
      direct_expenses: metrics.breakdown.other_expenses,
      khata_debits: metrics.breakdown.debit_entries,
      paid_out_payments: metrics.breakdown.business_pay_out,
      paid_by_business_payments: metrics.breakdown.business_pay_out,
      unlinked_khata_debits: metrics.breakdown.debit_entries,
      total_expense: metrics.totalExpenses,
    },
    breakdown: metrics.breakdown,
    sales_vs_expenses: {
      sales: metrics.totalSales,
      total_expense: metrics.totalExpenses,
      expenses: metrics.totalExpenses,
      purchases: metrics.totalPurchases,
      net_profit: metrics.netProfit,
    },
    total_customers: customerCount,
    monthly_business_performance: graphPoints,
    monthly_trend: graphPoints,
    graph: graphPoints,
    points: graphPoints,
    trend: graphPoints,
    sales_vs_expenses_graph: graphPoints,
    last_6_months: graphPoints,
  };
};

const getUserData = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const type = String(req.query.type || "").trim().toLowerCase();

  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );

  if (!userRows.length) {
    throw new ApiError(404, "User not found.");
  }

  // Delegated employee module access enforcement
  if (req.user.role === "employee") {
    let assigned = [];
    if (Array.isArray(req.user.assigned_modules)) assigned = req.user.assigned_modules;
    else if (typeof req.user.assigned_modules === "string") {
      try { assigned = JSON.parse(req.user.assigned_modules); } catch (_) { assigned = []; }
    }

    if (!assigned.includes("all")) {
      const moduleMap = {
        customers: "customers",
        khata: "khata",
        payments: "payments",
        "purchase-bills": "inventory",
        purchase_bills: "inventory",
        purchases: "inventory",
        inventory: "inventory",
        stock: "inventory",
        vehicles: "vehicles",
        invoices: "invoices",
        quotations: "invoices",
        "money-receipts": "invoices",
        reports: "reports",
        "reports-drilldown": "reports",
        drilldown: "reports",
        billing: "billing",
        subscriptions: "billing",
      };
      const requiredMod = moduleMap[type];
      const hasAccess = requiredMod && (
        assigned.includes(requiredMod) ||
        (type === "quotations" && (assigned.includes("quotations") || assigned.includes("invoices"))) ||
        (type === "money-receipts" && (assigned.includes("payments") || assigned.includes("invoices")))
      );
      if (!hasAccess) {
        throw new ApiError(403, `You do not have permission to view ${type.replace(/[-_]/g, " ")}.`);
      }
    }
  }

  let rows = [];

  switch (type) {
    case "customers": {
      const [result] = await pool.query(
        `SELECT c.*, u.name AS created_by_name
         FROM customers c
         LEFT JOIN users u ON u.id = c.created_by
         WHERE c.created_by = ?
         ORDER BY c.total_due DESC, c.name ASC`,
        [id]
      );
      rows = result;
      break;
    }

    case "khata": {
      const from = req.query.from || req.query.start_date || req.query.startDate;
      const to = req.query.to || req.query.end_date || req.query.endDate;
      const customerId = req.query.customer_id;
      const entryType = req.query.entry_type || req.query.entryType;

      let salesSql = `
        SELECT c.id, c.amount, c.sale_date AS date,
               TIME(c.created_at) AS time,
               c.created_at,
               COALESCE(cu.name, 'Walk-in') AS name,
               COALESCE(cu.name, 'Walk-in') AS party_name,
               COALESCE(cu.name, 'Walk-in') AS customer_name,
               CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
               CASE WHEN LOWER(COALESCE(c.payment_type, '')) = 'due' THEN 'due' ELSE 'credit' END AS type,
               c.payment_type AS payment_mode,
               c.payment_type,
               c.customer_id,
               c.item_name AS product_name,
               NULL AS product_id,
               NULL AS quantity,
               NULL AS unit_price,
               NULL AS items,
               0 AS is_linked_to_payment,
               NULL AS payment_id,
               'collection' AS source
        FROM collections c
        LEFT JOIN customers cu ON cu.id = c.customer_id
        WHERE c.created_by = ?
      `;
      const salesParams = [id];
      if (customerId) {
        salesSql += " AND c.customer_id = ?";
        salesParams.push(customerId);
      }
      if (from) {
        salesSql += " AND c.sale_date >= ?";
        salesParams.push(from);
      }
      if (to) {
        salesSql += " AND c.sale_date <= ?";
        salesParams.push(to);
      }

      let khataSql = `
        SELECT ke.id, ke.amount, ke.entry_date AS date,
               COALESCE(ke.entry_time, TIME(ke.created_at)) AS time,
               ke.created_at,
               COALESCE(cu.name, 'Walk-in') AS name,
               COALESCE(cu.name, 'Walk-in') AS party_name,
               COALESCE(cu.name, 'Walk-in') AS customer_name,
               ke.description,
               ke.type,
               COALESCE(ke.payment_mode, 'cash') AS payment_mode,
               COALESCE(ke.payment_mode, 'cash') AS payment_type,
               ke.customer_id,
               s.product_name,
               ke.product_id,
               ke.quantity,
               ke.unit_price,
               ke.items,
               ke.is_linked_to_payment,
               ke.payment_id,
               'khata_entry' AS source
        FROM khata_entries ke
        LEFT JOIN customers cu ON cu.id = ke.customer_id
        LEFT JOIN stock s ON s.id = ke.product_id
        WHERE ke.created_by = ?
      `;
      const khataParams = [id];
      if (customerId) {
        khataSql += " AND ke.customer_id = ?";
        khataParams.push(customerId);
      }
      if (from) {
        khataSql += " AND ke.entry_date >= ?";
        khataParams.push(from);
      }
      if (to) {
        khataSql += " AND ke.entry_date <= ?";
        khataParams.push(to);
      }

      let duesSql = `
        SELECT cd.id, cd.amount, cd.remaining_amount,
               COALESCE(cd.due_date, DATE(cd.created_at)) AS date,
               COALESCE(cd.due_time, TIME(cd.created_at)) AS time,
               cd.created_at,
               COALESCE(cu.name, 'Customer') AS name,
               COALESCE(cu.name, 'Customer') AS party_name,
               COALESCE(cu.name, 'Customer') AS customer_name,
               cd.description,
               'due' AS type,
               COALESCE(cd.payment_mode, 'credit') AS payment_mode,
               cd.status,
               cd.customer_id,
               s.product_name,
               cd.product_id,
               cd.quantity,
               cd.unit_price,
               cd.items,
               0 AS is_linked_to_payment,
               NULL AS payment_id,
               'customer_due' AS source
        FROM customer_dues cd
        LEFT JOIN customers cu ON cu.id = cd.customer_id
        LEFT JOIN stock s ON s.id = cd.product_id
        WHERE cd.created_by = ?
      `;
      const duesParams = [id];
      if (customerId) {
        duesSql += " AND cd.customer_id = ?";
        duesParams.push(customerId);
      }
      if (from) {
        duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) >= ?";
        duesParams.push(from);
      }
      if (to) {
        duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) <= ?";
        duesParams.push(to);
      }

      const [sales] = await pool.query(salesSql, salesParams);
      const [khataEntries] = await pool.query(khataSql, khataParams);
      const [dues] = await pool.query(duesSql, duesParams);

      rows = [...sales, ...khataEntries, ...dues];
      if (entryType && entryType !== "khata" && entryType !== "all") {
        const et = String(entryType).trim().toLowerCase();
        rows = rows.filter((r) => r.type === et || r.category === et);
      }
      rows.sort(
        (a, b) =>
          new Date(b.date) - new Date(a.date) ||
          new Date(b.created_at) - new Date(a.created_at)
      );
      break;
    }

    case "payments": {
      const from = req.query.from || req.query.start_date || req.query.startDate;
      const to = req.query.to || req.query.end_date || req.query.endDate;
      const customerId = req.query.customer_id;
      const cat = req.query.payment_category || req.query.category;

      let paySql = `
        SELECT p.*, u.name AS added_by, cu.name AS customer_name
        FROM payments p
        LEFT JOIN users u ON u.id = p.created_by
        LEFT JOIN customers cu ON cu.id = p.customer_id
        WHERE p.created_by = ?
      `;
      const payParams = [id];
      if (customerId) {
        paySql += " AND p.customer_id = ?";
        payParams.push(customerId);
      }
      if (from) {
        paySql += " AND p.payment_date >= ?";
        payParams.push(from);
      }
      if (to) {
        paySql += " AND p.payment_date <= ?";
        payParams.push(to);
      }
      if (cat) {
        paySql += " AND p.payment_category = ?";
        payParams.push(cat);
      }

      paySql += " ORDER BY p.payment_date DESC, p.created_at DESC";
      const [result] = await pool.query(paySql, payParams);
      rows = result;
      break;
    }

    case "purchase-bills":
    case "purchase_bills":
    case "purchases": {
      const from = req.query.from || req.query.start_date || req.query.startDate;
      const to = req.query.to || req.query.end_date || req.query.endDate;
      const isPaid = req.query.is_paid;

      let pbSql = `
        SELECT pb.*, u.name AS added_by,
               COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS payment_mode,
               p.payment_category,
               p.purpose AS payment_reference
        FROM purchase_bills pb
        LEFT JOIN users u ON u.id = pb.created_by
        LEFT JOIN payments p ON p.id = pb.payment_id
        WHERE pb.created_by = ?
      `;
      const pbParams = [id];
      if (from) {
        pbSql += " AND pb.bill_date >= ?";
        pbParams.push(from);
      }
      if (to) {
        pbSql += " AND pb.bill_date <= ?";
        pbParams.push(to);
      }
      if (isPaid !== undefined && isPaid !== null && isPaid !== "") {
        pbSql += " AND pb.is_paid = ?";
        pbParams.push(Number(isPaid) ? 1 : 0);
      }

      pbSql += " ORDER BY pb.bill_date DESC, pb.id DESC";
      const [billRows] = await pool.query(pbSql, pbParams);

      if (billRows.length) {
        const billIds = billRows.map((b) => b.id);
        const [itemRows] = await pool.query(
          `SELECT pbi.*, s.product_name AS linked_stock_name
           FROM purchase_bill_items pbi
           LEFT JOIN stock s ON s.id = pbi.product_id
           WHERE pbi.purchase_bill_id IN (?)
           ORDER BY pbi.id ASC`,
          [billIds]
        );

        const itemsByBill = {};
        for (const item of itemRows) {
          if (!itemsByBill[item.purchase_bill_id]) itemsByBill[item.purchase_bill_id] = [];
          itemsByBill[item.purchase_bill_id].push(item);
        }

        for (const bill of billRows) {
          bill.items = itemsByBill[bill.id] || [];
          bill.total_amount = Math.round(
            bill.items.reduce((acc, it) => {
              const qty = Number(it.quantity || 0);
              const pr = Number(it.price || 0);
              const disc = Number(it.discount || 0);
              const gst = Number(it.gst_rate || 0);
              const base = Math.max(0, qty * pr - disc);
              return acc + base * (1 + gst / 100);
            }, 0) * 100
          ) / 100;
        }
      }

      rows = billRows;
      break;
    }

    case "invoices":
    case "quotations": {
      const [result] = await pool.query(
        `SELECT
           i.*,
           COALESCE(i.to_name, c.name) AS customer_name,
           COALESCE(i.to_email, c.email) AS customer_email,
           COALESCE(i.to_phone, c.phone) AS customer_phone,
           u.name AS created_by_name
         FROM invoices i
         LEFT JOIN customers c
           ON c.id = i.customer_id
          AND c.created_by = i.created_by
         LEFT JOIN users u ON u.id = i.created_by
         WHERE i.doc_type = 'invoice'
           AND i.created_by = ?
         ORDER BY i.invoice_date DESC, i.id DESC`,
        [id]
      );

      const [quotationResult] = await pool.query(
        `SELECT
           q.*,
           'quotation' AS doc_type,
           q.quotation_number AS invoice_number,
           q.quotation_date AS invoice_date,
           COALESCE(q.to_name, c.name) AS customer_name,
           COALESCE(q.to_email, c.email) AS customer_email,
           COALESCE(q.to_phone, c.phone) AS customer_phone,
           u.name AS created_by_name
         FROM quotations q
         LEFT JOIN customers c
           ON c.id = q.customer_id
          AND c.created_by = q.created_by
         LEFT JOIN users u ON u.id = q.created_by
         WHERE q.created_by = ?
         ORDER BY q.quotation_date DESC, q.id DESC`,
        [id]
      );

      rows = type === "invoices" ? result : quotationResult;
      break;
    }

    case "money-receipts": {
      const [result] = await pool.query(
        `SELECT
           mr.*,
           COALESCE(mr.received_from_name, c.name) AS customer_name,
           c.email AS customer_email,
           c.phone AS customer_phone,
           u.name AS created_by_name
         FROM money_receipts mr
         LEFT JOIN customers c ON c.id = mr.customer_id
         LEFT JOIN users u ON u.id = mr.created_by
         WHERE mr.created_by = ?
         ORDER BY mr.receipt_date DESC, mr.id DESC`,
        [id]
      );
      rows = result;
      break;
    }

    case "expenses": {
      const [result] = await pool.query(
        `SELECT e.*, u.name AS added_by
         FROM expenses e
         LEFT JOIN users u ON u.id = e.created_by
         WHERE e.created_by = ?
         ORDER BY e.expense_date DESC, e.created_at DESC`,
        [id]
      );
      rows = result;
      break;
    }

    case "stock":
    case "inventory": {
      const [result] = await pool.query(
        `SELECT s.*,
                u.name AS added_by,
                CASE
                  WHEN COALESCE(s.quantity, 0) <= 0 THEN 'out_of_stock'
                  WHEN COALESCE(s.quantity, 0) <= 10 THEN 'low_stock'
                  ELSE 'in_stock'
                END AS stock_status
         FROM stock s
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.created_by = ?
         ORDER BY s.product_name ASC`,
        [id]
      );
      rows = result;
      break;
    }

    case "vehicles": {
      const [result] = await pool.query(
        `SELECT v.*, u.name AS added_by
         FROM vehicle_trips v
         LEFT JOIN users u ON u.id = v.created_by
         WHERE v.created_by = ?
         ORDER BY v.created_at DESC`,
        [id]
      );
      rows = result;
      break;
    }

    case "reports": {
      const from = req.query.from || req.query.start_date || req.query.startDate;
      const to = req.query.to || req.query.end_date || req.query.endDate;
      const period = req.query.period || req.query.timeframe || req.query.range;
      const range = resolvePeriodRange(period, from, to);
      const reports = await calculateUserReports(id, range.from, range.to, period);
      return res.json({
        success: true,
        user: userRows[0],
        type: "reports",
        period: period || "all-time",
        range: { from: range.from || "all-time", to: range.to || "all-time" },
        reports,
      });
    }

    case "reports-drilldown":
    case "drilldown": {
      const metricParam = (req.query.metric || req.params.metric || "").trim().toLowerCase();
      const categoryParam = (req.query.category || req.query.sub_metric || req.query.subMetric || "").trim().toLowerCase();
      const from = req.query.from || req.query.start_date || req.query.startDate;
      const to = req.query.to || req.query.end_date || req.query.endDate;
      const period = req.query.period || req.query.timeframe || req.query.range;
      const result = await executeReportDrilldown(id, metricParam, period, from, to, categoryParam);
      return res.json({
        ...result,
        user: userRows[0],
      });
    }

    case "billing":
    case "subscriptions": {
      const [subscriptions] = await pool.query(
        `SELECT s.*, p.name AS plan_name, p.code AS plan_code
         FROM subscriptions s
         LEFT JOIN subscription_plans p ON s.plan_id = p.id
         WHERE s.user_id = ?
         ORDER BY s.ends_at DESC`,
        [id]
      );
      const [orders] = await pool.query(
        `SELECT so.*, p.name AS plan_name
         FROM subscription_orders so
         LEFT JOIN subscription_plans p ON so.plan_id = p.id
         WHERE so.user_id = ?
         ORDER BY so.created_at DESC`,
        [id]
      );
      const now = new Date();
      const activeSub = subscriptions.find((s) => s.status === "active" && new Date(s.ends_at) > now) || null;
      return res.json({
        success: true,
        user: userRows[0],
        type: "billing",
        activeSubscription: activeSub,
        subscriptions,
        orders,
        records: orders,
        data: orders,
        count: orders.length,
      });
    }

    default:
      throw new ApiError(
        400,
        "Invalid data type. Use customers, khata, payments, purchase-bills, invoices, quotations, money-receipts, inventory, vehicles, reports, or billing."
      );
  }

  res.json({
    success: true,
    user: userRows[0],
    type,
    count: rows.length,
    [type === "money-receipts" ? "receipts" : type]: rows,
    records: rows,
    data: rows,
    purchase_bills: rows,
    purchaseBills: rows,
    bills: rows,
    khata: rows,
    entries: rows,
    ledger: rows,
  });
});

/*
 * ============================================================
 * OWNER CONSOLE - SELECTED USER RECORD
 * Read-only access for Super Admin only.
 * ============================================================
 */

const getUserRecord = asyncHandler(async (req, res) => {
  const { id, recordId } = req.params;
  await checkTenantAccess(req.user, id);
  const type = String(req.query.type || "").trim().toLowerCase();

  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );

  if (!userRows.length) {
    throw new ApiError(404, "User not found.");
  }

  let record;
  let items = [];

  if (type === "customer") {
    const [rows] = await pool.query(
      "SELECT * FROM customers WHERE id = ? AND created_by = ?",
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Customer not found.");
    }

    const [sales] = await pool.query(
      `SELECT id, item_name, amount, payment_type, sale_date, created_at
       FROM collections
       WHERE customer_id = ? AND created_by = ?
       ORDER BY sale_date DESC, created_at DESC`,
      [recordId, id]
    );

    const [payments] = await pool.query(
      `SELECT id, amount, payment_mode, purpose, payment_date, created_at
       FROM payments
       WHERE customer_id = ?
         AND created_by = ?
         AND payment_category = 'due_received'
       ORDER BY payment_date DESC, created_at DESC`,
      [recordId, id]
    );

    record = rows[0];

    res.json({
      success: true,
      user: userRows[0],
      type,
      customer: record,
      sales_history: sales,
      due_payments_history: payments,
    });
    return;
  }

  if (type === "invoice") {
    const [rows] = await pool.query(
      `SELECT
         i.*,
         c.name AS customer_name,
         c.phone AS customer_phone,
         c.email AS customer_email
       FROM invoices i
       LEFT JOIN customers c
         ON c.id = i.customer_id
        AND c.created_by = i.created_by
       WHERE i.id = ?
         AND i.created_by = ?
         AND i.doc_type = 'invoice'`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Invoice not found.");
    }

    const [itemRows] = await pool.query(
      `SELECT *
       FROM invoice_items
       WHERE invoice_id = ?
       ORDER BY id ASC`,
      [recordId]
    );

    record = rows[0];
    items = itemRows;
  } else if (type === "quotation") {
    const [rows] = await pool.query(
      `SELECT
         q.*,
         'quotation' AS doc_type,
         q.quotation_number AS invoice_number,
         q.quotation_date AS invoice_date,
         c.name AS customer_name,
         c.phone AS customer_phone,
         c.email AS customer_email
       FROM quotations q
       LEFT JOIN customers c
         ON c.id = q.customer_id
        AND c.created_by = q.created_by
       WHERE q.id = ?
         AND q.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Quotation not found.");
    }

    const [itemRows] = await pool.query(
      `SELECT *
       FROM quotation_items
       WHERE quotation_id = ?
       ORDER BY id ASC`,
      [recordId]
    );

    record = rows[0];
    items = itemRows;
  } else if (type === "money-receipt") {
    const [rows] = await pool.query(
      `SELECT
         mr.*,
         c.name AS customer_name,
         c.phone AS customer_phone,
         c.email AS customer_email
       FROM money_receipts mr
       LEFT JOIN customers c
         ON c.id = mr.customer_id
        AND c.created_by = mr.created_by
       WHERE mr.id = ?
         AND mr.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Money receipt not found.");
    }

    const [allocationRows] = await pool.query(
      `SELECT
         mra.*,
         i.invoice_number,
         i.total_amount
       FROM money_receipt_allocations mra
       JOIN invoices i
         ON i.id = mra.invoice_id
        AND i.created_by = ?
       WHERE mra.money_receipt_id = ?
       ORDER BY mra.id ASC`,
      [id, recordId]
    );

    record = rows[0];
    items = allocationRows;
  } else if (type === "payment") {
    const [rows] = await pool.query(
      `SELECT
         p.*,
         u.name AS added_by,
         cu.name AS customer_name
       FROM payments p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.id = ?
         AND p.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Payment not found.");
    }

    record = rows[0];
  } else if (type === "expense") {
    const [rows] = await pool.query(
      `SELECT
         e.*,
         u.name AS added_by
       FROM expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = ?
         AND e.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Expense not found.");
    }

    record = rows[0];
  } else if (type === "inventory") {
    const [rows] = await pool.query(
      `SELECT
         s.*,
         u.name AS added_by
       FROM stock s
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.id = ?
         AND s.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Inventory item not found.");
    }

    record = rows[0];
  } else if (type === "vehicle") {
    const [rows] = await pool.query(
      `SELECT
         v.*,
         u.name AS added_by
       FROM vehicle_trips v
       LEFT JOIN users u ON u.id = v.created_by
       WHERE v.id = ?
         AND v.created_by = ?`,
      [recordId, id]
    );

    if (!rows.length) {
      throw new ApiError(404, "Vehicle trip not found.");
    }

    record = rows[0];
  } else if (
    type === "purchase-bill" ||
    type === "purchase_bill" ||
    type === "purchase-bills" ||
    type === "purchase_bills" ||
    type === "purchases"
  ) {
    const [pbRows] = await pool.query(
      `SELECT pb.*, u.name AS added_by,
              COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS payment_mode,
              p.payment_category,
              p.purpose AS payment_reference
       FROM purchase_bills pb
       LEFT JOIN users u ON u.id = pb.created_by
       LEFT JOIN payments p ON p.id = pb.payment_id
       WHERE pb.id = ? AND pb.created_by = ?`,
      [recordId, id]
    );

    if (!pbRows.length) {
      throw new ApiError(404, "Purchase bill not found.");
    }

    const [itemRows] = await pool.query(
      `SELECT pbi.*, s.product_name AS linked_stock_name
       FROM purchase_bill_items pbi
       LEFT JOIN stock s ON s.id = pbi.product_id
       WHERE pbi.purchase_bill_id = ?
       ORDER BY pbi.id ASC`,
      [recordId]
    );

    record = pbRows[0];
    items = itemRows;
    const enrichedItems = itemRows.map((it) => {
      const qty = Number(it.quantity || 0);
      const price = Number(it.price || 0);
      const discount = Number(it.discount || 0);
      const gstRate = Number(it.gst_rate || 0);
      const taxable = Math.max(0, qty * price - discount);
      const gstAmt = Math.round(((taxable * gstRate) / 100) * 100) / 100;
      const totalAmt = Math.round((taxable + gstAmt) * 100) / 100;
      return {
        ...it,
        taxable_amount: taxable,
        gst_amount: gstAmt,
        total_amount: totalAmt,
      };
    });
    const totalAmount = Math.round(enrichedItems.reduce((acc, it) => acc + it.total_amount, 0) * 100) / 100;
    record.items = enrichedItems;
    record.total_amount = totalAmount;
    record.item_names = enrichedItems.map((i) => i.item_name).filter(Boolean).join(", ");
  } else if (
    type === "khata" ||
    type === "khata-entry" ||
    type === "khata_entry" ||
    type === "khata-entries" ||
    type === "khata_entries" ||
    type === "collection" ||
    type === "customer_due" ||
    type === "due"
  ) {
    const sourceParam = String(req.query.source || "").toLowerCase().trim();

    const fetchKe = async () => {
      const [rows] = await pool.query(
        `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
                s.product_name
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         LEFT JOIN stock s ON s.id = ke.product_id
         WHERE ke.id = ? AND ke.created_by = ?`,
        [recordId, id]
      );
      if (rows.length) {
        return {
          ...rows[0],
          entry_type: rows[0].type,
          source: "khata_entry",
        };
      }
      return null;
    };

    const fetchDue = async () => {
      const [rows] = await pool.query(
        `SELECT cd.*, cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
                s.product_name
         FROM customer_dues cd
         LEFT JOIN customers cu ON cu.id = cd.customer_id
         LEFT JOIN stock s ON s.id = cd.product_id
         WHERE cd.id = ? AND cd.created_by = ?`,
        [recordId, id]
      );
      if (rows.length) {
        return {
          ...rows[0],
          type: "due",
          entry_type: "due",
          source: "customer_due",
        };
      }
      return null;
    };

    const fetchCol = async () => {
      const [rows] = await pool.query(
        `SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email
         FROM collections c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         WHERE c.id = ? AND c.created_by = ?`,
        [recordId, id]
      );
      if (rows.length) {
        const isDue = String(rows[0].payment_type || "").toLowerCase() === "due";
        return {
          ...rows[0],
          type: isDue ? "due" : "credit",
          entry_type: isDue ? "due" : "credit",
          source: "collection",
        };
      }
      return null;
    };

    if (sourceParam === "collection" || type === "collection") {
      record = (await fetchCol()) || (await fetchKe()) || (await fetchDue());
    } else if (sourceParam === "customer_due" || type === "customer_due" || type === "due") {
      record = (await fetchDue()) || (await fetchKe()) || (await fetchCol());
    } else if (sourceParam === "khata_entry" || type === "khata_entry" || type === "khata-entry") {
      record = (await fetchKe()) || (await fetchDue()) || (await fetchCol());
    } else {
      record = (await fetchKe()) || (await fetchDue()) || (await fetchCol());
    }

    if (!record) {
      throw new ApiError(404, "Khata record not found.");
    }
  } else {
    throw new ApiError(
      400,
      "Invalid record type."
    );
  }

  res.json({
    success: true,
    user: userRows[0],
    type,
    record,
    items,
  });
});

/*
 * ============================================================
 * DEDICATED SELECTED USER BUSINESS DATA ENDPOINTS
 * Scoped strictly to the selected user (:id)
 * ============================================================
 */

const getUserCustomers = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT c.*, u.name AS created_by_name
     FROM customers c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.created_by = ?
     ORDER BY c.total_due DESC, c.name ASC`,
    [id]
  );

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    customers: rows,
  });
});

const getUserKhata = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  let { customer_id, from, to, start_date, startDate, end_date, endDate, type, period, timeframe, range } = req.query;
  from = from || start_date || startDate;
  to = to || end_date || endDate;
  const resolvedPeriod = period || timeframe || range;
  if (resolvedPeriod && (!from || !to)) {
    const boundaries = resolvePeriodRange(resolvedPeriod);
    if (boundaries.from && !from) from = boundaries.from;
    if (boundaries.to && !to) to = boundaries.to;
  }

  // 1. Collections (sales)
  let salesSql = `
    SELECT c.id, c.amount, c.sale_date AS date,
           TIME(c.created_at) AS time,
           c.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           COALESCE(cu.name, 'Walk-in') AS party_name,
           COALESCE(cu.name, 'Walk-in') AS customer_name,
           CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
           CASE WHEN LOWER(COALESCE(c.payment_type, '')) = 'due' THEN 'due' ELSE 'credit' END AS type,
           c.payment_type AS payment_mode,
           c.payment_type,
           c.customer_id,
           c.item_name AS product_name,
           NULL AS product_id,
           NULL AS quantity,
           NULL AS unit_price,
           NULL AS items,
           0 AS is_linked_to_payment,
           NULL AS payment_id,
           'collection' AS source
    FROM collections c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.created_by = ?
  `;
  const salesParams = [id];
  if (customer_id) {
    salesSql += " AND c.customer_id = ?";
    salesParams.push(customer_id);
  }
  if (from) {
    salesSql += " AND c.sale_date >= ?";
    salesParams.push(from);
  }
  if (to) {
    salesSql += " AND c.sale_date <= ?";
    salesParams.push(to);
  }

  // 2. Khata entries (Credit & Debit)
  let khataSql = `
    SELECT ke.id, ke.amount, ke.entry_date AS date,
           COALESCE(ke.entry_time, TIME(ke.created_at)) AS time,
           ke.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           COALESCE(cu.name, 'Walk-in') AS party_name,
           COALESCE(cu.name, 'Walk-in') AS customer_name,
           ke.description,
           ke.type,
           COALESCE(ke.payment_mode, 'cash') AS payment_mode,
           COALESCE(ke.payment_mode, 'cash') AS payment_type,
           ke.customer_id,
           s.product_name,
           ke.product_id,
           ke.quantity,
           ke.unit_price,
           ke.items,
           ke.is_linked_to_payment,
           ke.payment_id,
           'khata_entry' AS source
    FROM khata_entries ke
    LEFT JOIN customers cu ON cu.id = ke.customer_id
    LEFT JOIN stock s ON s.id = ke.product_id
    WHERE ke.created_by = ?
  `;
  const khataParams = [id];
  if (customer_id) {
    khataSql += " AND ke.customer_id = ?";
    khataParams.push(customer_id);
  }
  if (from) {
    khataSql += " AND ke.entry_date >= ?";
    khataParams.push(from);
  }
  if (to) {
    khataSql += " AND ke.entry_date <= ?";
    khataParams.push(to);
  }

  // 3. Customer Dues
  let duesSql = `
    SELECT cd.id, cd.amount, cd.remaining_amount,
           COALESCE(cd.due_date, DATE(cd.created_at)) AS date,
           COALESCE(cd.due_time, TIME(cd.created_at)) AS time,
           cd.created_at,
           COALESCE(cu.name, 'Customer') AS name,
           COALESCE(cu.name, 'Customer') AS party_name,
           COALESCE(cu.name, 'Customer') AS customer_name,
           cd.description,
           'due' AS type,
           COALESCE(cd.payment_mode, 'credit') AS payment_mode,
           cd.status,
           cd.customer_id,
           s.product_name,
           cd.product_id,
           cd.quantity,
           cd.unit_price,
           cd.items,
           0 AS is_linked_to_payment,
           NULL AS payment_id,
           'customer_due' AS source
    FROM customer_dues cd
    LEFT JOIN customers cu ON cu.id = cd.customer_id
    LEFT JOIN stock s ON s.id = cd.product_id
    WHERE cd.created_by = ?
  `;
  const duesParams = [id];
  if (customer_id) {
    duesSql += " AND cd.customer_id = ?";
    duesParams.push(customer_id);
  }
  if (from) {
    duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) >= ?";
    duesParams.push(from);
  }
  if (to) {
    duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) <= ?";
    duesParams.push(to);
  }

  const [sales] = await pool.query(salesSql, salesParams);
  const [khataRows] = await pool.query(khataSql, khataParams);
  const [dues] = await pool.query(duesSql, duesParams);

  const normalizedSales = sales.map((row) => ({
    ...row,
    type: "credit",
    category: "credit",
    is_credit: true,
    is_debit: false,
    is_due: false,
    signed_amount: Number(row.amount || 0),
  }));

  const normalizedKhata = khataRows.map((row) => {
    const isDebit = String(row.type).toLowerCase() === "debit";
    const amt = Number(row.amount || 0);
    return {
      ...row,
      type: isDebit ? "debit" : "credit",
      category: isDebit ? "debit" : "credit",
      is_debit: isDebit,
      is_credit: !isDebit,
      is_due: false,
      signed_amount: isDebit ? -amt : amt,
    };
  });

  const normalizedDues = dues.map((row) => ({
    ...row,
    type: "due",
    category: "due",
    is_due: true,
    is_debit: false,
    is_credit: false,
    signed_amount: Number(row.amount || 0),
  }));

  let entries = [...normalizedSales, ...normalizedKhata, ...normalizedDues];
  if (type) {
    const t = String(type).trim().toLowerCase();
    entries = entries.filter((e) => e.type === t || e.category === t);
  }

  entries.sort(
    (a, b) =>
      new Date(b.date) - new Date(a.date) ||
      new Date(b.created_at) - new Date(a.created_at)
  );

  let totalCredit = 0;
  let totalDebit = 0;
  let totalDue = 0;

  for (const entry of entries) {
    const amt = Number(entry.amount || 0);
    if (entry.is_credit) totalCredit += amt;
    else if (entry.is_debit) totalDebit += amt;
    else if (entry.is_due) totalDue += amt;
  }

  totalCredit = Math.round(totalCredit * 100) / 100;
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalDue = Math.round(totalDue * 100) / 100;
  const netBalance = Math.round((totalCredit - totalDebit) * 100) / 100;

  res.json({
    success: true,
    user: userRows[0],
    count: entries.length,
    total_credit: totalCredit,
    total_debit: totalDebit,
    total_due: totalDue,
    net_balance: netBalance,
    summary: {
      total_credit: totalCredit,
      total_debit: totalDebit,
      total_due: totalDue,
      net_balance: netBalance,
    },
    dashboard: {
      total_credit: totalCredit,
      total_debit: totalDebit,
      total_due: totalDue,
      net_balance: netBalance,
    },
    entries,
    khata: entries,
    ledger: entries,
    data: entries,
  });
});

const getUserPayments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  let { customer_id, from, to, start_date, startDate, end_date, endDate, type, payment_type, payment_category } = req.query;
  from = from || start_date || startDate;
  to = to || end_date || endDate;
  const cat = type || payment_type || payment_category;

  let sql = `
    SELECT p.*, u.name AS added_by, cu.name AS customer_name
    FROM payments p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN customers cu ON cu.id = p.customer_id
    WHERE p.created_by = ?
  `;
  const params = [id];

  if (customer_id) {
    sql += " AND p.customer_id = ?";
    params.push(customer_id);
  }
  if (from) {
    sql += " AND p.payment_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND p.payment_date <= ?";
    params.push(to);
  }
  if (cat) {
    sql += " AND p.payment_category = ?";
    params.push(cat);
  }

  sql += " ORDER BY p.payment_date DESC, p.created_at DESC";

  const [rows] = await pool.query(sql, params);

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    payments: rows,
    data: rows,
  });
});

const getUserPurchaseBills = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  let { from, to, start_date, startDate, end_date, endDate, is_paid } = req.query;
  from = from || start_date || startDate;
  to = to || end_date || endDate;

  let sql = `
    SELECT pb.*, u.name AS added_by,
           COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS payment_mode,
           p.payment_category,
           p.purpose AS payment_reference
    FROM purchase_bills pb
    LEFT JOIN users u ON u.id = pb.created_by
    LEFT JOIN payments p ON p.id = pb.payment_id
    WHERE pb.created_by = ?
  `;
  const params = [id];

  if (from) {
    sql += " AND pb.bill_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND pb.bill_date <= ?";
    params.push(to);
  }
  if (is_paid !== undefined && is_paid !== null && is_paid !== "") {
    sql += " AND pb.is_paid = ?";
    params.push(Number(is_paid) ? 1 : 0);
  }

  sql += " ORDER BY pb.bill_date DESC, pb.id DESC";

  const [billRows] = await pool.query(sql, params);

  if (billRows.length) {
    const billIds = billRows.map((b) => b.id);
    const [itemRows] = await pool.query(
      `SELECT pbi.*, s.product_name AS linked_stock_name
       FROM purchase_bill_items pbi
       LEFT JOIN stock s ON s.id = pbi.product_id
       WHERE pbi.purchase_bill_id IN (?)
       ORDER BY pbi.id ASC`,
      [billIds]
    );

    const itemsByBill = {};
    for (const item of itemRows) {
      if (!itemsByBill[item.purchase_bill_id]) itemsByBill[item.purchase_bill_id] = [];
      itemsByBill[item.purchase_bill_id].push(item);
    }

    for (const bill of billRows) {
      bill.items = itemsByBill[bill.id] || [];
      bill.total_amount = Math.round(
        bill.items.reduce((acc, it) => {
          const qty = Number(it.quantity || 0);
          const pr = Number(it.price || 0);
          const disc = Number(it.discount || 0);
          const gst = Number(it.gst_rate || 0);
          const base = Math.max(0, qty * pr - disc);
          return acc + base * (1 + gst / 100);
        }, 0) * 100
      ) / 100;
    }
  }

  res.json({
    success: true,
    user: userRows[0],
    count: billRows.length,
    purchase_bills: billRows,
    purchaseBills: billRows,
    bills: billRows,
    data: billRows,
  });
});

const getUserReportDrilldown = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const metricParam = (req.params.metric || req.query.metric || "").trim().toLowerCase();
  const categoryParam = (req.query.category || req.query.sub_metric || req.query.subMetric || "").trim().toLowerCase();
  const from = req.query.from || req.query.start_date || req.query.startDate;
  const to = req.query.to || req.query.end_date || req.query.endDate;
  const period = req.query.period || req.query.timeframe || req.query.range;

  const result = await executeReportDrilldown(id, metricParam, period, from, to, categoryParam);
  res.json({
    ...result,
    user: userRows[0],
  });
});

const getUserInventory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT s.*, u.name AS added_by
     FROM stock s
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.created_by = ?
     ORDER BY s.product_name ASC`,
    [id]
  );

  const enriched = rows.map((item) => {
    const isInclusive = Boolean(
      item.price_inclusive_gst === 1 ||
      item.price_inclusive_gst === true ||
      item.price_inclusive_gst === "1"
    );
    const enteredPrice = Math.max(0, Number(item.price || 0));
    const rate = Math.max(0, Number(item.gst_rate || 0));

    let basePrice = 0;
    let gstAmount = 0;
    let totalPrice = 0;

    if (isInclusive) {
      basePrice = rate > 0 ? enteredPrice / (1 + rate / 100) : enteredPrice;
      gstAmount = enteredPrice - basePrice;
      totalPrice = enteredPrice;
    } else {
      basePrice = enteredPrice;
      gstAmount = (basePrice * rate) / 100;
      totalPrice = basePrice + gstAmount;
    }

    const qty = Number(item.quantity || 0);
    let stockStatus = "out_of_stock";
    let statusLabel = "Out of Stock";
    if (qty > 10) {
      stockStatus = "in_stock";
      statusLabel = "In Stock";
    } else if (qty > 0 && qty <= 10) {
      stockStatus = "low_stock";
      statusLabel = "Low Stock";
    }

    return {
      ...item,
      price_inclusive_gst: isInclusive ? 1 : 0,
      base_price: Math.round(basePrice * 100) / 100,
      gst_amount: Math.round(gstAmount * 100) / 100,
      total_price: Math.round(totalPrice * 100) / 100,
      stock_status: stockStatus,
      status_label: statusLabel,
    };
  });

  res.json({
    success: true,
    user: userRows[0],
    count: enriched.length,
    stock: enriched,
    inventory: enriched,
  });
});

const getUserVehicles = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT v.*, u.name AS added_by
     FROM vehicle_trips v
     LEFT JOIN users u ON u.id = v.created_by
     WHERE v.created_by = ?
     ORDER BY v.created_at DESC`,
    [id]
  );

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    vehicles: rows,
    trips: rows,
  });
});

const getUserReports = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const from = req.query.from || req.query.start_date || req.query.startDate;
  const to = req.query.to || req.query.end_date || req.query.endDate;
  const period = req.query.period || req.query.timeframe || req.query.range;
  const range = resolvePeriodRange(period, from, to);
  const reports = await calculateUserReports(id, range.from, range.to, period);

  res.json({
    success: true,
    user: userRows[0],
    period: period || "all-time",
    range: { from: range.from || "all-time", to: range.to || "all-time" },
    reports,
  });
});

const getUserReportGraph = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const from = req.query.from || req.query.start_date || req.query.startDate;
  const to = req.query.to || req.query.end_date || req.query.endDate;
  const period = req.query.period || req.query.timeframe || req.query.range;
  const monthsParam = Number(req.query.months);

  let p = period ? String(period).trim().toLowerCase() : "";
  if (!p) {
    if (monthsParam === 12) p = "last_12_months";
    else if (from || to) p = "custom";
    else p = "last_6_months";
  }

  const points = await calculateGraphPoints(id, p, from, to);

  res.json({
    success: true,
    user: userRows[0],
    period: p,
    points,
    trend: points,
    graph: points,
    sales_vs_expenses: points,
  });
});

const deleteUserCustomer = asyncHandler(async (req, res) => {
  const { id: userId, customerId } = req.params;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT id, name FROM customers WHERE id = ? AND created_by = ?",
      [customerId, userId]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Customer not found for this user.");
    }

    const customer = rows[0];

    await conn.query("UPDATE collections SET customer_id = NULL WHERE customer_id = ?", [customerId]);
    await conn.query("UPDATE payments SET customer_id = NULL WHERE customer_id = ?", [customerId]);
    await conn.query("UPDATE invoices SET customer_id = NULL WHERE customer_id = ?", [customerId]);
    await conn.query("UPDATE quotations SET customer_id = NULL WHERE customer_id = ?", [customerId]);
    await conn.query("UPDATE money_receipts SET customer_id = NULL WHERE customer_id = ?", [customerId]);
    await conn.query("DELETE FROM customer_dues WHERE customer_id = ?", [customerId]);
    await conn.query("DELETE FROM customers WHERE id = ? AND created_by = ?", [customerId, userId]);

    await conn.commit();

    res.json({
      success: true,
      message: `Customer "${customer.name || customerId}" deleted successfully.`,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

const getUserInvoices = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT i.*,
            COALESCE(i.to_name, c.name) AS customer_name,
            COALESCE(i.to_email, c.email) AS customer_email,
            COALESCE(i.to_phone, c.phone) AS customer_phone,
            u.name AS created_by_name
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id AND c.created_by = i.created_by
     LEFT JOIN users u ON u.id = i.created_by
     WHERE i.doc_type = 'invoice' AND i.created_by = ?
     ORDER BY i.invoice_date DESC, i.id DESC`,
    [id]
  );

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    invoices: rows,
    records: rows,
    data: rows,
  });
});

const getUserQuotations = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT q.*,
            'quotation' AS doc_type,
            q.quotation_number AS invoice_number,
            q.quotation_date AS invoice_date,
            COALESCE(q.to_name, c.name) AS customer_name,
            COALESCE(q.to_email, c.email) AS customer_email,
            COALESCE(q.to_phone, c.phone) AS customer_phone,
            u.name AS created_by_name
     FROM quotations q
     LEFT JOIN customers c ON c.id = q.customer_id AND c.created_by = q.created_by
     LEFT JOIN users u ON u.id = q.created_by
     WHERE q.created_by = ?
     ORDER BY q.quotation_date DESC, q.id DESC`,
    [id]
  );

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    quotations: rows,
    records: rows,
    data: rows,
  });
});

const getUserMoneyReceipts = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [rows] = await pool.query(
    `SELECT mr.*,
            COALESCE(mr.received_from_name, c.name) AS customer_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            u.name AS created_by_name
     FROM money_receipts mr
     LEFT JOIN customers c ON c.id = mr.customer_id
     LEFT JOIN users u ON u.id = mr.created_by
     WHERE mr.created_by = ?
     ORDER BY mr.receipt_date DESC, mr.id DESC`,
    [id]
  );

  res.json({
    success: true,
    user: userRows[0],
    count: rows.length,
    receipts: rows,
    money_receipts: rows,
    records: rows,
    data: rows,
  });
});

const getUserBilling = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await checkTenantAccess(req.user, id);
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [subscriptions] = await pool.query(
    `SELECT s.*, p.name AS plan_name, p.code AS plan_code
     FROM subscriptions s
     LEFT JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.user_id = ?
     ORDER BY s.ends_at DESC`,
    [id]
  );

  const [orders] = await pool.query(
    `SELECT so.*, p.name AS plan_name
     FROM subscription_orders so
     LEFT JOIN subscription_plans p ON so.plan_id = p.id
     WHERE so.user_id = ?
     ORDER BY so.created_at DESC`,
    [id]
  );

  const now = new Date();
  const activeSub = subscriptions.find((s) => s.status === "active" && new Date(s.ends_at) > now) || null;

  res.json({
    success: true,
    user: userRows[0],
    activeSubscription: activeSub,
    subscriptions,
    orders,
    records: orders,
    data: orders,
    count: orders.length,
  });
});

// GET /api/superadmin/audit-logs
const listAuditLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const {
    actor_id,
    target_type,
    action,
    startDate,
    endDate,
    search,
  } = req.query;

  let whereClauses = ["1=1"];
  const params = [];

  if (actor_id) {
    whereClauses.push("a.actor_id = ?");
    params.push(actor_id);
  }

  if (target_type) {
    whereClauses.push("a.target_type = ?");
    params.push(target_type);
  }

  if (action) {
    whereClauses.push("a.action = ?");
    params.push(action);
  }

  if (startDate) {
    whereClauses.push("a.created_at >= ?");
    params.push(new Date(startDate).toISOString().slice(0, 19).replace("T", " "));
  }

  if (endDate) {
    whereClauses.push("a.created_at <= ?");
    params.push(new Date(endDate).toISOString().slice(0, 19).replace("T", " "));
  }

  if (search) {
    whereClauses.push("(a.action LIKE ? OR a.target_type LIKE ? OR a.target_id LIKE ? OR CAST(a.details AS CHAR) LIKE ? OR u.name LIKE ? OR u.email LIKE ?)");
    const term = `%${search}%`;
    params.push(term, term, term, term, term, term);
  }

  const whereSql = whereClauses.join(" AND ");

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM admin_audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE ${whereSql}`,
    params
  );
  const total = countRows[0]?.total || 0;

  const [logs] = await pool.query(
    `SELECT a.id, a.actor_id, a.actor_role, a.action, a.target_type, a.target_id,
            a.before_value, a.after_value, a.details, a.ip_address, a.created_at,
            u.name AS actor_name, u.email AS actor_email, u.phone AS actor_phone
     FROM admin_audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  res.json({
    success: true,
    data: logs,
    audit_logs: logs,
    logs,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  });
});

module.exports = {
  getUserRecord,
  getUserData,
  getUserCustomers,
  getUserKhata,
  getUserInventory,
  getUserVehicles,
  getUserReports,
  getUserReportGraph,
  getUserPayments,
  getUserPurchaseBills,
  getUserInvoices,
  getUserQuotations,
  getUserMoneyReceipts,
  getUserBilling,
  getUserReportDrilldown,
  deleteUserCustomer,
  listUsers,
  getUser,
  getUserOverview,
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  setUserStatus,
  updateUser,
  deleteUser,
  restoreUser,
  listAuditLogs,
};
