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
  updateKhataEntry,
  deleteKhataEntry,
  searchKhataCustomers,
  searchKhataProducts,
} = require("../controllers/khataController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/search/customers", searchKhataCustomers);
router.get("/search/products", searchKhataProducts);
router.get("/search-customers", searchKhataCustomers);
router.get("/search-products", searchKhataProducts);
router.get("/customers", searchKhataCustomers);
router.get("/products", searchKhataProducts);
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
router.put("/:id", updateKhataEntry);
router.patch("/:id", updateKhataEntry);
router.delete("/:id", deleteKhataEntry);

module.exports = router;
