const router = require("express").Router();
const {
  addStock,
  listStock,
  getStockById,
  updateStock,
  deleteStock,
  lookupStockOrPurchase,
  searchPurchaseItems,
} = require("../controllers/stockController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/lookup", lookupStockOrPurchase);
router.get("/purchase-items", searchPurchaseItems);
router.get("/purchase-bills/items", searchPurchaseItems);

router.post("/", addStock);
router.get("/", listStock);
router.get("/:id", getStockById);
router.patch("/:id", updateStock);
router.delete("/:id", deleteStock);

module.exports = router;
