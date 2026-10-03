const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");

const resolvePeriodRange = (period, from, to) => {
  if (from || to) {
    return { from: from || null, to: to || null };
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  if (!period) return { from: null, to: null };

  const p = String(period).trim().toLowerCase();
  if (p === "today") {
    return { from: todayStr, to: todayStr };
  }
  if (p === "week" || p === "this_week" || p === "this week") {
    const d = new Date(now);
    const dayOfWeek = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dayOfWeek);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  if (p === "month" || p === "this_month" || p === "this month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  if (p === "6months" || p === "6_months" || p === "6-months") {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 6);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  if (p === "year" || p === "this_year" || p === "this year") {
    const d = new Date(now.getFullYear(), 0, 1);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }

  return { from: null, to: null };
};

// GET /api/reports/profit-loss?period=&from=&to=
// GET /api/reports?period=&from=&to=
const getProfitLoss = asyncHandler(async (req, res) => {
  const { period, from, to } = req.query;
  const user_id = req.user.id;

  const range = resolvePeriodRange(period, from, to);
  const rangeFrom = range.from;
  const rangeTo = range.to;

  const buildDateFilter = (dateCol) => {
    const clauses = ["created_by = ?"];
    const params = [user_id];
    if (rangeFrom) {
      clauses.push(`${dateCol} >= ?`);
      params.push(rangeFrom);
    }
    if (rangeTo) {
      clauses.push(`${dateCol} <= ?`);
      params.push(rangeTo);
    }
    return {
      clause: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
      params,
    };
  };

  // 1. TOTAL SALES / TOTAL CREDIT:
  // Collections (cash + online + due) + khata credit entries. Never add due_received payments.
  const salesFilter = buildDateFilter("sale_date");
  const [[income]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_type = 'online' THEN amount ELSE 0 END), 0) AS online,
       COALESCE(SUM(CASE WHEN payment_type = 'due' THEN amount ELSE 0 END), 0) AS due,
       COALESCE(SUM(amount), 0) AS total
     FROM collections ${salesFilter.clause}`,
    salesFilter.params
  );

  const khataCreditFilter = buildDateFilter("entry_date");
  const [[khataCredit]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM khata_entries
     ${khataCreditFilter.clause ? khataCreditFilter.clause + " AND " : "WHERE "}
     type = 'credit'`,
    khataCreditFilter.params
  );

  const totalSales = Math.round((Number(income.total || 0) + Number(khataCredit.total || 0)) * 100) / 100;
  const totalCredit = totalSales;

  // 2. TOTAL DEBIT:
  const khataDebitFilter = buildDateFilter("entry_date");
  const [[khataDebit]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM khata_entries
     ${khataDebitFilter.clause ? khataDebitFilter.clause + " AND " : "WHERE "}
     type = 'debit'`,
    khataDebitFilter.params
  );
  const totalDebit = Math.round(Number(khataDebit.total || 0) * 100) / 100;

  // 3. OUTSTANDING DUE:
  const dueFilter = buildDateFilter("COALESCE(due_date, DATE(created_at))");
  const [[outstandingDue]] = await pool.query(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total
     FROM customer_dues
     ${dueFilter.clause ? dueFilter.clause + " AND " : "WHERE "}
     status != 'settled'`,
    dueFilter.params
  );
  const totalDue = Math.round(Number(outstandingDue.total || 0) * 100) / 100;

  // 4. EXPENSES:
  //    a) Direct expenses from expenses table
  const expFilter = buildDateFilter("expense_date");
  const [[directExpenses]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses ${expFilter.clause}`,
    expFilter.params
  );

  //    b) Business payments / purchase bills from payments table
  const payFilterBase = buildDateFilter("payment_date");
  const [[businessPayments]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM payments
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     (payment_category IN ('paid_by_business', 'purchase_bill') OR purpose = 'Purchase Bill')`,
    payFilterBase.params
  );

  //    c) Unlinked Khata debits (only debits that are not linked to a payment, avoiding double counting)
  const [[unlinkedDebits]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM khata_entries
     ${khataDebitFilter.clause ? khataDebitFilter.clause + " AND " : "WHERE "}
     type = 'debit' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
    khataDebitFilter.params
  );

  const totalExpenses = Math.round(
    (Number(directExpenses.total || 0) +
      Number(businessPayments.total || 0) +
      Number(unlinkedDebits.total || 0)) *
      100
  ) / 100;

  // 5. INVESTOR ADVANCE (Reported separately as financing, not operational revenue)
  const [[advPayments]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM payments
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     (payment_category = 'advance_from_investor' OR purpose IN ('Investor Advance', 'Advance'))`,
    payFilterBase.params
  );

  const mrFilter = buildDateFilter("receipt_date");
  const [[unlinkedMrAdvances]] = await pool.query(
    `SELECT COALESCE(SUM(amount_received), 0) AS total
     FROM money_receipts
     ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
     against_type = 'advance' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
    mrFilter.params
  );

  const investorAdvance = Math.round(
    (Number(advPayments.total || 0) + Number(unlinkedMrAdvances.total || 0)) * 100
  ) / 100;

  // 6. NORMAL RECEIVED:
  const [[normalReceivedPayments]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM payments
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     payment_category = 'amount_received'`,
    payFilterBase.params
  );

  const [[unlinkedNormalMr]] = await pool.query(
    `SELECT COALESCE(SUM(amount_received), 0) AS total
     FROM money_receipts
     ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
     (against_type != 'advance' OR against_type IS NULL) AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
    mrFilter.params
  );

  const normalReceived = Math.round(
    (Number(normalReceivedPayments.total || 0) + Number(unlinkedNormalMr.total || 0)) * 100
  ) / 100;

  // 7. DUE RECEIVED FROM CUSTOMERS (Cash flow collection, not operational sales revenue)
  const [[dueReceived]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM payments
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     payment_category = 'due_received'`,
    payFilterBase.params
  );
  const totalDueReceived = Math.round(Number(dueReceived.total || 0) * 100) / 100;

  // 8. NET PROFIT = Total Sales - Expenses
  const netProfit = Math.round((totalSales - totalExpenses) * 100) / 100;

  res.json({
    success: true,
    scope: `user_id=${user_id}`,
    period: period || "custom",
    range: { from: rangeFrom || "all-time", to: rangeTo || "all-time" },
    total_sales: totalSales,
    total_credit: totalCredit,
    total_debit: totalDebit,
    due: totalDue,
    total_due: totalDue,
    normal_received: normalReceived,
    due_received: totalDueReceived,
    due_received_from_customers: totalDueReceived,
    advance_from_investor: investorAdvance,
    investor_advance: investorAdvance,
    expenses: totalExpenses,
    expenses_total: totalExpenses,
    expenses_breakdown: {
      direct_expenses: Number(directExpenses.total || 0),
      paid_by_business_payments: Number(businessPayments.total || 0),
      unlinked_khata_debits: Number(unlinkedDebits.total || 0),
    },
    paid_out_by_business: Number(businessPayments.total || 0),
    income_from_sales: income,
    profit_or_loss: netProfit,
    net_profit: netProfit,
    sales_vs_expenses: {
      sales: totalSales,
      expenses: totalExpenses,
    },
    note: "Net Profit = Total Sales - Expenses (direct expenses + business payments + unlinked khata debits). Investor Advances, Normal Received, and Due Collections are reported separately.",
  });
});

// GET /api/reports/monthly-trend?months=6
const getMonthlyTrend = asyncHandler(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const user_id = req.user.id;

  const salesSql = `
    SELECT month, COALESCE(SUM(sale_amount), 0) AS sales
    FROM (
      SELECT DATE_FORMAT(sale_date, '%Y-%m') AS month, amount AS sale_amount
      FROM collections
      WHERE sale_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH) AND created_by = ?

      UNION ALL

      SELECT DATE_FORMAT(entry_date, '%Y-%m') AS month, amount AS sale_amount
      FROM khata_entries
      WHERE entry_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH)
        AND created_by = ?
        AND type = 'credit'
    ) combined_sales
    GROUP BY month ORDER BY month ASC`;
  const [salesRows] = await pool.query(salesSql, [months, user_id, months, user_id]);

  const expenseSql = `
    SELECT month, COALESCE(SUM(exp_amount), 0) AS expenses
    FROM (
      SELECT DATE_FORMAT(expense_date, '%Y-%m') AS month, amount AS exp_amount
      FROM expenses
      WHERE expense_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH) AND created_by = ?

      UNION ALL

      SELECT DATE_FORMAT(payment_date, '%Y-%m') AS month, amount AS exp_amount
      FROM payments
      WHERE payment_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH)
        AND created_by = ?
        AND (payment_category IN ('paid_by_business', 'purchase_bill') OR purpose = 'Purchase Bill')

      UNION ALL

      SELECT DATE_FORMAT(entry_date, '%Y-%m') AS month, amount AS exp_amount
      FROM khata_entries
      WHERE entry_date >= DATE_SUB(CURRENT_DATE, INTERVAL ? MONTH)
        AND created_by = ?
        AND type = 'debit'
        AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)
    ) combined_exp
    GROUP BY month
    ORDER BY month ASC`;

  const [expenseRows] = await pool.query(expenseSql, [
    months,
    user_id,
    months,
    user_id,
    months,
    user_id,
  ]);

  const salesMap = Object.fromEntries(salesRows.map((r) => [r.month, Number(r.sales || 0)]));
  const expenseMap = Object.fromEntries(expenseRows.map((r) => [r.month, Number(r.expenses || 0)]));
  const allMonths = Array.from(new Set([...Object.keys(salesMap), ...Object.keys(expenseMap)])).sort();

  const trend = allMonths.map((month) => ({
    month,
    sales: salesMap[month] || 0,
    expenses: expenseMap[month] || 0,
  }));

  res.json({ success: true, scope: `user_id=${user_id}`, trend });
});

module.exports = {
  getProfitLoss,
  getReports: getProfitLoss,
  getSalesVsExpenses: getProfitLoss,
  getMonthlyTrend,
};
