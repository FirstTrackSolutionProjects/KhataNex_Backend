const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// POST /api/customers
// Nothing is required — a blank submission still creates a row (name
// falls back to "Unnamed Customer" via the DB default).

  const createCustomer = asyncHandler(async (req, res) => {
  const {
    title,
    name,
    businessName,
    businessCountry,
    displayName,
    entity,
    gstin,
    pan,
    msmeNumber,
    email,
    phone,
    mobileCountry,

    businessAddress,
    billingAddress,
    shippingAddress,
  } = req.body;

  const [result] = await pool.query(
    `INSERT INTO customers (
      title,
      name,
      business_name,
      business_country,
      display_name,
      entity,
      gstin,
      pan,
      msme_number,
      email,
      phone,
      mobile_country,

      business_state,
      business_district,
      business_pincode,
      business_city,
      business_landmark,

      billing_state,
      billing_district,
      billing_pincode,
      billing_city,
      billing_landmark,

      shipping_state,
      shipping_district,
      shipping_pincode,
      shipping_city,
      shipping_landmark,

      created_by
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?
    )`,
    [
      title || null,
      name || null,
      businessName || null,
      businessCountry || null,
      displayName || null,
      entity || null,
      gstin || null,
      pan || null,
      msmeNumber || null,
      email || null,
      phone || null,
      mobileCountry || null,

      businessAddress?.state || null,
      businessAddress?.district || null,
      businessAddress?.pincode || null,
      businessAddress?.city || null,
      businessAddress?.landmark || null,

      billingAddress?.state || null,
      billingAddress?.district || null,
      billingAddress?.pincode || null,
      billingAddress?.city || null,
      billingAddress?.landmark || null,

      shippingAddress?.state || null,
      shippingAddress?.district || null,
      shippingAddress?.pincode || null,
      shippingAddress?.city || null,
      shippingAddress?.landmark || null,

      req.user?.id || null,
    ]
  );

  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE id = ? AND created_by = ?",
    [result.insertId, req.user.id]
  );

  res.status(201).json({
    success: true,
    customer: rows[0],
  });

});

// GET /api/customers
// Every customer with how much they currently owe.
const listCustomers = asyncHandler(async (req, res) => {
  const { search } = req.query;

  let sql = `SELECT c.*, u.name AS created_by_name
             FROM customers c
             LEFT JOIN users u ON u.id = c.created_by
             WHERE c.created_by = ?`;
  const params = [req.user.id];

  if (search) {
    sql += " AND (c.name LIKE ? OR c.phone LIKE ?)";
    params.push("%" + search + "%", "%" + search + "%");
  }

  sql += " ORDER BY c.total_due DESC, c.name ASC";

  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, customers: rows });
});

// GET /api/customers/:id
// Full profile: due amount + sale history + payment (due-clearing) history.
const getCustomerProfile = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [custRows] = await pool.query("SELECT * FROM customers WHERE id = ?", [id]);
  if (!custRows.length) throw new ApiError(404, "Customer not found.");

  if (custRows[0].created_by !== req.user.id) {
    throw new ApiError(404, "Customer not found.");
  }

  const [sales] = await pool.query(
    `SELECT id, item_name, amount, payment_type, sale_date, created_at
     FROM collections WHERE customer_id = ? AND created_by = ? ORDER BY sale_date DESC, created_at DESC`,
    [id, req.user.id]
  );

  const [duePayments] = await pool.query(
    `SELECT id, amount, payment_mode, purpose, payment_date, created_at
     FROM payments WHERE customer_id = ? AND created_by = ? AND payment_category = 'due_received'
     ORDER BY payment_date DESC, created_at DESC`,
    [id, req.user.id]
  );

  const [dues] = await pool.query(
    `SELECT * FROM customer_dues
     WHERE customer_id = ? AND created_by = ? AND status != 'settled'
     ORDER BY created_at ASC, id ASC`,
    [id, req.user.id]
  );

  res.json({
    success: true,
    customer: custRows[0],
    sales_history: sales,
    due_payments_history: duePayments,
    outstanding_dues: dues,
    dues,
  });
});

const getCustomerDues = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(
    `SELECT * FROM customer_dues
     WHERE customer_id = ? AND created_by = ? AND status != 'settled'
     ORDER BY created_at ASC, id ASC`,
    [id, req.user.id]
  );
  res.json({ success: true, count: rows.length, dues: rows });
});

