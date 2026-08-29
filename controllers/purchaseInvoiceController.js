const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");

// POST /api/purchase-invoices  (multipart/form-data, optional file field "invoice_file")
// Record what a seller billed you for a product, keyed by HSN code. This is
// the source data that powers auto-fill of price/quantity when adding stock.
// Nothing is required — an hsn_code-less record just won't be matched by
// the auto-fill lookup later, which is fine.
const addPurchaseInvoice = asyncHandler(async (req, res) => {
  const { seller_name, invoice_number, product_name, hsn_code, quantity, price, invoice_date } = req.body;

  const filePath = req.file ? relativeUploadPath(req.file.path) : null;

  const [result] = await pool.query(
    `INSERT INTO purchase_invoices
     (seller_name, invoice_number, product_name, hsn_code, quantity, price, invoice_file, invoice_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?)`,
    [
      seller_name || null,
      invoice_number || null,
      product_name || null,
      hsn_code || null,
      quantity || 0,
      price || 0,
      filePath,
      invoice_date || null,
      req.user.id,
    ]
  );

  const [rows] = await pool.query("SELECT * FROM purchase_invoices WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, purchase_invoice: rows[0] });
});

// GET /api/purchase-invoices/lookup?hsn_code=xxxx
// Used by the "add stock" form to auto-fill price & quantity as soon as an
// HSN code is typed in, from the most recent purchase recorded at that code.
const lookupByHsn = asyncHandler(async (req, res) => {
  const { hsn_code } = req.query;
  if (!hsn_code) {
    return res.json({ success: true, found: false, message: "No HSN code given." });
  }

  const [rows] = await pool.query(
    `SELECT product_name, hsn_code, quantity, price, seller_name, invoice_date
     FROM purchase_invoices WHERE hsn_code = ? ORDER BY invoice_date DESC, created_at DESC LIMIT 1`,
    [hsn_code]
  );

  if (!rows.length) {
    return res.json({ success: true, found: false, message: "No prior purchase invoice recorded at this HSN code yet." });
  }
  res.json({ success: true, found: true, match: rows[0] });
});

// GET /api/purchase-invoices?hsn_code=&seller_name=
const listPurchaseInvoices = asyncHandler(async (req, res) => {
  const { hsn_code, seller_name } = req.query;
  let sql = `SELECT p.*, u.name AS added_by FROM purchase_invoices p LEFT JOIN users u ON u.id = p.created_by WHERE 1=1`;
  const params = [];
  if (hsn_code) {
    sql += " AND p.hsn_code = ?";
    params.push(hsn_code);
  }
  if (seller_name) {
    sql += " AND p.seller_name LIKE ?";
    params.push(`%${seller_name}%`);
  }
  sql += " ORDER BY p.invoice_date DESC, p.created_at DESC";

  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, purchase_invoices: rows });
});

module.exports = { addPurchaseInvoice, lookupByHsn, listPurchaseInvoices };
