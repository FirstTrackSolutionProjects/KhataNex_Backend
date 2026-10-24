const router = require("express").Router();
const { authenticate, authorize } = require("../middleware/auth");
const {
  getDashboardStats,
  getDashboardDrilldown,
  getUserDetail,
  retryEmail,
  getCampaignAnalytics,
} = require("../controllers/superAdminDashboardController");

// Strictly restricted to Superadmin
router.use(authenticate, authorize("superadmin"));

router.get("/stats", getDashboardStats);
router.get("/drilldown", getDashboardDrilldown);
router.get("/user-detail/:id", getUserDetail);
router.post("/email-retry/:id", retryEmail);
router.get("/campaign-analytics", getCampaignAnalytics);

module.exports = router;

