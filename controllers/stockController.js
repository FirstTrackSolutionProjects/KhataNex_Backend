const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const SORTABLE = { name: "product_name", type: "type", price: "price", category: "category" };

/**
 * looks up the latest purchase invoice recorded against an HSN code, so we
 * can auto-fill price & quantity when the caller doesn't supply them.
 * (See controllers/purchaseInvoiceController.js for where these records
 * come from — you record your seller's purchase invoice once, keyed by
 * HSN code, and every future stock entry at that HSN code can reuse it.)
 */
const lookupLatestByHsn = async (hsn_code) => {
  if (!hsn_code) return null;
  const [rows] = await pool.query(
    `SELECT product_name, quantity, price FROM purchase_invoices
     WHERE hsn_code = ? ORDER BY invoice_date DESC, created_at DESC LIMIT 1`,
    [hsn_code]
  );
  return rows[0] || null;
};

// POST /api/stock
// Nothing is required. If hsn_code is given and price and/or quantity are
// omitted, they are auto-filled from the latest purchase invoice recorded
// at that HSN code; otherwise price/quantity just default to 0.
const addStock = asyncHandler(async (req, res) => {
  let { product_name, category, type, hsn_code, price, quantity } = req.body;

  if (hsn_code && (price === undefined || price === null || price === "")) {
    const match = await lookupLatestByHsn(hsn_code);
    if (match) {
      price = match.price;
      if (quantity === undefined || quantity === null || quantity === "") quantity = match.quantity;
    }
  }

  const finalPrice = price !== undefined && price !== null && price !== "" && Number(price) >= 0 ? price : 0;

  const [result] = await pool.query(
    "INSERT INTO stock (product_name, category, type, hsn_code, price, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [product_name || null, category || null, type || null, hsn_code || null, finalPrice, quantity || 0, req.user.id]
  );
  const [rows] = await pool.query("SELECT * FROM stock WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, stock: rows[0] });
});

// GET /api/stock?sortBy=name|type|price|category&order=asc|desc&search=
const listStock = asyncHandler(async (req, res) => {
  const { sortBy = "name", order = "asc", search } = req.query;
  const column = SORTABLE[sortBy] || "product_name";
  const direction = order.toLowerCase() === "desc" ? "DESC" : "ASC";

  let sql = `SELECT s.*, u.name AS added_by FROM stock s LEFT JOIN users u ON u.id = s.created_by`;
  const params = [];
  if (search) {
    sql += " WHERE s.product_name LIKE ? OR s.type LIKE ? OR s.category LIKE ? OR s.hsn_code LIKE ?";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY s.${column} ${direction}`;

  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, stock: rows });
});

// PATCH /api/stock/:id
const updateStock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { product_name, category, type, hsn_code, price, quantity } = req.body;

  const [rows] = await pool.query("SELECT * FROM stock WHERE id = ?", [id]);
  if (!rows.length) throw new ApiError(404, "Stock item not found.");

  await pool.query(
    `UPDATE stock SET product_name = COALESCE(?, product_name), category = COALESCE(?, category),
     type = COALESCE(?, type), hsn_code = COALESCE(?, hsn_code),
     price = COALESCE(?, price), quantity = COALESCE(?, quantity) WHERE id = ?`,
    [product_name || null, category || null, type || null, hsn_code || null, price ?? null, quantity ?? null, id]
  );
  const [updated] = await pool.query("SELECT * FROM stock WHERE id = ?", [id]);
  res.json({ success: true, stock: updated[0] });
});

// DELETE /api/stock/:id
const deleteStock = asyncHandler(async (req, res) => {
  const [result] = await pool.query("DELETE FROM stock WHERE id = ?", [req.params.id]);
  if (!result.affectedRows) throw new ApiError(404, "Stock item not found.");
  res.json({ success: true, message: "Stock item removed." });
});

module.exports = { addStock, listStock, updateStock, deleteStock };
