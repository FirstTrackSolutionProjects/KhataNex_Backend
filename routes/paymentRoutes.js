const router = require("express").Router();
const { addPayment, listPayments } = require("../controllers/paymentController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", addPayment);
router.get("/", listPayments);

module.exports = router;
