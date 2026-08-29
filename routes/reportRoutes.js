const router = require("express").Router();
const { getProfitLoss, getMonthlyTrend } = require("../controllers/reportController");
const { authenticate, authorize } = require("../middleware/auth");

// A 'user' can see their OWN business's reports (the controller auto-scopes
// to their own id — see reportController.js). employee/superadmin can see
// any user's reports via ?user_id=, or all users combined if omitted.
router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/profit-loss", getProfitLoss);
router.get("/monthly-trend", getMonthlyTrend);

module.exports = router;
