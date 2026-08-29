const router = require("express").Router();
const {
  addPurchaseInvoice,
  lookupByHsn,
  listPurchaseInvoices,
} = require("../controllers/purchaseInvoiceController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadPurchaseInvoiceDoc } = require("../utils/upload");

router.use(authenticate, authorize("user", "employee", "superadmin"));

// IMPORTANT: /lookup must be declared before /:anything-like routes to avoid
// being swallowed by a param route — this file has no such conflict, but
// kept in this order for clarity/future-proofing.
router.get("/lookup", lookupByHsn);
router.get("/", listPurchaseInvoices);
router.post("/", uploadPurchaseInvoiceDoc.single("invoice_file"), addPurchaseInvoice);

module.exports = router;
