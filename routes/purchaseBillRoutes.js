const router = require("express").Router();

const {
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
  updatePurchaseBill,
  deletePurchaseBill,
  searchPurchaseItems,
} = require("../controllers/purchaseBillController");

const {
  linkPurchaseBillToPayment,
} = require("../controllers/paymentController");

const {
  authenticate,
  authorize,
  authorizeModule,
  requirePermission,
} = require("../middleware/auth");

router.use(
  authenticate,
  authorize("user", "employee", "superadmin"),
  authorizeModule("purchases", "inventory")
);

router.get("/items", requirePermission("purchases", "view"), searchPurchaseItems);
router.get("/search-items", requirePermission("purchases", "view"), searchPurchaseItems);
router.get("/", requirePermission("purchases", "view"), listPurchaseBills);
router.get("/:id", requirePermission("purchases", "view"), getPurchaseBill);
router.post("/", requirePermission("purchases", "create"), addPurchaseBill);
router.put("/:id", requirePermission("purchases", "edit"), updatePurchaseBill);
router.delete("/:id", requirePermission("purchases", "delete"), deletePurchaseBill);
router.post("/:id/pay", requirePermission("purchases", "edit"), linkPurchaseBillToPayment);
router.post("/:id/payment", requirePermission("purchases", "edit"), linkPurchaseBillToPayment);

module.exports = router;
