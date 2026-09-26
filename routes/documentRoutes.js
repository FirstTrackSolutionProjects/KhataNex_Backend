const router = require("express").Router();

const {
  createDocument,
  listDocuments,
  getDocument,
  resendDocumentEmail,
  createMoneyReceipt,
  listMoneyReceipts,
  getMoneyReceipt,
} = require("../controllers/documentController");

const {
  authenticate,
  authorize,
} = require("../middleware/auth");

router.use(
  authenticate,
  authorize("user", "employee", "superadmin")
);

// --------------------------------------------------
// Money Receipts
// --------------------------------------------------

router.post(
  "/money-receipts",
  createMoneyReceipt
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

router.post(
  "/:id/resend-email",
  resendDocumentEmail
);

module.exports = router;