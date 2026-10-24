const express = require("express");
const router = express.Router();
const { authenticate, authorize, authorizeModule, requirePermission } = require("../middleware/auth");
const {
  getBillingOverview,
  getExpiryCohorts,
  listAdminPlans,
  createPlan,
  updatePlan,
  listAdminCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listAdminPromotions,
  createPromotion,
  updatePromotion,
  deletePromotion,
  searchUsersBilling,
  getSubscriptionAlerts,
  listAdminOrders,
  getUserBillingDetails,
  grantSubscription,
  getSettings,
  updateSettings,
  revokeUserSubscription,
  resetIntroOffer,
  getSubscriptionReports,
} = require("../controllers/billingAdminController");

// All routes require authentication
router.use(authenticate);

// Read-only user billing details accessible to Superadmin and delegated Employees (for user support)
router.get("/users/:id", authorize("superadmin", "employee"), getUserBillingDetails);

// Billing administration routes: Superadmin has full access; Employees assigned to "billing" module
// are authorized with granular permissions.
router.use(authorize("superadmin", "employee"), authorizeModule("billing"));

router.get("/overview", requirePermission("billing", "view"), getBillingOverview);
router.get("/expiry-cohorts", requirePermission("billing", "view"), getExpiryCohorts);
router.get("/alerts", requirePermission("billing", "view"), getSubscriptionAlerts);
router.get("/users-search", requirePermission("billing", "view"), searchUsersBilling);

router.get("/settings", requirePermission("billing", "view"), getSettings);
router.patch("/settings", authorize("superadmin"), updateSettings);

router.get("/plans", requirePermission("billing", "view"), listAdminPlans);
router.post("/plans", requirePermission("billing", "create"), createPlan);
router.put("/plans/:id", requirePermission("billing", "edit"), updatePlan);

router.get("/coupons", requirePermission("billing", "view"), listAdminCoupons);
router.post("/coupons", requirePermission("billing", "create"), createCoupon);
router.put("/coupons/:id", requirePermission("billing", "edit"), updateCoupon);
router.delete("/coupons/:id", requirePermission("billing", "delete"), deleteCoupon);

router.get("/promotions", requirePermission("billing", "view"), listAdminPromotions);
router.post("/promotions", requirePermission("billing", "create"), createPromotion);
router.put("/promotions/:id", requirePermission("billing", "edit"), updatePromotion);
router.delete("/promotions/:id", requirePermission("billing", "delete"), deletePromotion);

router.get("/orders", requirePermission("billing", "view"), listAdminOrders);
router.get("/reports", requirePermission("billing", "view"), getSubscriptionReports);
router.post("/grant", authorize("superadmin"), grantSubscription);
router.post("/users/:id/revoke", requirePermission("billing", "delete"), revokeUserSubscription);
router.post("/users/:id/reset-intro", requirePermission("billing", "edit"), resetIntroOffer);

module.exports = router;

