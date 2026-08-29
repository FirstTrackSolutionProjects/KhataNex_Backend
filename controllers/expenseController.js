const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// POST /api/expenses
// Nothing is required — description defaults to "Expense", amount to 0.
const addExpense = asyncHandler(async (req, res) => {
  const { description, category, amount, expense_date } = req.body;
  const finalAmount = amount && Number(amount) > 0 ? amount : 0;

  const [result] = await pool.query(
    `INSERT INTO expenses (description, category, amount, expense_date, created_by)
     VALUES (?, ?, ?, COALESCE(?, CURRENT_DATE), ?)`,
    [description || null, category || null, finalAmount, expense_date || null, req.user.id]
  );
  const [rows] = await pool.query("SELECT * FROM expenses WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, expense: rows[0] });
});

// GET /api/expenses?from=&to=&category=
const listExpenses = asyncHandler(async (req, res) => {
  const { from, to, category } = req.query;
  let sql = `SELECT e.*, u.name AS added_by FROM expenses e LEFT JOIN users u ON u.id = e.created_by WHERE 1=1`;
  const params = [];

  if (req.user.role === "user") {
    sql += " AND e.created_by = ?";
    params.push(req.user.id);
  }
  if (from) {
    sql += " AND e.expense_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND e.expense_date <= ?";
    params.push(to);
  }
  if (category) {
    sql += " AND e.category = ?";
    params.push(category);
  }
  sql += " ORDER BY e.expense_date DESC, e.created_at DESC";

  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, expenses: rows });
});

// GET /api/expenses/summary — daily/weekly/monthly totals (business cash outflow)
const getExpenseSummary = asyncHandler(async (req, res) => {
  const userScope = req.user.role === "user" ? req.user.id : req.query.user_id || null;

  const build = async (dateCondition) => {
    let sql = `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entries FROM expenses WHERE ${dateCondition}`;
    const params = [];
    if (userScope) {
      sql += " AND created_by = ?";
      params.push(userScope);
    }
    const [rows] = await pool.query(sql, params);
    return rows[0];
  };

  const [today, weekly, monthly] = await Promise.all([
    build("expense_date = CURRENT_DATE"),
    build("expense_date >= (CURRENT_DATE - INTERVAL WEEKDAY(CURRENT_DATE) DAY)"),
    build("expense_date >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')"),
  ]);

  res.json({ success: true, today, this_week: weekly, this_month: monthly });
});

module.exports = { addExpense, listExpenses, getExpenseSummary };
