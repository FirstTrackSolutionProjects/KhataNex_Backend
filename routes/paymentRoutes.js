const router = require("express").Router();
const {
  addPayment,
  listPayments,
  getCustomerOutstandingDues,
  addPaymentToKhata,
  getUnlinkedMoneyReceipts,
  linkMoneyReceiptToPayment,
  getUnlinkedPurchaseBills,
  linkPurchaseBillToPayment,
  getUnlinkedKhataDebitsForPayment,
} = require("../controllers/paymentController");
const { linkKhataDebitToPayment } = require("../controllers/khataController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/dues", getCustomerOutstandingDues);
router.get("/unlinked-money-receipts", getUnlinkedMoneyReceipts);
router.get("/unlinked-purchase-bills", getUnlinkedPurchaseBills);
router.get("/unlinked-khata-debits", getUnlinkedKhataDebitsForPayment);
router.post("/link-money-receipt/:id", linkMoneyReceiptToPayment);
router.post("/link-money-receipt", linkMoneyReceiptToPayment);
router.post("/link-purchase-bill/:id", linkPurchaseBillToPayment);
router.post("/link-purchase-bill", linkPurchaseBillToPayment);
router.post("/link-khata/:id", linkKhataDebitToPayment);
router.post("/:id/add-to-khata", addPaymentToKhata);
router.post("/", addPayment);
router.get("/", listPayments);

module.exports = router;