// PATCH /api/customers/:id
const updateCustomer = asyncHandler(async (req, res) => {
  const {
    title,
    name,
    businessName,
    businessCountry,
    displayName,
    entity,
    gstin,
    pan,
    msmeNumber,
    email,
    phone,
    mobileCountry,

    businessAddress,
    billingAddress,
    shippingAddress,
  } = req.body;

  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT id, created_by FROM customers WHERE id = ?",
    [id]
  );

  if (!rows.length) {
    throw new ApiError(404, "Customer not found.");
  }

  if (rows[0].created_by !== req.user.id) {
    throw new ApiError(404, "Customer not found.");
  }

  await pool.query(
    `UPDATE customers SET
      title = COALESCE(?, title),
      name = COALESCE(?, name),
      business_name = COALESCE(?, business_name),
      business_country = COALESCE(?, business_country),
      display_name = COALESCE(?, display_name),
      entity = COALESCE(?, entity),
      gstin = COALESCE(?, gstin),
      pan = COALESCE(?, pan),
      msme_number = COALESCE(?, msme_number),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      mobile_country = COALESCE(?, mobile_country),

      business_state = COALESCE(?, business_state),
      business_district = COALESCE(?, business_district),
      business_pincode = COALESCE(?, business_pincode),
      business_city = COALESCE(?, business_city),
      business_landmark = COALESCE(?, business_landmark),

      billing_state = COALESCE(?, billing_state),
      billing_district = COALESCE(?, billing_district),
      billing_pincode = COALESCE(?, billing_pincode),
      billing_city = COALESCE(?, billing_city),
      billing_landmark = COALESCE(?, billing_landmark),

      shipping_state = COALESCE(?, shipping_state),
      shipping_district = COALESCE(?, shipping_district),
      shipping_pincode = COALESCE(?, shipping_pincode),
      shipping_city = COALESCE(?, shipping_city),
      shipping_landmark = COALESCE(?, shipping_landmark)
    WHERE id = ? AND created_by = ?`,
    [
      title || null,
      name || null,
      businessName || null,
      businessCountry || null,
      displayName || null,
      entity || null,
      gstin || null,
      pan || null,
      msmeNumber || null,
      email || null,
      phone || null,
      mobileCountry || null,

      businessAddress?.state || null,
      businessAddress?.district || null,
      businessAddress?.pincode || null,
      businessAddress?.city || null,
      businessAddress?.landmark || null,

      billingAddress?.state || null,
      billingAddress?.district || null,
      billingAddress?.pincode || null,
      billingAddress?.city || null,
      billingAddress?.landmark || null,

      shippingAddress?.state || null,
      shippingAddress?.district || null,
      shippingAddress?.pincode || null,
      shippingAddress?.city || null,
      shippingAddress?.landmark || null,

      id,
      req.user.id,
    ]
  );

  res.json({
    success: true,
    message: "Customer updated.",
  });
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const customerId = req.params.id;
  const targetUserId =
    req.query.user_id && req.user.role === "superadmin"
      ? Number(req.query.user_id)
      : req.user.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let checkSql = "SELECT id, name, created_by FROM customers WHERE id = ?";
    let checkParams = [customerId];

    if (req.user.role !== "superadmin") {
      checkSql += " AND created_by = ?";
      checkParams.push(req.user.id);
    } else if (req.query.user_id) {
      checkSql += " AND created_by = ?";
      checkParams.push(targetUserId);
    }

    const [rows] = await conn.query(checkSql, checkParams);
    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Customer not found.");
    }

    const customer = rows[0];

    // Safely unlink or clean up references before deleting the customer:
    await conn.query(
      "UPDATE collections SET customer_id = NULL WHERE customer_id = ?",
      [customerId]
    );

    await conn.query(
      "UPDATE payments SET customer_id = NULL WHERE customer_id = ?",
      [customerId]
    );

    await conn.query(
      "UPDATE invoices SET customer_id = NULL WHERE customer_id = ?",
      [customerId]
    );

    await conn.query(
      "UPDATE quotations SET customer_id = NULL WHERE customer_id = ?",
      [customerId]
    );

    await conn.query(
      "UPDATE money_receipts SET customer_id = NULL WHERE customer_id = ?",
      [customerId]
    );

    await conn.query(
      "DELETE FROM customer_dues WHERE customer_id = ?",
      [customerId]
    );

    await conn.query("DELETE FROM customers WHERE id = ?", [customerId]);

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
  createCustomer,
  listCustomers,
  getCustomerProfile,
  getCustomerDues,
  updateCustomer,
  deleteCustomer,
};
