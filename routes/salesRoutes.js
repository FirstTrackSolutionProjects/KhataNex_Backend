const router = require("express").Router();
const {
  getSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
  createInvoiceForSale,
  generateInvoiceFromSales,
} = require("../controllers/salesController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/dashboard", getSales);
router.post("/generate-invoice", generateInvoiceFromSales);
router.post("/:id/create-invoice", createInvoiceForSale);
router.post("/:id/invoice", createInvoiceForSale);
router.get("/:id", getSaleById);
router.put("/:id", updateSale);
router.delete("/:id", deleteSale);
router.post("/", createSale);
router.get("/", getSales);

module.exports = router;
