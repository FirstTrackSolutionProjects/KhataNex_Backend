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
    "SELECT * FROM customers WHERE id = ?",
    [result.insertId]
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
             FROM customers c LEFT JOIN users u ON u.id = c.created_by`;
  const params = [];
  if (search) {
    sql += " WHERE c.name LIKE ? OR c.phone LIKE ?";
    params.push(`%${search}%`, `%${search}%`);
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

  const [sales] = await pool.query(
    `SELECT id, item_name, amount, payment_type, sale_date, created_at
     FROM collections WHERE customer_id = ? ORDER BY sale_date DESC, created_at DESC`,
    [id]
  );

  const [duePayments] = await pool.query(
    `SELECT id, amount, payment_mode, purpose, payment_date, created_at
     FROM payments WHERE customer_id = ? AND payment_category = 'due_received'
     ORDER BY payment_date DESC, created_at DESC`,
    [id]
  );

  res.json({
    success: true,
    customer: custRows[0],
    sales_history: sales,
    due_payments_history: duePayments,
  });
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
    "SELECT id FROM customers WHERE id = ?",
    [id]
  );

  if (!rows.length) {
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
    WHERE id = ?`,
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
    ]
  );

  res.json({
    success: true,
    message: "Customer updated.",
  });
});

module.exports = { createCustomer, listCustomers, getCustomerProfile, updateCustomer };
