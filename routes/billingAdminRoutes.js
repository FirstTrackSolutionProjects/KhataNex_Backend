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
  listAdminOrders,
  getUserBillingDetails,
  grantSubscription,
} = require("../controllers/billingAdminController");

// Restrict entire route to superadmin
router.use(authenticate, authorize("superadmin"));

router.get("/overview", getBillingOverview);
router.get("/expiry-cohorts", getExpiryCohorts);

router.get("/plans", listAdminPlans);
router.post("/plans", createPlan);
router.put("/plans/:id", updatePlan);

router.get("/coupons", listAdminCoupons);
router.post("/coupons", createCoupon);
router.put("/coupons/:id", updateCoupon);

router.get("/orders", listAdminOrders);
router.get("/users/:id", getUserBillingDetails);
router.post("/grant", grantSubscription);

module.exports = router;

