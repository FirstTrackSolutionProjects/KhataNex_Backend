const bcrypt = require("bcrypt");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");

const ALLOWED_EMPLOYEE_PERMISSIONS = [
  "support_chat",
  "view_basic_user",
  "create_invoice",
  "create_quotation",
  "create_receipt",
  "view_khata",
  "view_payments",
  "manage_payments",
  "manage_inventory",
  "manage_vehicles",
  "create_employee",
  "edit_employee",
  "manage_employee_permissions",
];

const normalizePermissions = (permissions) => {
  if (permissions === undefined || permissions === null) return null;

  let value = permissions;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err) {
      throw new ApiError(400, "permissions must be a valid JSON array.");
    }
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, "permissions must be an array.");
  }

  const unique = [...new Set(value)];
  const invalid = unique.filter((permission) => !ALLOWED_EMPLOYEE_PERMISSIONS.includes(permission));

  if (invalid.length) {
    throw new ApiError(400, "Invalid employee permission(s): " + invalid.join(", "));
  }

  return unique;
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

// GET /api/superadmin/users
// Full overview of every user account, including financial and activity
// summaries built from the existing transaction/document tables.
const listUsers = asyncHandler(async (req, res) => {
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
           AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill')
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
             AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill')
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
               AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill')
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
               AND (p.payment_category IN ('paid_by_business', 'purchase_bill') OR p.purpose = 'Purchase Bill')
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
       ) AS vehicle_trip_count

     FROM users u
     WHERE u.role = 'user'
     ORDER BY u.created_at DESC`
  );

  const users = rows.map((user) => {
    const totalSales = Math.round(Number(user.total_sales || user.total_revenue || 0) * 100) / 100;
    const totalExpenses = Math.round(Number(user.expenses || 0) * 100) / 100;
    const netProfit = Math.round((totalSales - totalExpenses) * 100) / 100;

    return {
      ...user,
      total_sales: totalSales,
      total_revenue: totalSales,
      expenses: totalExpenses,
      net_profit: netProfit,
      profit_or_loss: netProfit,
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

  res.json({ success: true, count: users.length, users });
});

// GET /api/superadmin/users/:id
const getUser = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, secondary_phone, business_name, business_type, gstin, pan, website, address, address_line1, address_line2, city, state, pincode, country, role, employee_role_type, employee_title, permissions, profile_photo_path, status, last_login_at, last_active_at, created_by_admin, created_at, updated_at
     FROM users WHERE id = ?`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "User not found.");
  res.json({ success: true, user: rows[0] });
});

// POST /api/superadmin/employees
// The super admin creates an employee account directly, assigning the
// login credentials themselves (the employee never self-registers, and
// the super admin's own credentials are never shared). Nothing except a
// unique email + password is required — name/role type are optional.
const getUserOverview = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [userRows] = await pool.query(
    `SELECT
       id, name, email, phone,
       business_name, business_type, gstin, pan, website,
       logo_path, signature_path,
       address, address_line1, address_line2, city, state, pincode, country,
       currency, tax_type, tcs_enabled, tds_enabled, payment_terms,
       role, status, created_at, last_login_at, last_active_at
     FROM users
     WHERE id = ? AND role = 'user'`,
    [id]
  );

  if (!userRows.length) {
    throw new ApiError(404, "User not found.");
  }

  const user = userRows[0];

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
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE created_by = ? AND (payment_category IN ('paid_by_business', 'purchase_bill') OR purpose = 'Purchase Bill')`,
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
  const { name, email, password, phone, secondary_phone, employee_role_type, employee_title, date_of_birth, employee_age, address, pan, aadhaar_number, passport_number, permissions } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "email and password are required to create an employee login.");
  }

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length) throw new ApiError(409, "An account with this email already exists.");

  const normalizedPermissions = normalizePermissions(permissions);
  const hashed = await bcrypt.hash(password, 10);

  const [result] = await pool.query(
    `INSERT INTO users (
       name, email, phone, secondary_phone, password, role,
       employee_role_type, employee_title, date_of_birth, employee_age,
       address, pan, aadhaar_number, passport_number, profile_photo_path,
       permissions, created_by_admin
     )
     VALUES (?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name || null,
      email,
      phone || null,
      secondary_phone || null,
      hashed,
      employee_role_type || null,
      employee_title || null,
      date_of_birth || null,
      employee_age || null,
      address || null,
      pan || null,
      aadhaar_number || null,
      passport_number || null,
      req.file ? relativeUploadPath(req.file.path) : null,
      normalizedPermissions ? JSON.stringify(normalizedPermissions) : null,
      req.user.id,
    ]
  );

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, employee: publicUser(rows[0]) });
});

