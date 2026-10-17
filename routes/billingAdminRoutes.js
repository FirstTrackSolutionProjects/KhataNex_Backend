const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../middleware/auth");
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
} = require("../controllers/billingAdminController");

// All routes require authentication
router.use(authenticate);

// Read-only user billing details accessible to Superadmin and delegated Employees (for user support)
router.get("/users/:id", authorize("superadmin", "employee"), getUserBillingDetails);

// All subsequent billing admin management routes are strictly restricted to Superadmin
router.use(authorize("superadmin"));

router.get("/overview", getBillingOverview);
router.get("/expiry-cohorts", getExpiryCohorts);
router.get("/alerts", getSubscriptionAlerts);
router.get("/users-search", searchUsersBilling);

router.get("/settings", getSettings);
router.patch("/settings", updateSettings);

router.get("/plans", listAdminPlans);
router.post("/plans", createPlan);
router.put("/plans/:id", updatePlan);

router.get("/coupons", listAdminCoupons);
router.post("/coupons", createCoupon);
router.put("/coupons/:id", updateCoupon);
router.delete("/coupons/:id", deleteCoupon);

router.get("/promotions", listAdminPromotions);
router.post("/promotions", createPromotion);
router.put("/promotions/:id", updatePromotion);
router.delete("/promotions/:id", deletePromotion);

router.get("/orders", listAdminOrders);
router.post("/grant", grantSubscription);
router.post("/users/:id/revoke", revokeUserSubscription);
router.post("/users/:id/reset-intro", resetIntroOffer);

module.exports = router;

