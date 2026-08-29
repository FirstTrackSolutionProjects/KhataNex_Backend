const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// POST /api/customers
// Nothing is required — a blank submission still creates a row (name
// falls back to "Unnamed Customer" via the DB default).
const createCustomer = asyncHandler(async (req, res) => {
  const { name, phone, email } = req.body;

  const [result] = await pool.query(
    "INSERT INTO customers (name, phone, email, created_by) VALUES (?, ?, ?, ?)",
    [name || null, phone || null, email || null, req.user?.id || null]
  );
  const [rows] = await pool.query("SELECT * FROM customers WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, customer: rows[0] });
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
  const { name, phone, email } = req.body;
  const { id } = req.params;
  const [rows] = await pool.query("SELECT id FROM customers WHERE id = ?", [id]);
  if (!rows.length) throw new ApiError(404, "Customer not found.");

  await pool.query(
    "UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?",
    [name || null, phone || null, email || null, id]
  );
  res.json({ success: true, message: "Customer updated." });
});

module.exports = { createCustomer, listCustomers, getCustomerProfile, updateCustomer };
