const router = require("express").Router();

const {
  createDocument,
  updateDocument,
  regenerateDocuments,
  listDocuments,
  getDocument,
  resendDocumentEmail,
  createMoneyReceipt,
  updateMoneyReceipt,
  deleteMoneyReceipt,
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

router.put(
  "/money-receipts/:id",
  updateMoneyReceipt
);

router.patch(
  "/money-receipts/:id",
  updateMoneyReceipt
);

router.delete(
  "/money-receipts/:id",
  deleteMoneyReceipt
);

// --------------------------------------------------
// Invoices / Quotations
// --------------------------------------------------

router.post("/", createDocument);
router.post("/regenerate", regenerateDocuments);

router.get("/", listDocuments);

router.get("/:id", getDocument);

router.put("/invoices/:id", updateDocument);
router.patch("/invoices/:id", updateDocument);

router.put("/quotations/:id", updateDocument);
router.patch("/quotations/:id", updateDocument);

router.put("/:id", updateDocument);
router.patch("/:id", updateDocument);

router.delete("/invoices/:id", deleteInvoice);
router.delete("/quotations/:id", deleteQuotation);
router.delete("/:id", deleteDocument);

router.post(
  "/:id/resend-email",
  resendDocumentEmail
);

module.exports = router;