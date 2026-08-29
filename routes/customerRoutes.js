const router = require("express").Router();
const {
  createCustomer,
  listCustomers,
  getCustomerProfile,
  updateCustomer,
} = require("../controllers/customerController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", createCustomer);
router.get("/", listCustomers);
router.get("/:id", getCustomerProfile);
router.patch("/:id", updateCustomer);

module.exports = router;
