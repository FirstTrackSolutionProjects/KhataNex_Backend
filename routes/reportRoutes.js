const router = require("express").Router();
const {
  getProfitLoss,
  getMonthlyTrend,
  getReportDrilldown,
  getTotalSalesDrilldown,
  getPurchasesDrilldown,
  getExpensesDrilldown,
  getTotalExpensesDrilldown,
  getDebitEntriesDrilldown,
  getBusinessPayOutDrilldown,
  getOtherExpensesDrilldown,
  getAdvanceReceivableDrilldown,
  getAdvancePayableDrilldown,
  getCashInHandDrilldown,
  getCashInBankDrilldown,
  getNetProfitDrilldown,
} = require("../controllers/reportController");
const { getSubscriptionReports } = require("../controllers/billingAdminController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

// Dedicated Superadmin subscription reports
router.get("/subscriptions", authorize("superadmin"), getSubscriptionReports);

// Drill-down transaction routes for each report metric
router.get("/drilldown/:metric", getReportDrilldown);
router.get("/drilldown", getReportDrilldown);
router.get("/total-sales", getTotalSalesDrilldown);
router.get("/purchases", getPurchasesDrilldown);
router.get("/expenses", getExpensesDrilldown);
router.get("/total-expenses", getTotalExpensesDrilldown);
router.get("/total-expense", getTotalExpensesDrilldown);
router.get("/debit-entries", getDebitEntriesDrilldown);
router.get("/debit-entry", getDebitEntriesDrilldown);
router.get("/business-pay-out", getBusinessPayOutDrilldown);
router.get("/business-payout", getBusinessPayOutDrilldown);
router.get("/other-expenses", getOtherExpensesDrilldown);
router.get("/other-expense", getOtherExpensesDrilldown);
router.get("/advance-receivable", getAdvanceReceivableDrilldown);
router.get("/advance-payable", getAdvancePayableDrilldown);
router.get("/advances", (req, res, next) => {
  req.params.metric = "advances";
  return getReportDrilldown(req, res, next);
});
router.get("/cash-in-hand", getCashInHandDrilldown);
router.get("/cash-in-bank", getCashInBankDrilldown);
router.get("/net-profit", getNetProfitDrilldown);

// Summary reports
router.get("/profit-loss", getProfitLoss);
router.get("/sales-vs-expenses", getProfitLoss);
router.get("/monthly-trend", getMonthlyTrend);
router.get("/graph", getMonthlyTrend);
router.get("/sales-vs-expense-graph", getMonthlyTrend);
router.get("/", getProfitLoss);

module.exports = router;
