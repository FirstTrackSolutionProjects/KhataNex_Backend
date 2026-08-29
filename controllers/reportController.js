const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");

// GET /api/reports/profit-loss?user_id=&from=&to=
// A 'user' always sees only their own numbers (auto-scoped below,
// ignoring any user_id they might pass). employee/superadmin may pass
// user_id to see a specific user, or omit it for all users combined.
//
// Formula (kept simple & transparent so it can be tuned later):
//   income          = SUM(collections.amount)  -> all sales value (cash + online + due)
//   businessPaidOut = SUM(payments WHERE category='paid_by_business')
//   expenses        = SUM(expenses.amount)
//   profit_or_loss  = income - businessPaidOut - expenses
//
// advance_from_investor is reported separately (it's financing, not revenue,
// so it is intentionally NOT added into profit).
const getProfitLoss = asyncHandler(async (req, res) => {
  const user_id = req.user.role === "user" ? req.user.id : req.query.user_id;

  const dateFilter = (col) => {
    const clauses = [];
    const params = [];
    if (from) {
      clauses.push(`${col} >= ?`);
      params.push(from);
    }
    if (to) {
      clauses.push(`${col} <= ?`);
      params.push(to);
    }
    if (user_id) {
      clauses.push("created_by = ?");
      params.push(user_id);
    }
    return { clause: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
  };

  const salesFilter = dateFilter("sale_date");
  const [[income]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_type='cash' THEN amount ELSE 0 END),0) AS cash,
       COALESCE(SUM(CASE WHEN payment_type='online' THEN amount ELSE 0 END),0) AS online,
       COALESCE(SUM(CASE WHEN payment_type='due' THEN amount ELSE 0 END),0) AS due,
       COALESCE(SUM(amount),0) AS total
     FROM collections ${salesFilter.clause}`,
    salesFilter.params
  );

  const expFilter = dateFilter("expense_date");
  const [[expenses]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM expenses ${expFilter.clause}`,
    expFilter.params
  );

  const payFilterBase = dateFilter("payment_date");
  const withCategory = (cat) => ({
    clause: payFilterBase.clause ? `${payFilterBase.clause} AND payment_category = ?` : "WHERE payment_category = ?",
    params: [...payFilterBase.params, cat],
  });

  const paidFilter = withCategory("paid_by_business");
  const [[paidByBusiness]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments ${paidFilter.clause}`,
    paidFilter.params
  );
  const advFilter = withCategory("advance_from_investor");
  const [[advanceFromInvestor]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments ${advFilter.clause}`,
    advFilter.params
  );
  const dueFilter = withCategory("due_received");
  const [[dueReceived]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments ${dueFilter.clause}`,
    dueFilter.params
  );

  const profitOrLoss = Number(income.total) - Number(paidByBusiness.total) - Number(expenses.total);

  res.json({
    success: true,
    scope: user_id ? `user_id=${user_id}` : "all users",
    range: { from: from || "all-time", to: to || "all-time" },
    income_from_sales: income,
    expenses_total: expenses.total,
    paid_out_by_business: paidByBusiness.total,
    due_received_from_customers: dueReceived.total,
    advance_from_investor: advanceFromInvestor.total,
    profit_or_loss: profitOrLoss,
    note: "profit_or_loss = total sales - amount paid out by business - expenses. Investor advances and due collections are financing/cashflow items, shown separately and not counted as profit.",
  });
});

// GET /api/reports/monthly-trend?months=6&user_id=
// Powers the Reports page chart: sales total and expenses total per month,
// for the last N months (default 6). user_id optional (all users if omitted).
const getMonthlyTrend = asyncHandler(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const user_id = req.user.role === "user" ? req.user.id : req.query.user_id;

  const salesSql = `
    SELECT DATE_FORMAT(sale_date, '%Y-%m') AS month, COALESCE(SUM(amount),0) AS sales
    FROM collections
    WHERE sale_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH) ${user_id ? "AND created_by = ?" : ""}
    GROUP BY month ORDER BY month ASC`;
  const salesParams = user_id ? [months, user_id] : [months];
  const [salesRows] = await pool.query(salesSql, salesParams);

  const expenseSql = `
    SELECT DATE_FORMAT(expense_date, '%Y-%m') AS month, COALESCE(SUM(amount),0) AS expenses
    FROM expenses
    WHERE expense_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH) ${user_id ? "AND created_by = ?" : ""}
    GROUP BY month ORDER BY month ASC`;
  const expenseParams = user_id ? [months, user_id] : [months];
  const [expenseRows] = await pool.query(expenseSql, expenseParams);

  const salesMap = Object.fromEntries(salesRows.map((r) => [r.month, r.sales]));
  const expenseMap = Object.fromEntries(expenseRows.map((r) => [r.month, r.expenses]));
  const allMonths = Array.from(new Set([...Object.keys(salesMap), ...Object.keys(expenseMap)])).sort();

  const trend = allMonths.map((month) => ({
    month,
    sales: salesMap[month] || 0,
    expenses: expenseMap[month] || 0,
  }));

  res.json({ success: true, scope: user_id ? `user_id=${user_id}` : "all users", trend });
});

module.exports = { getProfitLoss, getMonthlyTrend };
