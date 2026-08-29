const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");

// GET /api/khata?customer_id=&from=&to=
// The frontend expects ONE unified ledger feed (credit/debit entries),
// while the backend models this as separate collections (sales) and
// payments tables. This endpoint merges both into the shape the frontend
// already expects, so no frontend change was needed for this mismatch.
//
// Convention used here (documented since "credit"/"debit" are ambiguous
// in everyday khata language):
//   - a sale (any payment_type)        -> type: 'credit' (business earned this)
//   - a due_received payment           -> type: 'credit' (money received)
//   - an advance_from_investor payment -> type: 'credit' (money received)
//   - a paid_by_business payment       -> type: 'debit'  (money went out)
const getKhata = asyncHandler(async (req, res) => {
  const { customer_id, from, to } = req.query;

  let salesSql = `
    SELECT c.id, c.amount, c.sale_date AS date, c.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
           'credit' AS type, c.payment_type
    FROM collections c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE 1=1`;
  const salesParams = [];
  if (req.user.role === "user") {
    salesSql += " AND c.created_by = ?";
    salesParams.push(req.user.id);
  }
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

  let paymentsSql = `
    SELECT p.id, p.amount, p.payment_date AS date, p.created_at,
           COALESCE(cu.name, p.party_name, 'Unknown') AS name,
           COALESCE(p.purpose, REPLACE(p.payment_category, '_', ' ')) AS description,
           IF(p.payment_category = 'paid_by_business', 'debit', 'credit') AS type,
           p.payment_category
    FROM payments p LEFT JOIN customers cu ON cu.id = p.customer_id WHERE 1=1`;
  const paymentsParams = [];
  if (req.user.role === "user") {
    paymentsSql += " AND p.created_by = ?";
    paymentsParams.push(req.user.id);
  }
  if (customer_id) {
    paymentsSql += " AND p.customer_id = ?";
    paymentsParams.push(customer_id);
  }
  if (from) {
    paymentsSql += " AND p.payment_date >= ?";
    paymentsParams.push(from);
  }
  if (to) {
    paymentsSql += " AND p.payment_date <= ?";
    paymentsParams.push(to);
  }

  const [sales] = await pool.query(salesSql, salesParams);
  const [payments] = await pool.query(paymentsSql, paymentsParams);

  const entries = [...sales, ...payments].sort(
    (a, b) => new Date(b.date) - new Date(a.date) || new Date(b.created_at) - new Date(a.created_at)
  );

  res.json({ success: true, count: entries.length, entries });
});

module.exports = { getKhata };
