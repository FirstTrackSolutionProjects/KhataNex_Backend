const router = require("express").Router();
const {
  listUsers,
  getUser,
  getUserOverview,
  getUserData,
  getUserCustomers,
  getUserKhata,
  getUserInventory,
  getUserVehicles,
  getUserReports,
  getUserReportGraph,
  getUserPayments,
  getUserPurchaseBills,
  getUserReportDrilldown,
  deleteUserCustomer,
  getUserRecord,
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  setUserStatus,
  deleteUser,
} = require("../controllers/superAdminController");
const { authenticate, authorize, authorizePermission } = require("../middleware/auth");
const { uploadEmployeePhoto } = require("../utils/upload");

// Routes are authenticated; individual endpoints enforce super-admin or delegated employee permissions.
router.use(authenticate);

router.get("/users", authorize("superadmin"), listUsers);
router.get("/users/:id", authorize("superadmin"), getUser);
router.get("/users/:id/overview", authorize("superadmin"), getUserOverview);
router.get("/users/:id/data", authorize("superadmin"), getUserData);
router.get("/users/:id/customers", authorize("superadmin"), getUserCustomers);
router.get("/users/:id/khata", authorize("superadmin"), getUserKhata);
router.get("/users/:id/payments", authorize("superadmin"), getUserPayments);
router.get("/users/:id/purchase-bills", authorize("superadmin"), getUserPurchaseBills);
router.get("/users/:id/purchase_bills", authorize("superadmin"), getUserPurchaseBills);
router.get("/users/:id/inventory", authorize("superadmin"), getUserInventory);
router.get("/users/:id/stock", authorize("superadmin"), getUserInventory);
router.get("/users/:id/vehicles", authorize("superadmin"), getUserVehicles);
router.get("/users/:id/reports", authorize("superadmin"), getUserReports);
router.get("/users/:id/reports/graph", authorize("superadmin"), getUserReportGraph);
router.get("/users/:id/reports/monthly-trend", authorize("superadmin"), getUserReportGraph);
router.get("/users/:id/reports/drilldown/:metric", authorize("superadmin"), getUserReportDrilldown);
router.get("/users/:id/reports/drilldown", authorize("superadmin"), getUserReportDrilldown);
router.delete("/users/:id/customers/:customerId", authorize("superadmin"), deleteUserCustomer);
router.get("/users/:id/records/:recordId", authorize("superadmin"), getUserRecord);
router.patch("/users/:id/status", authorize("superadmin"), setUserStatus);
router.delete("/users/:id", authorize("superadmin"), deleteUser);

router.post("/employees", authorizePermission("create_employee"), uploadEmployeePhoto.single("profile_photo"), createEmployee);
router.get("/employees", authorize("superadmin"), listEmployees);
router.get("/employees/:id", authorize("superadmin"), getEmployee);
router.patch("/employees/:id", authorize("superadmin"), updateEmployee);

module.exports = router;
