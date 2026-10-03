const router = require("express").Router();

const {
  createDocument,
  listDocuments,
  getDocument,
  resendDocumentEmail,
  createMoneyReceipt,
  listMoneyReceipts,
  getMoneyReceipt,
  deleteInvoice,
  deleteQuotation,
  deleteDocument,
} = require("../controllers/documentController");

const {
  authenticate,
  authorize,
} = require("../middleware/auth");

router.use(
  authenticate,
  authorize("user", "employee", "superadmin")
);

const {
  getUnlinkedMoneyReceipts,
  linkMoneyReceiptToPayment,
} = require("../controllers/paymentController");

// --------------------------------------------------
// Money Receipts
// --------------------------------------------------

router.post(
  "/money-receipts",
  createMoneyReceipt
);

router.get(
  "/money-receipts/unlinked",
  getUnlinkedMoneyReceipts
);

router.post(
  "/money-receipts/:id/link-payment",
  linkMoneyReceiptToPayment
);

router.get(
  "/money-receipts/list",
  listMoneyReceipts
);

router.get(
  "/money-receipts/:id",
  getMoneyReceipt
);

// --------------------------------------------------
// Invoices / Quotations
// --------------------------------------------------

router.post("/", createDocument);

router.get("/", listDocuments);

router.get("/:id", getDocument);

router.delete("/invoices/:id", deleteInvoice);
router.delete("/quotations/:id", deleteQuotation);
router.delete("/:id", deleteDocument);

router.post(
  "/:id/resend-email",
  resendDocumentEmail
);

module.exports = router;