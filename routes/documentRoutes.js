const router = require("express").Router();
const {
  createDocument,
  listDocuments,
  getDocument,
  resendDocumentEmail,
} = require("../controllers/documentController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

// doc_type in the body decides Invoice / Quotation / Merchant Bill —
// same create/list/download/email flow for all three.
router.post("/", createDocument);
router.get("/", listDocuments);
router.get("/:id", getDocument);
router.post("/:id/resend-email", resendDocumentEmail);

module.exports = router;