// GET /api/superadmin/employees
const listEmployees = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, secondary_phone,
            employee_title, employee_role_type, date_of_birth, employee_age,
            address, pan, aadhaar_number, passport_number,
            profile_photo_path, permissions, status,
            last_login_at, last_active_at, created_by_admin, created_at, updated_at
     FROM users
     WHERE role = 'employee'
     ORDER BY created_at DESC`
  );
  res.json({ success: true, count: rows.length, employees: rows });
});

// GET /api/superadmin/employees/:id
const getEmployee = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, secondary_phone,
            employee_title, employee_role_type, date_of_birth, employee_age,
            address, pan, aadhaar_number, passport_number,
            profile_photo_path, permissions, status,
            last_login_at, last_active_at,
            CASE WHEN last_active_at IS NOT NULL AND last_active_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE) THEN 'logged_in' ELSE 'logged_out' END AS activity_status,
            created_by_admin, created_at, updated_at
     FROM users
     WHERE id = ? AND role = 'employee'`,
    [req.params.id]
  );

  if (!rows.length) throw new ApiError(404, "Employee not found.");

  res.json({ success: true, employee: rows[0] });
});


// PATCH /api/superadmin/employees/:id
// Update an employee's role-type label / phone / name. Nothing required.
const updateEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    name,
    phone,
    secondary_phone,
    employee_role_type,
    employee_title,
    date_of_birth,
    employee_age,
    address,
    pan,
    aadhaar_number,
    passport_number,
    permissions,
  } = req.body;

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ? AND role = 'employee'",
    [id]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found.");

  const normalizedPermissions = normalizePermissions(permissions);

  await pool.query(
    `UPDATE users SET
       name = COALESCE(?, name),
       phone = COALESCE(?, phone),
       secondary_phone = COALESCE(?, secondary_phone),
       employee_role_type = COALESCE(?, employee_role_type),
       employee_title = COALESCE(?, employee_title),
       date_of_birth = COALESCE(?, date_of_birth),
       employee_age = COALESCE(?, employee_age),
       address = COALESCE(?, address),
       pan = COALESCE(?, pan),
       aadhaar_number = COALESCE(?, aadhaar_number),
       passport_number = COALESCE(?, passport_number),
       permissions = COALESCE(?, permissions)
     WHERE id = ?`,
    [
      name ?? null,
      phone ?? null,
      secondary_phone ?? null,
      employee_role_type ?? null,
      employee_title ?? null,
      date_of_birth ?? null,
      employee_age ?? null,
      address ?? null,
      pan ?? null,
      aadhaar_number ?? null,
      passport_number ?? null,
      normalizedPermissions === null ? null : JSON.stringify(normalizedPermissions),
      id,
    ]
  );

  const [updated] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  res.json({ success: true, employee: publicUser(updated[0]) });
});

// PATCH /api/superadmin/users/:id/status
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


/*
 * ============================================================
 * OWNER CONSOLE - SELECTED USER DATA
 * Read-only access for Super Admin only.
 * Normal operational endpoints remain owner-scoped.
 * ============================================================
 */

