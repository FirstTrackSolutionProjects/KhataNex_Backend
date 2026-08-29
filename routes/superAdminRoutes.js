const router = require("express").Router();
const {
  listUsers,
  getUser,
  createEmployee,
  listEmployees,
  updateEmployee,
  setUserStatus,
} = require("../controllers/superAdminController");
const { authenticate, authorize } = require("../middleware/auth");

// Every route here is super-admin-only.
router.use(authenticate, authorize("superadmin"));

router.get("/users", listUsers);
router.get("/users/:id", getUser);
router.patch("/users/:id/status", setUserStatus);

router.post("/employees", createEmployee);
router.get("/employees", listEmployees);
router.patch("/employees/:id", updateEmployee);

module.exports = router;
