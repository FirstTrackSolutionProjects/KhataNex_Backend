const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { getTenantContext, hasPermission } = require("../utils/tenantContext");

const formatLocalDate = (d) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const resolveEffectiveUserId = (req) => {
  if (req && req.user && req.user.role === "superadmin") {
    const rawId =
      req.query?.user_id ||
      req.query?.userId ||
      req.query?.id ||
      req.params?.user_id ||
      req.params?.userId;
    if (rawId && Number(rawId) > 0) {
      return Number(rawId);
    }
  }
  if (req && req.user && req.user.role === "employee") {
    if (!hasPermission(req.user, "reports", "view")) {
      throw new ApiError(403, "You do not have permission to view reports.");
    }
  }
  const tenant = getTenantContext(req);
  return tenant.businessOwnerId;
};

const resolvePeriodRange = (periodOrQuery, fromParam, toParam) => {
  let period = periodOrQuery;
  let from = fromParam;
  let to = toParam;

  if (periodOrQuery && typeof periodOrQuery === "object") {
    period = periodOrQuery.period || periodOrQuery.timeframe || periodOrQuery.range;
    from = periodOrQuery.from || periodOrQuery.start_date || periodOrQuery.startDate;
    to = periodOrQuery.to || periodOrQuery.end_date || periodOrQuery.endDate;
  }

  if (from || to) {
    return { from: from || null, to: to || null };
  }

  const now = new Date();
  const todayStr = formatLocalDate(now);

  if (!period) return { from: null, to: null };

  const p = String(period).trim().toLowerCase();
  if (p === "today") {
    return { from: todayStr, to: todayStr };
  }
  if (p === "week" || p === "this_week" || p === "this week" || p === "7d") {
    const d = new Date(now);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayOfWeek);
    return { from: formatLocalDate(d), to: todayStr };
  }
  if (p === "month" || p === "this_month" || p === "this month" || p === "30d") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: formatLocalDate(d), to: todayStr };
  }
  if (p === "year" || p === "this_year" || p === "this year") {
    const d = new Date(now.getFullYear(), 0, 1);
    return { from: formatLocalDate(d), to: todayStr };
  }
  if (
    p === "6months" ||
    p === "6_months" ||
    p === "6-months" ||
    p === "last_6_months" ||
    p === "last 6 months" ||
    p === "last-6-months" ||
    p === "6m"
  ) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 6);
    return { from: formatLocalDate(d), to: todayStr };
  }
  if (
    p === "12months" ||
    p === "12_months" ||
    p === "12-months" ||
    p === "last_12_months" ||
    p === "last 12 months" ||
    p === "last-12-months" ||
    p === "12m"
  ) {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - 1);
    return { from: formatLocalDate(d), to: todayStr };
  }

  return { from: null, to: null };
};

