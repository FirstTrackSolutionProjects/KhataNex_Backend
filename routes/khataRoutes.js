const router = require("express").Router();
const {
  getKhata,
  getKhataDashboard,
  addKhataEntry,
  addKhataDebit,
  addKhataCredit,
  addKhataDue,
  getKhataDues,
  getUnlinkedKhataDebits,
  linkKhataDebitToPayment,
  skipKhataDebit,
  unskipKhataDebit,
} = require("../controllers/khataController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/dashboard", getKhataDashboard);
router.get("/summary", getKhataDashboard);
router.get("/unlinked-debits", getUnlinkedKhataDebits);
router.post("/:id/link-payment", linkKhataDebitToPayment);
router.patch("/:id/skip", skipKhataDebit);
router.patch("/:id/unskip", unskipKhataDebit);
router.get("/dues", getKhataDues);
router.post("/due", addKhataDue);
router.post("/debit", addKhataDebit);
router.post("/credit", addKhataCredit);
router.post("/", addKhataEntry);
router.get("/", getKhata);

module.exports = router;
