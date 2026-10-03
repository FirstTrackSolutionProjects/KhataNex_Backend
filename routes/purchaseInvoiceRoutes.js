const router = require("express").Router();

const {
  addPurchaseInvoice,
  lookupByHsn,
  listPurchaseInvoices,
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
} = require("../controllers/purchaseInvoiceController");

const {
  linkPurchaseBillToPayment,
} = require("../controllers/paymentController");

const {
  authenticate,
  authorize,
} = require("../middleware/auth");

const {
  uploadPurchaseInvoiceDoc,
} = require("../utils/upload");

router.use(
  authenticate,
  authorize("user", "employee", "superadmin")
);

router.get("/lookup", lookupByHsn);

router.get("/bills", listPurchaseBills);
router.get("/bills/:id", getPurchaseBill);
router.post("/bills", addPurchaseBill);
router.post("/bills/:id/pay", linkPurchaseBillToPayment);
router.post("/bills/:id/payment", linkPurchaseBillToPayment);

router.get("/", listPurchaseInvoices);

router.post(
  "/",
  uploadPurchaseInvoiceDoc.single("invoice_file"),
  addPurchaseInvoice
);

module.exports = router;
