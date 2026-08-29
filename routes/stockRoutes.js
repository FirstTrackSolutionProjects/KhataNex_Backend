const router = require("express").Router();
const { addStock, listStock, updateStock, deleteStock } = require("../controllers/stockController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", addStock);
router.get("/", listStock);
router.patch("/:id", updateStock);
router.delete("/:id", deleteStock);

module.exports = router;