const calculateUserReports = async (id) => {
  const [
    customerResult,
    invoiceResult,
    revenueResult,
    expenseResult,
    paidByBusinessResult,
    unlinkedDebitsResult,
    advPaymentsResult,
    unlinkedMrAdvancesResult,
    dueReceivedResult,
    creditEntryCountResult,
    debitEntryCountResult,
    monthlySalesResult,
    monthlyExpenseResult,
  ] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM invoices WHERE created_by = ? AND doc_type = 'invoice'", [id]),
    pool.query(
      `SELECT (
         COALESCE((SELECT SUM(amount) FROM collections WHERE created_by = ?), 0)
         +
         COALESCE((SELECT SUM(amount) FROM khata_entries WHERE created_by = ? AND type = 'credit'), 0)
       ) AS total`,
      [id, id]
    ),
    pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE created_by = ?", [id]),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE created_by = ? AND (payment_category IN ('paid_by_business', 'purchase_bill') OR purpose = 'Purchase Bill')`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM khata_entries
       WHERE created_by = ? AND type = 'debit' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE created_by = ? AND (payment_category = 'advance_from_investor' OR purpose IN ('Investor Advance', 'Advance'))`,
      [id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount_received), 0) AS total
       FROM money_receipts
       WHERE created_by = ? AND against_type = 'advance' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
      [id]
    ),
    pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE created_by = ? AND payment_category = 'due_received'",
      [id]
    ),
    pool.query(
      `SELECT (
         (SELECT COUNT(*) FROM collections WHERE created_by = ?)
         +
         (SELECT COUNT(*) FROM customer_dues WHERE created_by = ?)
       ) AS count`,
      [id, id]
    ),
    pool.query(
      "SELECT COUNT(*) AS count FROM khata_entries WHERE created_by = ? AND type = 'debit'",
      [id]
    ),
    pool.query(
      `SELECT month, COALESCE(SUM(sale_amount), 0) AS sales
       FROM (
         SELECT DATE_FORMAT(sale_date, '%Y-%m') AS month, amount AS sale_amount
         FROM collections
         WHERE created_by = ? AND sale_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)

         UNION ALL

         SELECT DATE_FORMAT(entry_date, '%Y-%m') AS month, amount AS sale_amount
         FROM khata_entries
         WHERE created_by = ? AND type = 'credit'
           AND entry_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)
       ) combined_sales
       GROUP BY month
       ORDER BY month ASC`,
      [id, id]
    ),
    pool.query(
      `SELECT month, COALESCE(SUM(exp_amount), 0) AS expenses
       FROM (
         SELECT DATE_FORMAT(expense_date, '%Y-%m') AS month, amount AS exp_amount
         FROM expenses
         WHERE created_by = ? AND expense_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)

         UNION ALL

         SELECT DATE_FORMAT(payment_date, '%Y-%m') AS month, amount AS exp_amount
         FROM payments
         WHERE created_by = ? AND (payment_category IN ('paid_by_business', 'purchase_bill') OR purpose = 'Purchase Bill')
           AND payment_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)

         UNION ALL

         SELECT DATE_FORMAT(entry_date, '%Y-%m') AS month, amount AS exp_amount
         FROM khata_entries
         WHERE created_by = ? AND type = 'debit' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)
           AND entry_date >= DATE_SUB(CURRENT_DATE, INTERVAL 6 MONTH)
       ) combined_exp
       GROUP BY month
       ORDER BY month ASC`,
      [id, id, id]
    ),
  ]);

  const totalSales = Math.round(Number(revenueResult[0][0].total || 0) * 100) / 100;
  const directExpenses = Math.round(Number(expenseResult[0][0].total || 0) * 100) / 100;
  const paidByBusiness = Math.round(Number(paidByBusinessResult[0][0].total || 0) * 100) / 100;
  const unlinkedDebits = Math.round(Number(unlinkedDebitsResult[0][0].total || 0) * 100) / 100;
  const totalExpenses = Math.round((directExpenses + paidByBusiness + unlinkedDebits) * 100) / 100;

  const dueReceived = Math.round(Number(dueReceivedResult[0][0].total || 0) * 100) / 100;
  const investorAdvance = Math.round(
    (Number(advPaymentsResult[0][0].total || 0) +
      Number(unlinkedMrAdvancesResult[0][0].total || 0)) *
      100
  ) / 100;

  const creditEntries = Number(creditEntryCountResult[0][0].count || 0);
  const debitEntries = Number(debitEntryCountResult[0][0].count || 0);
  const customerCount = Number(customerResult[0][0].count || 0);
  const netProfit = Math.round((totalSales - totalExpenses) * 100) / 100;

  const salesByMonth = new Map(monthlySalesResult[0].map((r) => [r.month, Number(r.sales || 0)]));
  const expensesByMonth = new Map(monthlyExpenseResult[0].map((r) => [r.month, Number(r.expenses || 0)]));

  const monthlyTrend = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyTrend.push({
      month: m,
      sales: Math.round((salesByMonth.get(m) || 0) * 100) / 100,
      expenses: Math.round((expensesByMonth.get(m) || 0) * 100) / 100,
    });
  }

  return {
    total_sales: totalSales,
    total_revenue: totalSales,
    due_received: dueReceived,
    expenses: totalExpenses,
    expenses_breakdown: {
      direct_expenses: directExpenses,
      paid_by_business_payments: paidByBusiness,
      unlinked_khata_debits: unlinkedDebits,
    },
    investor_advance: investorAdvance,
    net_profit: netProfit,
    profit_or_loss: netProfit,
    sales_vs_expenses: {
      sales: totalSales,
      expenses: totalExpenses,
    },
    credit_entries: creditEntries,
    debit_entries: debitEntries,
    total_customers: customerCount,
    monthly_business_performance: monthlyTrend,
    monthly_trend: monthlyTrend,
    last_6_months: monthlyTrend,
  };
};

const getUserData = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const type = String(req.query.type || "").trim().toLowerCase();

  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );

  if (!userRows.length) {
    throw new ApiError(404, "User not found.");
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
      const [sales] = await pool.query(
        `SELECT c.id, c.amount, c.sale_date AS date, c.created_at,
                COALESCE(cu.name, 'Walk-in') AS name,
                CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
                'credit' AS type,
                c.payment_type,
                c.customer_id,
                c.item_name AS product_name,
                NULL AS quantity,
                NULL AS unit_price,
                0 AS is_linked_to_payment
         FROM collections c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         WHERE c.created_by = ?`,
        [id]
      );

      const [debits] = await pool.query(
        `SELECT ke.id, ke.amount, ke.entry_date AS date, ke.created_at,
                COALESCE(cu.name, 'Walk-in') AS name,
                ke.description,
                'debit' AS type,
                NULL AS payment_type,
                ke.customer_id,
                s.product_name,
                ke.quantity,
                ke.unit_price,
                ke.is_linked_to_payment,
                ke.payment_id
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         LEFT JOIN stock s ON s.id = ke.product_id
         WHERE ke.created_by = ?`,
        [id]
      );

      const [dues] = await pool.query(
        `SELECT cd.id, cd.amount, cd.remaining_amount,
                COALESCE(cd.due_date, DATE(cd.created_at)) AS date,
                cd.created_at,
                COALESCE(cu.name, 'Customer') AS name,
                cd.description,
                'due' AS type,
                cd.status,
                cd.customer_id,
                s.product_name,
                cd.quantity,
                cd.unit_price,
                0 AS is_linked_to_payment
         FROM customer_dues cd
         LEFT JOIN customers cu ON cu.id = cd.customer_id
         LEFT JOIN stock s ON s.id = cd.product_id
         WHERE cd.created_by = ?`,
        [id]
      );

      rows = [...sales, ...debits, ...dues].sort(
        (a, b) =>
          new Date(b.date) - new Date(a.date) ||
          new Date(b.created_at) - new Date(a.created_at)
      );
      break;
    }

    case "payments": {
      const [result] = await pool.query(
        `SELECT p.*, u.name AS added_by, cu.name AS customer_name
         FROM payments p
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN customers cu ON cu.id = p.customer_id
         WHERE p.created_by = ?
         ORDER BY p.payment_date DESC, p.created_at DESC`,
        [id]
      );
      rows = result;
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
      const reports = await calculateUserReports(id);
      return res.json({
        success: true,
        user: userRows[0],
        type: "reports",
        reports,
      });
    }

    default:
      throw new ApiError(
        400,
        "Invalid data type. Use customers, khata, payments, invoices, quotations, money-receipts, inventory, vehicles, or reports."
      );
  }

  res.json({
    success: true,
    user: userRows[0],
    type,
    count: rows.length,
    [type === "money-receipts" ? "receipts" : type]: rows,
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
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const [sales] = await pool.query(
    `SELECT c.id, c.amount, c.sale_date AS date, c.created_at,
            COALESCE(cu.name, 'Walk-in') AS name,
            CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
            'credit' AS type, c.payment_type,
            c.customer_id,
            c.item_name AS product_name,
            NULL AS product_id,
            NULL AS quantity,
            NULL AS unit_price,
            0 AS is_linked_to_payment,
            NULL AS payment_id
     FROM collections c
     LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE c.created_by = ?`,
    [id]
  );

  const [khataRows] = await pool.query(
    `SELECT ke.id, ke.amount, ke.entry_date AS date, ke.created_at,
            COALESCE(cu.name, 'Walk-in') AS name,
            ke.description,
            ke.type,
            NULL AS payment_type,
            ke.customer_id,
            s.product_name,
            ke.product_id,
            ke.quantity,
            ke.unit_price,
            ke.is_linked_to_payment,
            ke.payment_id
     FROM khata_entries ke
     LEFT JOIN customers cu ON cu.id = ke.customer_id
     LEFT JOIN stock s ON s.id = ke.product_id
     WHERE ke.created_by = ?`,
    [id]
  );

  const [dues] = await pool.query(
    `SELECT cd.id, cd.amount, cd.remaining_amount,
            COALESCE(cd.due_date, DATE(cd.created_at)) AS date,
            cd.created_at,
            COALESCE(cu.name, 'Customer') AS name,
            cd.description,
            'due' AS type,
            cd.status,
            cd.customer_id,
            s.product_name,
            cd.product_id,
            cd.quantity,
            cd.unit_price,
            0 AS is_linked_to_payment,
            NULL AS payment_id
     FROM customer_dues cd
     LEFT JOIN customers cu ON cu.id = cd.customer_id
     LEFT JOIN stock s ON s.id = cd.product_id
     WHERE cd.created_by = ?`,
    [id]
  );

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

  const entries = [...normalizedSales, ...normalizedKhata, ...normalizedDues].sort(
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
  });
});

const getUserInventory = asyncHandler(async (req, res) => {
  const { id } = req.params;
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
  const [userRows] = await pool.query(
    "SELECT id, name, business_name FROM users WHERE id = ? AND role = 'user'",
    [id]
  );
  if (!userRows.length) throw new ApiError(404, "User not found.");

  const reports = await calculateUserReports(id);

  res.json({
    success: true,
    user: userRows[0],
    reports,
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

module.exports = {
  getUserRecord,
  getUserData,
  getUserCustomers,
  getUserKhata,
  getUserInventory,
  getUserVehicles,
  getUserReports,
  deleteUserCustomer,
  listUsers,
  getUser,
  getUserOverview,
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  setUserStatus,
};
