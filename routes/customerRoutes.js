const router = require("express").Router();
const {
  createCustomer,
  listCustomers,
  getCustomerProfile,
  getCustomerDues,
  updateCustomer,
  deleteCustomer,
} = require("../controllers/customerController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", createCustomer);
router.get("/", listCustomers);
router.get("/:id", getCustomerProfile);
router.get("/:id/dues", getCustomerDues);
router.patch("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

module.exports = router;
