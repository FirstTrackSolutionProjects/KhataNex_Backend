const router = require("express").Router();

const {
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
  updatePurchaseBill,
  deletePurchaseBill,
} = require("../controllers/purchaseBillController");

const {
  linkPurchaseBillToPayment,
} = require("../controllers/paymentController");

const {
  authenticate,
  authorize,
} = require("../middleware/auth");

router.use(
  authenticate,
  authorize(
    "user",
    "employee",
    "superadmin"
  )
);

router.get("/", listPurchaseBills);
router.get("/:id", getPurchaseBill);
router.post("/", addPurchaseBill);
router.put("/:id", updatePurchaseBill);
router.delete("/:id", deletePurchaseBill);
router.post("/:id/pay", linkPurchaseBillToPayment);
router.post("/:id/payment", linkPurchaseBillToPayment);

module.exports = router;