const buildDateFilter = (userId, dateCol, rangeFrom, rangeTo) => {
  let createdByCol = "created_by";
  if (dateCol) {
    const match = dateCol.match(/\b([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/);
    if (match) {
      createdByCol = `${match[1]}.created_by`;
    }
  }
  const clauses = [`${createdByCol} = ?`];
  const params = [userId];
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

/**
 * Calculates all core report metrics for a user across a given date range.
 * 1. Total Sales = Credit / Sale of Product transactions (collections + khata credit entries)
 * 2. Purchases = Purchase Bills (separate from Expenses)
 * 3. Expenses = Khata Debit entries + business payouts (Payments paid_out) + advance-payable payouts (Payments advance_payable) + direct expenses
 * 4. Advance Receivable = Investor Advances (Payments advance_receivable + money receipts advance)
 * 5. Advance Payable = Advances paid out by user/superadmin (Payments advance_payable)
 * 6. Cash in Hand = Cash-mode credit/received transactions + Cash Advance Receivable
 * 7. Cash in Bank = UPI/Bank-mode credit/received transactions + Bank/UPI Advance Receivable
 * 8. Net Profit = Total Sales - Expenses
 */
const calculateReportMetrics = async (userId, rangeFrom, rangeTo) => {
  // 1. TOTAL SALES: Collections + Khata Credit entries
  const salesFilter = buildDateFilter(userId, "sale_date", rangeFrom, rangeTo);
  const [[salesSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_type = 'online' THEN amount ELSE 0 END), 0) AS online,
       COALESCE(SUM(CASE WHEN payment_type = 'due' THEN amount ELSE 0 END), 0) AS due,
       COALESCE(SUM(amount), 0) AS total
     FROM collections ${salesFilter.clause}`,
    salesFilter.params
  );

  const khataCreditFilter = buildDateFilter(userId, "entry_date", rangeFrom, rangeTo);
  const [[khataCreditSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' OR payment_mode IS NULL OR payment_mode = '' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online,
       COALESCE(SUM(amount), 0) AS total
     FROM khata_entries
     ${khataCreditFilter.clause ? khataCreditFilter.clause + " AND " : "WHERE "}
     type = 'credit'`,
    khataCreditFilter.params
  );

  const [[creditCountSummary]] = await pool.query(
    `SELECT (
       (SELECT COUNT(*) FROM collections ${salesFilter.clause})
       +
       (SELECT COUNT(*) FROM khata_entries ${khataCreditFilter.clause ? khataCreditFilter.clause + " AND " : "WHERE "} type = 'credit')
     ) AS count`,
    [...salesFilter.params, ...khataCreditFilter.params]
  );
  const creditEntriesCount = Number(creditCountSummary?.count || 0);

  const totalSales = Math.round((Number(salesSummary.total || 0) + Number(khataCreditSummary.total || 0)) * 100) / 100;

  // 2. PURCHASES: Purchase Bills (separate from Expenses)
  const pbFilter = buildDateFilter(userId, "DATE(pb.bill_date)", rangeFrom, rangeTo);
  const [pbRows] = await pool.query(
    `SELECT pb.id,
            COALESCE(
              NULLIF(
                ROUND(
                  SUM(
                    GREATEST(0, (COALESCE(pbi.quantity, 0) * COALESCE(pbi.price, 0) - COALESCE(pbi.discount, 0))) *
                    (1 + COALESCE(pbi.gst_rate, 0) / 100)
                  ), 2
                ), 0
              ),
              p.amount,
              0
            ) AS bill_total
     FROM purchase_bills pb
     LEFT JOIN purchase_bill_items pbi ON pbi.purchase_bill_id = pb.id
     LEFT JOIN payments p ON p.id = pb.payment_id
     ${pbFilter.clause}
     GROUP BY pb.id`,
    pbFilter.params
  );
  const totalPurchases = Math.round(
    pbRows.reduce((acc, r) => acc + Math.round(Number(r.bill_total || 0) * 100) / 100, 0) * 100
  ) / 100;

  // 3. EXPENSES:
  // a) Debit entries: strictly from Khata Debit entries
  const kdDateCol = "COALESCE(ke.entry_date, DATE(ke.created_at))";
  const khataDebitFilter = buildDateFilter(userId, kdDateCol, rangeFrom, rangeTo);
  const [[khataDebitSummary]] = await pool.query(
    `SELECT
       COUNT(*) AS count,
       COALESCE(SUM(amount), 0) AS total
     FROM khata_entries ke
     ${khataDebitFilter.clause ? khataDebitFilter.clause + " AND " : "WHERE "}
     ke.type = 'debit'`,
    khataDebitFilter.params
  );
  const debitEntriesAmount = Math.round(Number(khataDebitSummary.total || 0) * 100) / 100;
  const debitEntriesCount = Number(khataDebitSummary?.count || 0);

  // b) Business Pay Out: strictly paid_by_business / paid_out payments (unlinked to khata debits or purchase bills)
  const payDateCol = "COALESCE(p.payment_date, DATE(p.created_at))";
  const paidOutFilter = buildDateFilter(userId, payDateCol, rangeFrom, rangeTo);
  const [[bizPayoutSummary]] = await pool.query(
    `SELECT
       COUNT(*) AS count,
       COALESCE(SUM(amount), 0) AS total
     FROM payments p
     ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
     p.payment_category IN ('paid_by_business', 'paid_out')
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)
     AND (p.purchase_bill_id IS NULL OR p.purchase_bill_id = 0)
     AND p.id NOT IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
     AND p.purpose NOT LIKE 'Purchase Bill%'`,
    paidOutFilter.params
  );
  const businessPayOut = Math.round(Number(bizPayoutSummary.total || 0) * 100) / 100;
  const businessPayOutCount = Number(bizPayoutSummary?.count || 0);

  // c) Advance Payable: advance_payable payments
  const [[advPaySummary]] = await pool.query(
    `SELECT
       COUNT(*) AS count,
       COALESCE(SUM(amount), 0) AS total
     FROM payments p
     ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
     p.payment_category = 'advance_payable'
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
    paidOutFilter.params
  );
  const advancePayable = Math.round(Number(advPaySummary.total || 0) * 100) / 100;
  const advancePayableCount = Number(advPaySummary?.count || 0);

  // d) Other Expenses: direct expenses from expenses table
  const expDateCol = "COALESCE(e.expense_date, DATE(e.created_at))";
  const expFilter = buildDateFilter(userId, expDateCol, rangeFrom, rangeTo);
  const [[directExpSummary]] = await pool.query(
    `SELECT
       COUNT(*) AS count,
       COALESCE(SUM(amount), 0) AS total
     FROM expenses e
     ${expFilter.clause}`,
    expFilter.params
  );
  const otherExpenses = Math.round(Number(directExpSummary.total || 0) * 100) / 100;
  const otherExpensesCount = Number(directExpSummary?.count || 0);

  // Total Expenses = purchases + debit entries + business pay out + advance payable + other expenses
  const totalExpenses = Math.round(
    (totalPurchases + debitEntriesAmount + businessPayOut + advancePayable + otherExpenses) * 100
  ) / 100;

  // 4. ADVANCE RECEIVABLE: Investor Advances
  const payFilterBase = buildDateFilter(userId, payDateCol, rangeFrom, rangeTo);
  const [[advRecPaymentsSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online,
       COALESCE(SUM(amount), 0) AS total
     FROM payments p
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     (p.payment_category IN ('advance_receivable', 'advance_from_investor') OR p.purpose IN ('Investor Advance', 'Advance'))`,
    payFilterBase.params
  );

  const mrFilter = buildDateFilter(userId, "COALESCE(receipt_date, DATE(created_at))", rangeFrom, rangeTo);
  const [[unlinkedMrAdvancesSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount_received ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank', 'cheque', 'neft', 'rtgs') THEN amount_received ELSE 0 END), 0) AS online,
       COALESCE(SUM(amount_received), 0) AS total
     FROM money_receipts
     ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
     against_type = 'advance' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
    mrFilter.params
  );

  const advanceReceivable = Math.round(
    (Number(advRecPaymentsSummary.total || 0) + Number(unlinkedMrAdvancesSummary.total || 0)) * 100
  ) / 100;

  // 5. CASH IN HAND & CASH IN BANK (Incoming minus Outflows):
  // Unlinked normal received payments:
  const [[normalRecPaymentsSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online,
       COALESCE(SUM(amount), 0) AS total
     FROM payments p
     ${payFilterBase.clause ? payFilterBase.clause + " AND " : "WHERE "}
     p.payment_category IN ('money_received', 'amount_received')
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
    payFilterBase.params
  );

  // Unlinked normal money receipts:
  const [[unlinkedNormalMrSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount_received ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank', 'cheque', 'neft', 'rtgs') THEN amount_received ELSE 0 END), 0) AS online,
       COALESCE(SUM(amount_received), 0) AS total
     FROM money_receipts
     ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
     (against_type != 'advance' OR against_type IS NULL) AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
    mrFilter.params
  );

  // Inflows:
  const totalCashInflow =
    Number(salesSummary.cash || 0) +
    Number(khataCreditSummary.cash || 0) +
    Number(normalRecPaymentsSummary.cash || 0) +
    Number(unlinkedNormalMrSummary.cash || 0) +
    Number(advRecPaymentsSummary.cash || 0) +
    Number(unlinkedMrAdvancesSummary.cash || 0);

  const totalBankInflow =
    Number(salesSummary.online || 0) +
    Number(khataCreditSummary.online || 0) +
    Number(normalRecPaymentsSummary.online || 0) +
    Number(unlinkedNormalMrSummary.online || 0) +
    Number(advRecPaymentsSummary.online || 0) +
    Number(unlinkedMrAdvancesSummary.online || 0);

  // Outflows:
  // a) Khata debits cash vs upi
  const [[khataDebitModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' OR payment_mode IS NULL OR payment_mode = '' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online
     FROM khata_entries ke
     ${khataDebitFilter.clause ? khataDebitFilter.clause + " AND " : "WHERE "}
     ke.type = 'debit'`,
    khataDebitFilter.params
  );

  // b) Paid out payments cash vs upi
  const [[paidOutModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online
     FROM payments p
     ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
     p.payment_category = 'paid_out'
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)
     AND (p.purchase_bill_id IS NULL OR p.purchase_bill_id = 0)
     AND p.id NOT IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
     AND p.purpose NOT LIKE 'Purchase Bill%'`,
    paidOutFilter.params
  );

  // c) Business payouts cash vs upi (strictly paid_by_business)
  const [[businessPayoutsModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online
     FROM payments p
     ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
     p.payment_category = 'paid_by_business'
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)
     AND (p.purchase_bill_id IS NULL OR p.purchase_bill_id = 0)
     AND p.id NOT IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
     AND p.purpose NOT LIKE 'Purchase Bill%'`,
    paidOutFilter.params
  );

  // d) Purchases cash vs upi (payments linked to purchase bills)
  const [[pbPaymentModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online
     FROM (
       SELECT MAX(p.payment_mode) AS payment_mode, MAX(p.amount) AS amount
       FROM payments p
       ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
       (
         (p.purchase_bill_id IS NOT NULL AND p.purchase_bill_id > 0)
         OR p.id IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
         OR p.purpose LIKE 'Purchase Bill%'
       )
       GROUP BY COALESCE(NULLIF(p.purchase_bill_id, 0), p.id)
     ) sub`,
    paidOutFilter.params
  );

  // e) Advance payable payouts cash vs upi (unlinked to khata debits)
  const [[advPayableModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN payment_mode IN ('online', 'upi', 'bank') THEN amount ELSE 0 END), 0) AS online
     FROM payments p
     ${paidOutFilter.clause ? paidOutFilter.clause + " AND " : "WHERE "}
     p.payment_category = 'advance_payable'
     AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
    paidOutFilter.params
  );

  // f) Direct expenses cash outflow
  const [[directExpModeSummary]] = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0) AS cash,
       0 AS online
     FROM expenses e ${expFilter.clause}`,
    expFilter.params
  );

  const totalCashOutflow =
    Number(khataDebitModeSummary.cash || 0) +
    Number(paidOutModeSummary.cash || 0) +
    Number(businessPayoutsModeSummary.cash || 0) +
    Number(pbPaymentModeSummary.cash || 0) +
    Number(advPayableModeSummary.cash || 0) +
    Number(directExpModeSummary.cash || 0);

  const totalBankOutflow =
    Number(khataDebitModeSummary.online || 0) +
    Number(paidOutModeSummary.online || 0) +
    Number(businessPayoutsModeSummary.online || 0) +
    Number(pbPaymentModeSummary.online || 0) +
    Number(advPayableModeSummary.online || 0) +
    Number(directExpModeSummary.online || 0);

  const cashInHand = Math.round((totalCashInflow - totalCashOutflow) * 100) / 100;
  const cashInBank = Math.round((totalBankInflow - totalBankOutflow) * 100) / 100;

  // 6. NET PROFIT = Recognized Sales - Recognized Expenses (advances are NOT revenue/expense)
  const recognizedExpenses = Math.round(
    (totalPurchases + debitEntriesAmount + businessPayOut + otherExpenses) * 100
  ) / 100;
  const netProfit = Math.round((totalSales - recognizedExpenses) * 100) / 100;

  return {
    totalSales,
    totalPurchases,
    totalExpenses,
    totalExpense: totalExpenses,
    advanceReceivable,
    advancePayable,
    cashInHand,
    cashInBank,
    purchases: totalPurchases,
    business_pay_out: businessPayOut,
    business_payout: businessPayOut,
    business_pay_out_count: businessPayOutCount,
    credit_entries: creditEntriesCount,
    debit_entries: debitEntriesAmount,
    credit_entries_count: creditEntriesCount,
    debit_entries_count: debitEntriesCount,
    creditEntriesCount,
    debitEntriesCount,
    debitEntriesAmount,
    breakdown: {
      purchases: totalPurchases,
      debit_entries: debitEntriesAmount,
      debit_entries_count: debitEntriesCount,
      credit_entries: creditEntriesCount,
      credit_entries_count: creditEntriesCount,
      business_pay_out: businessPayOut,
      business_pay_out_count: businessPayOutCount,
      advance_payable: advancePayable,
      advance_payable_count: advancePayableCount,
      other_expenses: otherExpenses,
      other_expenses_count: otherExpensesCount,
      directExpenses: otherExpenses,
      khataDebits: Math.round(Number(khataDebitSummary.total || 0) * 100) / 100,
      unlinkedBusinessPayouts: businessPayOut,
      salesFromCollections: Number(salesSummary.total || 0),
      salesFromKhataCredit: Number(khataCreditSummary.total || 0),
    },
  };
};

// GET /api/reports/profit-loss?period=&from=&to=
// GET /api/reports?period=&from=&to=
const getProfitLoss = asyncHandler(async (req, res) => {
  const { period, from, to } = req.query;
  const user_id = resolveEffectiveUserId(req);

  const range = resolvePeriodRange(period, from, to);
  const rangeFrom = range.from;
  const rangeTo = range.to;

  const metrics = await calculateReportMetrics(user_id, rangeFrom, rangeTo);

  res.json({
    success: true,
    scope: `user_id=${user_id}`,
    period: period || "custom",
    range: { from: rangeFrom || "all-time", to: rangeTo || "all-time" },

    // Primary requested accounting metrics
    total_sales: metrics.totalSales,
    sales: metrics.totalSales,
    purchases: metrics.totalPurchases,
    total_purchases: metrics.totalPurchases,
    total_expense: metrics.totalExpenses,
    total_expenses: metrics.totalExpenses,
    expenses: metrics.totalExpenses,
    advance_receivable: metrics.advanceReceivable,
    investor_advance: metrics.advanceReceivable,
    advance_payable: metrics.advancePayable,
    cash_in_hand: metrics.cashInHand,
    cash_in_bank: metrics.cashInBank,
    net_profit: metrics.netProfit,
    profit_or_loss: metrics.netProfit,

    credit_entries: metrics.creditEntriesCount,
    debit_entries: metrics.debit_entries,
    debit_entry: metrics.debit_entries,
    debit_entries_amount: metrics.debit_entries,
    debit_entries_total: metrics.debit_entries,
    credit_entries_count: metrics.creditEntriesCount,
    debit_entries_count: metrics.debit_entries_count,
    debit_entry_count: metrics.debit_entries_count,
    business_pay_out: metrics.breakdown.business_pay_out,
    business_payout: metrics.breakdown.business_pay_out,
    business_pay_out_count: metrics.breakdown.business_pay_out_count,
    other_expenses: metrics.breakdown.other_expenses,
    other_expenses_count: metrics.breakdown.other_expenses_count,

    // Structured breakdown for transparency
    expenses_breakdown: {
      purchases: metrics.breakdown.purchases,
      debit_entries: metrics.breakdown.debit_entries,
      debit_entries_count: metrics.breakdown.debit_entries_count,
      credit_entries: metrics.breakdown.credit_entries,
      credit_entries_count: metrics.breakdown.credit_entries_count,
      business_pay_out: metrics.breakdown.business_pay_out,
      business_pay_out_count: metrics.breakdown.business_pay_out_count,
      advance_payable: metrics.breakdown.advance_payable,
      advance_payable_count: metrics.breakdown.advance_payable_count,
      other_expenses: metrics.breakdown.other_expenses,
      other_expenses_count: metrics.breakdown.other_expenses_count,
      direct_expenses: metrics.breakdown.directExpenses,
      khata_debits: metrics.breakdown.khataDebits,
      paid_out_payments: metrics.breakdown.debit_entries - metrics.breakdown.khataDebits,
    },
    breakdown: metrics.breakdown,
    sales_vs_expenses: {
      sales: metrics.totalSales,
      total_expense: metrics.totalExpenses,
      expenses: metrics.totalExpenses,
      purchases: metrics.totalPurchases,
      net_profit: metrics.netProfit,
    },
    sales_vs_expenses_vs_purchases: {
      sales: metrics.totalSales,
      total_expense: metrics.totalExpenses,
      expenses: metrics.totalExpenses,
      purchases: metrics.totalPurchases,
      net_profit: metrics.netProfit,
    },
  });
});

/**
 * Calculates graph points for Sales vs Total Expense graph across any requested period:
 * Graph ONLY "Sales vs Total Expense": one aggregate pair for selected period, NOT Jan/Feb/monthly buckets.
 * Today / Week / Month / Year / 6M / 12M / custom Start-End = totals for that entire period.
 */
const calculateGraphPoints = async (userId, rawPeriod, fromParam, toParam) => {
  const range = resolvePeriodRange(rawPeriod, fromParam, toParam);
  let p = String(rawPeriod || "").trim().toLowerCase();

  let label = "Selected Period";
  if (p === "today") {
    label = "Today";
  } else if (p === "this_week" || p === "week" || p === "this week" || p === "7d") {
    label = "This Week";
  } else if (p === "this_month" || p === "month" || p === "this month" || p === "30d") {
    label = "This Month";
  } else if (p === "this_year" || p === "year" || p === "this year") {
    label = "This Year";
  } else if (
    p === "6months" ||
    p === "6_months" ||
    p === "6-months" ||
    p === "last_6_months" ||
    p === "last 6 months" ||
    p === "last-6-months" ||
    p === "6m"
  ) {
    label = "Last 6 Months";
  } else if (
    p === "12months" ||
    p === "12_months" ||
    p === "12-months" ||
    p === "last_12_months" ||
    p === "last 12 months" ||
    p === "last-12-months" ||
    p === "12m"
  ) {
    label = "Last 12 Months";
  } else if (range.from && range.to) {
    label = range.from === range.to ? range.from : `${range.from} to ${range.to}`;
  } else if (range.from) {
    label = `From ${range.from}`;
  } else if (range.to) {
    label = `Until ${range.to}`;
  }

  const metrics = await calculateReportMetrics(userId, range.from, range.to);

  const points = [
    {
      label,
      period: p || "custom",
      from: range.from || null,
      to: range.to || null,
      sales: metrics.totalSales,
      total_expense: metrics.totalExpenses,
      expenses: metrics.totalExpenses,
      purchases: metrics.totalPurchases,
      net_profit: metrics.netProfit,
    },
  ];

  return points;
};

// GET /api/reports/monthly-trend or /api/reports/graph or /api/reports/sales-vs-expense-graph
// Supports periods: Today, This Week, This Month, Last 6 Months, Last 12 Months, custom dates
const getMonthlyTrend = asyncHandler(async (req, res) => {
  const user_id = resolveEffectiveUserId(req);
  const rawPeriod = String(req.query.period || req.query.timeframe || req.query.range || "").trim().toLowerCase();
  const from = req.query.from || req.query.start_date || req.query.startDate;
  const to = req.query.to || req.query.end_date || req.query.endDate;
  const monthsParam = Number(req.query.months);

  let p = rawPeriod;
  if (!p) {
    if (monthsParam === 12) p = "last_12_months";
    else if (from || to) p = "custom";
    else p = "last_6_months";
  }

  const points = await calculateGraphPoints(user_id, p, from, to);

  res.json({
    success: true,
    scope: `user_id=${user_id}`,
    period: p,
    points,
    trend: points,
    graph: points,
    sales_vs_expenses: points,
  });
});

/**
 * 9. REPORTS DRILL-DOWN APIS:
 * Detailed transaction lists for each report card metric:
 * - total-sales
 * - purchases
 * - expenses
 * - advance-receivable
 * - advance-payable
 * - cash-in-hand
 * - cash-in-bank
 * - net-profit
 */
const sortTransactionsChronologicalDesc = (list) => {
  return list.slice().sort((a, b) => {
    const dA = a.date ? String(a.date).slice(0, 10) : (a.created_at ? new Date(a.created_at).toISOString().slice(0, 10) : "");
    const dB = b.date ? String(b.date).slice(0, 10) : (b.created_at ? new Date(b.created_at).toISOString().slice(0, 10) : "");
    if (dA !== dB) {
      return dB.localeCompare(dA);
    }
    const tA = a.time ? String(a.time).slice(0, 8) : (a.created_at ? new Date(a.created_at).toTimeString().slice(0, 8) : "00:00:00");
    const tB = b.time ? String(b.time).slice(0, 8) : (b.created_at ? new Date(b.created_at).toTimeString().slice(0, 8) : "00:00:00");
    if (tA !== tB) {
      return tB.localeCompare(tA);
    }
    return Number(b.id || 0) - Number(a.id || 0);
  });
};

const executeReportDrilldown = async (userId, metricParam, period, from, to, categoryParam = "") => {
  const range = resolvePeriodRange(period, from, to);
  const rangeFrom = range.from;
  const rangeTo = range.to;

  const rawMetric = String(metricParam || "").trim().toLowerCase();
  const normalizedMetric = rawMetric
    .replace(/\s+/g, "-")
    .replace(/_/g, "-");

  let transactions = [];
  let metricLabel = "";

  switch (normalizedMetric) {
    case "total-sales":
    case "sales": {
      metricLabel = "Total Sales";
      const salesFilter = buildDateFilter(userId, "c.sale_date", rangeFrom, rangeTo);
      const [colRows] = await pool.query(
        `SELECT c.id, c.amount, c.sale_date AS date, TIME(c.created_at) AS time, c.created_at,
                CASE WHEN c.payment_type = 'due' THEN 'credit' ELSE COALESCE(NULLIF(c.payment_type, ''), 'cash') END AS payment_mode,
                CASE WHEN c.payment_type = 'due' THEN 'credit' ELSE COALESCE(NULLIF(c.payment_type, ''), 'cash') END AS mode,
                c.item_name AS description, c.item_name AS purpose,
                COALESCE(cu.name, 'Walk-in') AS party, COALESCE(cu.name, 'Walk-in') AS customer, COALESCE(cu.name, 'Walk-in') AS customer_name,
                'Sales' AS category,
                'collection' AS source
          FROM collections c
          LEFT JOIN customers cu ON cu.id = c.customer_id
          ${salesFilter.clause}`,
        salesFilter.params
      );

      const khataCreditFilter = buildDateFilter(userId, "ke.entry_date", rangeFrom, rangeTo);
      const [keRows] = await pool.query(
        `SELECT ke.id, ke.amount, ke.entry_date AS date, COALESCE(ke.entry_time, TIME(ke.created_at)) AS time, ke.created_at,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS mode,
                ke.description, ke.description AS purpose,
                COALESCE(cu.name, 'Walk-in') AS party, COALESCE(cu.name, 'Walk-in') AS customer, COALESCE(cu.name, 'Walk-in') AS customer_name,
                'Sales' AS category,
                'khata_credit' AS source
          FROM khata_entries ke
          LEFT JOIN customers cu ON cu.id = ke.customer_id
          ${khataCreditFilter.clause ? khataCreditFilter.clause + " AND " : "WHERE "}
          ke.type = 'credit'`,
        khataCreditFilter.params
      );

      transactions = sortTransactionsChronologicalDesc([...colRows, ...keRows]);
      break;
    }

    case "purchases":
    case "total-purchases":
    case "purchase-bills":
    case "purchase_bills":
    case "purchase-bill":
    case "purchases-drilldown": {
      metricLabel = "Purchases";
      const pbFilter = buildDateFilter(userId, "DATE(pb.bill_date)", rangeFrom, rangeTo);
      const [pbRows] = await pool.query(
        `SELECT pb.id, pb.bill_number, pb.vendor_name, pb.vendor_name AS party, pb.vendor_name AS customer,
                pb.vendor_name AS customer_name,
                pb.bill_date AS date,
                pb.created_at,
                TIME(pb.created_at) AS time,
                COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS payment_mode,
                COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS mode,
                COALESCE(
                  NULLIF(
                    ROUND(
                      SUM(
                        GREATEST(0, (COALESCE(pbi.quantity, 0) * COALESCE(pbi.price, 0) - COALESCE(pbi.discount, 0))) *
                        (1 + COALESCE(pbi.gst_rate, 0) / 100)
                      ), 2
                    ), 0
                  ),
                  p.amount,
                  0
                ) AS amount,
                GROUP_CONCAT(DISTINCT pbi.item_name SEPARATOR ', ') AS description,
                GROUP_CONCAT(DISTINCT pbi.item_name SEPARATOR ', ') AS purpose,
                'Purchases' AS category,
                'purchase_bill' AS source
         FROM purchase_bills pb
         LEFT JOIN purchase_bill_items pbi ON pbi.purchase_bill_id = pb.id
         LEFT JOIN payments p ON p.id = pb.payment_id
         ${pbFilter.clause}
         GROUP BY pb.id
         ORDER BY pb.bill_date DESC, pb.id DESC`,
        pbFilter.params
      );
      transactions = sortTransactionsChronologicalDesc(pbRows);
      break;
    }

    case "debit-entries":
    case "debit_entries":
    case "debit-entry":
    case "khata-debits":
    case "khata_debits":
    case "debits":
    case "debit":
    case "khata":
    case "khata-entries":
    case "khata_entries": {
      metricLabel = "Debit Entries";
      const kdFilter = buildDateFilter(userId, "COALESCE(ke.entry_date, DATE(ke.created_at))", rangeFrom, rangeTo);
      const [kdRows] = await pool.query(
        `SELECT ke.id, ke.amount, COALESCE(ke.entry_date, DATE(ke.created_at)) AS date,
                COALESCE(ke.entry_time, TIME(ke.created_at)) AS time, ke.created_at,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS mode,
                ke.description, ke.description AS purpose,
                COALESCE(cu.name, 'Walk-in') AS party, COALESCE(cu.name, 'Walk-in') AS customer, COALESCE(cu.name, 'Walk-in') AS customer_name,
                s.product_name, ke.quantity, ke.unit_price,
                'Debit' AS category,
                'khata_debit' AS source
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         LEFT JOIN stock s ON s.id = ke.product_id
         ${kdFilter.clause ? kdFilter.clause + " AND " : "WHERE "}
         ke.type = 'debit'`,
        kdFilter.params
      );

      transactions = sortTransactionsChronologicalDesc(kdRows);
      break;
    }

    case "pay-out":
    case "payout":
    case "business-pay-out":
    case "business-payout":
    case "business_pay_out":
    case "paid-by-business":
    case "payouts": {
      metricLabel = "Business Pay Out";
      const payFilter = buildDateFilter(userId, "COALESCE(p.payment_date, DATE(p.created_at))", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT p.id, p.amount, COALESCE(p.payment_date, DATE(p.created_at)) AS date, TIME(p.created_at) AS time, p.created_at,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS mode,
                p.purpose AS description, p.purpose,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS party,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS customer,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS customer_name,
                'Business Pay Out' AS category,
                'payment_payout' AS source
         FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         p.payment_category IN ('paid_by_business', 'paid_out')
         AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)
         AND (p.purchase_bill_id IS NULL OR p.purchase_bill_id = 0)
         AND p.id NOT IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
         AND p.purpose NOT LIKE 'Purchase Bill%'`,
        payFilter.params
      );
      transactions = sortTransactionsChronologicalDesc(payRows);
      break;
    }

    case "expenses":
    case "total-expenses":
    case "total-expense": {
      metricLabel = "Total Expenses";

      // 1. Purchases
      const pbFilter = buildDateFilter(userId, "DATE(pb.bill_date)", rangeFrom, rangeTo);
      const [pbRows] = await pool.query(
        `SELECT pb.id, pb.bill_number, pb.vendor_name, pb.vendor_name AS party, pb.vendor_name AS customer,
                pb.vendor_name AS customer_name,
                pb.bill_date AS date,
                pb.created_at,
                TIME(pb.created_at) AS time,
                COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS payment_mode,
                COALESCE(p.payment_mode, CASE WHEN pb.is_paid = 1 THEN 'cash' ELSE 'unpaid' END) AS mode,
                COALESCE(
                  NULLIF(
                    ROUND(
                      SUM(
                        GREATEST(0, (COALESCE(pbi.quantity, 0) * COALESCE(pbi.price, 0) - COALESCE(pbi.discount, 0))) *
                        (1 + COALESCE(pbi.gst_rate, 0) / 100)
                      ), 2
                    ), 0
                  ),
                  p.amount,
                  0
                ) AS amount,
                GROUP_CONCAT(DISTINCT pbi.item_name SEPARATOR ', ') AS description,
                GROUP_CONCAT(DISTINCT pbi.item_name SEPARATOR ', ') AS purpose,
                'Purchases' AS category,
                'purchase_bill' AS source
         FROM purchase_bills pb
         LEFT JOIN purchase_bill_items pbi ON pbi.purchase_bill_id = pb.id
         LEFT JOIN payments p ON p.id = pb.payment_id
         ${pbFilter.clause}
         GROUP BY pb.id
         ORDER BY pb.bill_date DESC, pb.id DESC`,
        pbFilter.params
      );

      // 2. Debit Entries (strictly Khata debits)
      const kdFilter = buildDateFilter(userId, "COALESCE(ke.entry_date, DATE(ke.created_at))", rangeFrom, rangeTo);
      const [kdRows] = await pool.query(
        `SELECT ke.id, ke.amount, COALESCE(ke.entry_date, DATE(ke.created_at)) AS date,
                COALESCE(ke.entry_time, TIME(ke.created_at)) AS time, ke.created_at,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(ke.payment_mode, ''), 'cash') AS mode,
                ke.description, ke.description AS purpose,
                COALESCE(cu.name, 'Walk-in') AS party, COALESCE(cu.name, 'Walk-in') AS customer, COALESCE(cu.name, 'Walk-in') AS customer_name,
                s.product_name, ke.quantity, ke.unit_price,
                'Debit' AS category,
                'khata_debit' AS source
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         LEFT JOIN stock s ON s.id = ke.product_id
         ${kdFilter.clause ? kdFilter.clause + " AND " : "WHERE "}
         ke.type = 'debit'`,
        kdFilter.params
      );

      // 3. Business Pay Out
      const payFilter = buildDateFilter(userId, "COALESCE(p.payment_date, DATE(p.created_at))", rangeFrom, rangeTo);
      const [bizPayoutRowsRaw] = await pool.query(
        `SELECT p.id, p.amount, COALESCE(p.payment_date, DATE(p.created_at)) AS date, TIME(p.created_at) AS time, p.created_at,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS mode,
                p.purpose AS description, p.purpose,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS party,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS customer,
                COALESCE(cu.name, p.party_name, 'Vendor/Party') AS customer_name,
                'Business Pay Out' AS category,
                'payment_payout' AS source
         FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         p.payment_category IN ('paid_by_business', 'paid_out')
         AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)
         AND (p.purchase_bill_id IS NULL OR p.purchase_bill_id = 0)
         AND p.id NOT IN (SELECT COALESCE(payment_id, 0) FROM purchase_bills WHERE created_by = p.created_by)
         AND p.purpose NOT LIKE 'Purchase Bill%'`,
        payFilter.params
      );

      // 4. Advance Payable
      const [advPayableRowsRaw] = await pool.query(
        `SELECT p.id, p.amount, COALESCE(p.payment_date, DATE(p.created_at)) AS date, TIME(p.created_at) AS time, p.created_at,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(p.payment_mode, ''), 'cash') AS mode,
                p.purpose AS description, p.purpose,
                COALESCE(cu.name, p.party_name, 'Party') AS party,
                COALESCE(cu.name, p.party_name, 'Party') AS customer,
                COALESCE(cu.name, p.party_name, 'Party') AS customer_name,
                'Advance Payable' AS category,
                'payment_advance_payable' AS source
         FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         p.payment_category = 'advance_payable'
         AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
        payFilter.params
      );

      // 5. Other Expenses
      const expFilter = buildDateFilter(userId, "COALESCE(e.expense_date, DATE(e.created_at))", rangeFrom, rangeTo);
      const [expRowsRaw] = await pool.query(
        `SELECT id, amount, COALESCE(expense_date, DATE(created_at)) AS date,
                TIME(created_at) AS time, created_at,
                'cash' AS payment_mode, 'cash' AS mode,
                description, description AS purpose,
                'Walk-in' AS party, 'Walk-in' AS customer, 'Walk-in' AS customer_name,
                'Other Expenses' AS category,
                'direct_expense' AS source
         FROM expenses e ${expFilter.clause}`,
        expFilter.params
      );

      const pbRowsSorted = sortTransactionsChronologicalDesc(pbRows);
      const debitRows = sortTransactionsChronologicalDesc(kdRows);
      const bizPayoutRows = sortTransactionsChronologicalDesc(bizPayoutRowsRaw);
      const advPayableRows = sortTransactionsChronologicalDesc(advPayableRowsRaw);
      const expRows = sortTransactionsChronologicalDesc(expRowsRaw);

      const pbTotal = Math.round(pbRowsSorted.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;
      const kdTotal = Math.round(debitRows.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;
      const bpoTotal = Math.round(bizPayoutRows.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;
      const apTotal = Math.round(advPayableRows.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;
      const expTotal = Math.round(expRows.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;
      const totalAllExpenses = Math.round((pbTotal + kdTotal + bpoTotal + apTotal + expTotal) * 100) / 100;

      const categories = {
        purchases: {
          key: "purchases",
          label: "Purchases",
          total_amount: pbTotal,
          count: pbRowsSorted.length,
          transactions: pbRowsSorted,
        },
        debit_entries: {
          key: "debit_entries",
          label: "Debit Entries",
          total_amount: kdTotal,
          count: debitRows.length,
          transactions: debitRows,
        },
        business_pay_out: {
          key: "business_pay_out",
          label: "Business Pay Out",
          total_amount: bpoTotal,
          count: bizPayoutRows.length,
          transactions: bizPayoutRows,
        },
        advance_payable: {
          key: "advance_payable",
          label: "Advance Payable",
          total_amount: apTotal,
          count: advPayableRows.length,
          transactions: advPayableRows,
        },
        other_expenses: {
          key: "other_expenses",
          label: "Other Expenses",
          total_amount: expTotal,
          count: expRows.length,
          transactions: expRows,
        },
        all: {
          key: "all",
          label: "All Expenses",
          total_amount: totalAllExpenses,
          count: pbRowsSorted.length + debitRows.length + bizPayoutRows.length + advPayableRows.length + expRows.length,
          transactions: sortTransactionsChronologicalDesc([...pbRowsSorted, ...debitRows, ...bizPayoutRows, ...advPayableRows, ...expRows]),
        },
      };

      const normalizedCategory = String(categoryParam || "").trim().toLowerCase().replace(/_/g, "-");

      if (normalizedCategory === "purchases" || normalizedCategory === "purchase") {
        transactions = pbRowsSorted;
      } else if (
        normalizedCategory === "debit-entries" ||
        normalizedCategory === "debit-entry" ||
        normalizedCategory === "debits" ||
        normalizedCategory === "debit"
      ) {
        transactions = debitRows;
      } else if (
        normalizedCategory === "business-pay-out" ||
        normalizedCategory === "business-payout" ||
        normalizedCategory === "paid-by-business" ||
        normalizedCategory === "payouts" ||
        normalizedCategory === "pay-out" ||
        normalizedCategory === "payout"
      ) {
        transactions = bizPayoutRows;
      } else if (normalizedCategory === "advance-payable" || normalizedCategory === "advances-payable") {
        transactions = advPayableRows;
      } else if (
        normalizedCategory === "other-expenses" ||
        normalizedCategory === "other-expense" ||
        normalizedCategory === "direct-expenses" ||
        normalizedCategory === "direct-expense"
      ) {
        transactions = expRows;
      } else {
        // "all" or default
        transactions = categories.all.transactions;
      }

      const totalAmount = Math.round(transactions.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;

      return {
        success: true,
        metric: normalizedMetric,
        category: categoryParam || "all",
        label: metricLabel,
        period: period || "custom",
        range: { from: rangeFrom || "all-time", to: rangeTo || "all-time" },
        total_amount: totalAmount,
        count: transactions.length,
        categories,
        breakdown: {
          purchases: pbTotal,
          debit_entries: kdTotal,
          business_pay_out: bpoTotal,
          advance_payable: apTotal,
          other_expenses: expTotal,
          all: totalAllExpenses,
          total: totalAllExpenses,
        },
        transactions,
      };
    }

    case "advance-receivable":
    case "investor-advance": {
      metricLabel = "Advance Receivable";
      const payFilter = buildDateFilter(userId, "payment_date", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT id, amount, payment_date AS date, TIME(created_at) AS time, created_at,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS mode,
                purpose AS description, purpose,
                party_name, party_name AS party, party_name AS customer,
                'Advance Receivable' AS category,
                'payment_advance_receivable' AS source
         FROM payments
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         (payment_category IN ('advance_receivable', 'advance_from_investor') OR purpose IN ('Investor Advance', 'Advance'))`,
        payFilter.params
      );

      const mrFilter = buildDateFilter(userId, "receipt_date", rangeFrom, rangeTo);
      const [mrRows] = await pool.query(
        `SELECT id, amount_received AS amount, receipt_date AS date,
                COALESCE(receipt_time, TIME(created_at)) AS time, created_at,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS mode,
                notes AS description, notes AS purpose,
                COALESCE(received_from_name, to_business_name, 'Unknown') AS party_name,
                COALESCE(received_from_name, to_business_name, 'Unknown') AS party,
                COALESCE(received_from_name, to_business_name, 'Unknown') AS customer,
                'Advance Receivable' AS category,
                'money_receipt_advance' AS source
         FROM money_receipts
         ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
         against_type = 'advance' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
        mrFilter.params
      );

      transactions = sortTransactionsChronologicalDesc([...payRows, ...mrRows]);
      break;
    }

    case "advance-payable": {
      metricLabel = "Advance Payable";
      const payFilter = buildDateFilter(userId, "payment_date", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT id, amount, payment_date AS date, TIME(created_at) AS time, created_at,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS payment_mode,
                COALESCE(NULLIF(payment_mode, ''), 'cash') AS mode,
                purpose AS description, purpose,
                party_name, party_name AS party, party_name AS customer,
                'Advance Payable' AS category,
                'payment_advance_payable' AS source
         FROM payments
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         payment_category = 'advance_payable'
         AND (khata_entry_id IS NULL OR khata_entry_id = 0)`,
        payFilter.params
      );
      transactions = sortTransactionsChronologicalDesc(payRows);
      break;
    }

    case "advances":
    case "advance": {
      metricLabel = "Advances";
      const payFilter = buildDateFilter(userId, "payment_date", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT id, amount, payment_date AS date, TIME(created_at) AS time, created_at,
                payment_mode AS mode,
                purpose AS description, party_name, payment_category AS category, 'payment_advance' AS source
         FROM payments
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         (payment_category IN ('advance_receivable', 'advance_from_investor', 'advance_payable') OR purpose IN ('Investor Advance', 'Advance', 'Advance Payable'))`,
        payFilter.params
      );

      const mrFilter = buildDateFilter(userId, "receipt_date", rangeFrom, rangeTo);
      const [mrRows] = await pool.query(
        `SELECT id, amount_received AS amount, receipt_date AS date,
                COALESCE(receipt_time, TIME(created_at)) AS time, created_at,
                payment_mode AS mode,
                notes AS description, COALESCE(received_from_name, to_business_name, 'Unknown') AS party_name, 'money_receipt_advance' AS source
         FROM money_receipts
         ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
         against_type = 'advance' AND (is_linked_to_payment = 0 OR is_linked_to_payment IS NULL)`,
        mrFilter.params
      );

      transactions = sortTransactionsChronologicalDesc([...payRows, ...mrRows]);
      break;
    }

    case "cash-in-hand": {
      metricLabel = "Cash in Hand";
      const colFilter = buildDateFilter(userId, "c.sale_date", rangeFrom, rangeTo);
      const [colRows] = await pool.query(
        `SELECT c.id, c.amount, c.sale_date AS date, TIME(c.created_at) AS time, c.created_at,
                'cash' AS payment_mode, 'cash' AS mode,
                c.item_name AS description, c.item_name AS purpose,
                cu.name AS party, cu.name AS customer, cu.name AS customer_name,
                'Sales' AS category, 'Sales' AS structure_category,
                'collection' AS source
         FROM collections c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         ${colFilter.clause}
         AND c.payment_type = 'cash'`,
        colFilter.params
      );

      const keFilter = buildDateFilter(userId, "ke.entry_date", rangeFrom, rangeTo);
      const [keRows] = await pool.query(
        `SELECT ke.id, ke.amount, ke.entry_date AS date, COALESCE(ke.entry_time, TIME(ke.created_at)) AS time, ke.created_at,
                COALESCE(ke.payment_mode, 'cash') AS payment_mode, COALESCE(ke.payment_mode, 'cash') AS mode,
                ke.description, ke.description AS purpose,
                cu.name AS party, cu.name AS customer, cu.name AS customer_name,
                'Sales' AS category, 'Sales' AS structure_category,
                'khata_credit' AS source
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         ${keFilter.clause ? keFilter.clause + " AND " : "WHERE "}
         ke.type = 'credit' AND (ke.payment_mode = 'cash' OR ke.payment_mode IS NULL OR ke.payment_mode = '')`,
        keFilter.params
      );

      const payFilter = buildDateFilter(userId, "p.payment_date", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT p.id, p.amount, p.payment_date AS date, TIME(p.created_at) AS time, p.created_at,
                p.payment_mode, p.payment_mode AS mode,
                p.purpose AS description, p.purpose,
                COALESCE(cu.name, p.party_name) AS party, COALESCE(cu.name, p.party_name) AS customer, COALESCE(cu.name, p.party_name) AS customer_name,
                p.payment_category AS category,
                'payment' AS source
         FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         p.payment_mode = 'cash'
         AND p.payment_category IN ('money_received', 'amount_received', 'advance_receivable', 'advance_from_investor')
         AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
        payFilter.params
      );

      const mrFilter = buildDateFilter(userId, "mr.receipt_date", rangeFrom, rangeTo);
      const [mrRows] = await pool.query(
        `SELECT mr.id, mr.amount_received AS amount, mr.receipt_date AS date,
                COALESCE(mr.receipt_time, TIME(mr.created_at)) AS time, mr.created_at,
                mr.payment_mode, mr.payment_mode AS mode,
                mr.notes AS description, mr.notes AS purpose,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS party,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS customer,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS customer_name,
                'Money Receipt' AS category, 'Money Receipt' AS structure_category,
                'money_receipt' AS source
         FROM money_receipts mr
         LEFT JOIN customers cu ON cu.id = mr.customer_id
         ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
         mr.payment_mode = 'cash'
         AND (mr.is_linked_to_payment = 0 OR mr.is_linked_to_payment IS NULL)`,
        mrFilter.params
      );

      transactions = sortTransactionsChronologicalDesc([...colRows, ...keRows, ...payRows, ...mrRows]);
      break;
    }

    case "cash-in-bank": {
      metricLabel = "Cash in Bank";
      const colFilter = buildDateFilter(userId, "c.sale_date", rangeFrom, rangeTo);
      const [colRows] = await pool.query(
        `SELECT c.id, c.amount, c.sale_date AS date, TIME(c.created_at) AS time, c.created_at,
                c.payment_type AS payment_mode, c.payment_type AS mode,
                c.item_name AS description, c.item_name AS purpose,
                cu.name AS party, cu.name AS customer, cu.name AS customer_name,
                'Sales' AS category, 'Sales' AS structure_category,
                'collection' AS source
         FROM collections c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         ${colFilter.clause}
         AND c.payment_type = 'online'`,
        colFilter.params
      );

      const keFilter = buildDateFilter(userId, "ke.entry_date", rangeFrom, rangeTo);
      const [keRows] = await pool.query(
        `SELECT ke.id, ke.amount, ke.entry_date AS date, COALESCE(ke.entry_time, TIME(ke.created_at)) AS time, ke.created_at,
                ke.payment_mode, ke.payment_mode AS mode,
                ke.description, ke.description AS purpose,
                cu.name AS party, cu.name AS customer, cu.name AS customer_name,
                'Sales' AS category, 'Sales' AS structure_category,
                'khata_credit' AS source
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         ${keFilter.clause ? keFilter.clause + " AND " : "WHERE "}
         ke.type = 'credit' AND ke.payment_mode IN ('online', 'upi', 'bank')`,
        keFilter.params
      );

      const payFilter = buildDateFilter(userId, "p.payment_date", rangeFrom, rangeTo);
      const [payRows] = await pool.query(
        `SELECT p.id, p.amount, p.payment_date AS date, TIME(p.created_at) AS time, p.created_at,
                p.payment_mode, p.payment_mode AS mode,
                p.purpose AS description, p.purpose,
                COALESCE(cu.name, p.party_name) AS party, COALESCE(cu.name, p.party_name) AS customer, COALESCE(cu.name, p.party_name) AS customer_name,
                p.payment_category AS category,
                'payment' AS source
         FROM payments p
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ${payFilter.clause ? payFilter.clause + " AND " : "WHERE "}
         p.payment_mode IN ('online', 'upi', 'bank')
         AND p.payment_category IN ('money_received', 'amount_received', 'advance_receivable', 'advance_from_investor')
         AND (p.khata_entry_id IS NULL OR p.khata_entry_id = 0)`,
        payFilter.params
      );

      const mrFilter = buildDateFilter(userId, "mr.receipt_date", rangeFrom, rangeTo);
      const [mrRows] = await pool.query(
        `SELECT mr.id, mr.amount_received AS amount, mr.receipt_date AS date,
                COALESCE(mr.receipt_time, TIME(mr.created_at)) AS time, mr.created_at,
                mr.payment_mode, mr.payment_mode AS mode,
                mr.notes AS description, mr.notes AS purpose,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS party,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS customer,
                COALESCE(cu.name, mr.received_from_name, mr.to_business_name, 'Walk-in') AS customer_name,
                'Money Receipt' AS category, 'Money Receipt' AS structure_category,
                'money_receipt' AS source
         FROM money_receipts mr
         LEFT JOIN customers cu ON cu.id = mr.customer_id
         ${mrFilter.clause ? mrFilter.clause + " AND " : "WHERE "}
         mr.payment_mode IN ('online', 'upi', 'bank', 'cheque', 'neft', 'rtgs')
         AND (mr.is_linked_to_payment = 0 OR mr.is_linked_to_payment IS NULL)`,
        mrFilter.params
      );

      transactions = sortTransactionsChronologicalDesc([...colRows, ...keRows, ...payRows, ...mrRows]);
      break;
    }

    case "other-expenses":
    case "other-expense":
    case "direct-expenses":
    case "direct-expense": {
      metricLabel = "Other Expenses";
      const expFilter = buildDateFilter(userId, "COALESCE(e.expense_date, DATE(e.created_at))", rangeFrom, rangeTo);
      const [expRows] = await pool.query(
        `SELECT id, amount, COALESCE(expense_date, DATE(created_at)) AS date,
                TIME(created_at) AS time, created_at,
                'cash' AS payment_mode, 'cash' AS mode,
                description, description AS purpose,
                'Walk-in' AS party, 'Walk-in' AS customer, 'Walk-in' AS customer_name,
                'Other Expenses' AS category,
                'direct_expense' AS source
         FROM expenses e ${expFilter.clause}`,
        expFilter.params
      );
      transactions = sortTransactionsChronologicalDesc(expRows);
      break;
    }

    case "net-profit":
    case "profit-or-loss": {
      metricLabel = "Net Profit";
      const metrics = await calculateReportMetrics(userId, rangeFrom, rangeTo);
      return {
        success: true,
        metric: "net-profit",
        label: "Net Profit",
        period: period || "custom",
        range: { from: rangeFrom || "all-time", to: rangeTo || "all-time" },
        total_sales: metrics.totalSales,
        total_expenses: metrics.totalExpenses,
        net_profit: metrics.netProfit,
        profit_or_loss: metrics.netProfit,
        breakdown: metrics.breakdown,
        transactions: [],
        count: 0,
        total_amount: metrics.netProfit,
      };
    }

    default:
      throw new ApiError(
        400,
        `Invalid report metric: "${metricParam}". Supported metrics: total-sales, purchases, expenses, total-expenses, debit-entries, business-pay-out, advance-receivable, advance-payable, advances, cash-in-hand, cash-in-bank, other-expenses, net-profit.`
      );
  }

  const totalAmount = Math.round(transactions.reduce((acc, t) => acc + Number(t.amount || 0), 0) * 100) / 100;

  return {
    success: true,
    metric: normalizedMetric,
    label: metricLabel,
    period: period || "custom",
    range: { from: rangeFrom || "all-time", to: rangeTo || "all-time" },
    total_amount: totalAmount,
    count: transactions.length,
    transactions,
  };
};

const getReportDrilldown = asyncHandler(async (req, res) => {
  const metricParam = (req.params.metric || req.query.metric || "").trim().toLowerCase();
  const categoryParam = (req.query.category || req.query.type || req.query.sub_metric || req.query.subMetric || "").trim().toLowerCase();
  const from = req.query.from || req.query.start_date || req.query.startDate;
  const to = req.query.to || req.query.end_date || req.query.endDate;
  const period = req.query.period || req.query.timeframe || req.query.range;
  const user_id = resolveEffectiveUserId(req);

  const result = await executeReportDrilldown(user_id, metricParam, period, from, to, categoryParam);
  res.json(result);
});

module.exports = {
  executeReportDrilldown,
  calculateReportMetrics,
  calculateGraphPoints,
  formatLocalDate,
  resolvePeriodRange,
  getProfitLoss,
  getReports: getProfitLoss,
  getSalesVsExpenses: getProfitLoss,
  getMonthlyTrend,
  getReportGraph: getMonthlyTrend,
  getReportDrilldown,
  getTotalSalesDrilldown: (req, res, next) => {
    req.params.metric = "total-sales";
    return getReportDrilldown(req, res, next);
  },
  getPurchasesDrilldown: (req, res, next) => {
    req.params.metric = "purchases";
    return getReportDrilldown(req, res, next);
  },
  getExpensesDrilldown: (req, res, next) => {
    req.params.metric = "expenses";
    return getReportDrilldown(req, res, next);
  },
  getTotalExpensesDrilldown: (req, res, next) => {
    req.params.metric = "total-expenses";
    return getReportDrilldown(req, res, next);
  },
  getDebitEntriesDrilldown: (req, res, next) => {
    req.params.metric = "debit-entries";
    return getReportDrilldown(req, res, next);
  },
  getBusinessPayOutDrilldown: (req, res, next) => {
    req.params.metric = "business-pay-out";
    return getReportDrilldown(req, res, next);
  },
  getOtherExpensesDrilldown: (req, res, next) => {
    req.params.metric = "other-expenses";
    return getReportDrilldown(req, res, next);
  },
  getAdvanceReceivableDrilldown: (req, res, next) => {
    req.params.metric = "advance-receivable";
    return getReportDrilldown(req, res, next);
  },
  getAdvancePayableDrilldown: (req, res, next) => {
    req.params.metric = "advance-payable";
    return getReportDrilldown(req, res, next);
  },
  getCashInHandDrilldown: (req, res, next) => {
    req.params.metric = "cash-in-hand";
    return getReportDrilldown(req, res, next);
  },
  getCashInBankDrilldown: (req, res, next) => {
    req.params.metric = "cash-in-bank";
    return getReportDrilldown(req, res, next);
  },
  getNetProfitDrilldown: (req, res, next) => {
    req.params.metric = "net-profit";
    return getReportDrilldown(req, res, next);
  },
};
