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
  getUserInvoices,
  getUserQuotations,
  getUserMoneyReceipts,
  getUserBilling,
  getUserReportDrilldown,
  deleteUserCustomer,
  getUserRecord,
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  setUserStatus,
  updateUser,
  deleteUser,
  restoreUser,
  listAuditLogs,
} = require("../controllers/superAdminController");
const { authenticate, authorize, authorizePermission, authorizeModule, requirePermission } = require("../middleware/auth");
const { uploadEmployeePhoto } = require("../utils/upload");

// Routes are authenticated; individual endpoints enforce super-admin or delegated employee permissions.
router.use(authenticate);

// My Users — accessible to Superadmin and delegated Employees assigned to 'users' module
router.get("/users", authorize("superadmin", "employee"), authorizeModule("users"), requirePermission("users", "view"), listUsers);
router.get("/users/:id", authorize("superadmin", "employee"), authorizeModule("users"), requirePermission("users", "view"), getUser);
router.get("/users/:id/overview", authorize("superadmin", "employee"), authorizeModule("users"), requirePermission("users", "view"), getUserOverview);
router.get("/users/:id/data", authorize("superadmin", "employee"), authorizeModule("users"), requirePermission("users", "view"), getUserData);

// Module-scoped user data access for delegated employees
router.get("/users/:id/customers", authorizeModule("customers"), getUserCustomers);
router.get("/users/:id/khata", authorizeModule("khata"), getUserKhata);
router.get("/users/:id/payments", authorizeModule("payments"), getUserPayments);
router.get("/users/:id/purchase-bills", authorizeModule("purchase_bills", "inventory"), getUserPurchaseBills);
router.get("/users/:id/purchase_bills", authorizeModule("purchase_bills", "inventory"), getUserPurchaseBills);
router.get("/users/:id/inventory", authorizeModule("inventory"), getUserInventory);
router.get("/users/:id/stock", authorizeModule("inventory"), getUserInventory);
router.get("/users/:id/vehicles", authorizeModule("vehicles"), getUserVehicles);
router.get("/users/:id/invoices", authorizeModule("invoices"), getUserInvoices);
router.get("/users/:id/quotations", authorizeModule("quotations", "invoices"), getUserQuotations);
router.get("/users/:id/money-receipts", authorizeModule("payments", "invoices"), getUserMoneyReceipts);
router.get("/users/:id/billing", authorizeModule("billing"), getUserBilling);
router.get("/users/:id/reports", authorizeModule("reports"), getUserReports);
router.get("/users/:id/reports/graph", authorizeModule("reports"), getUserReportGraph);
router.get("/users/:id/reports/monthly-trend", authorizeModule("reports"), getUserReportGraph);
router.get("/users/:id/reports/drilldown/:metric", authorizeModule("reports"), getUserReportDrilldown);
router.get("/users/:id/reports/drilldown", authorizeModule("reports"), getUserReportDrilldown);
router.delete("/users/:id/customers/:customerId", authorize("superadmin"), deleteUserCustomer);
router.get("/users/:id/records/:recordId", authorize("superadmin", "employee"), getUserRecord);
router.patch("/users/:id", authorize("superadmin"), updateUser);
router.patch("/users/:id/status", authorize("superadmin"), setUserStatus);
router.delete("/users/:id", authorize("superadmin"), deleteUser);
router.post("/users/:id/restore", authorize("superadmin"), restoreUser);

// Employees Management — Superadmin only
router.post("/employees", authorize("superadmin"), uploadEmployeePhoto.single("profile_photo"), createEmployee);
router.get("/employees", authorize("superadmin"), listEmployees);
router.get("/employees/:id", authorize("superadmin"), getEmployee);
router.patch("/employees/:id", uploadEmployeePhoto.single("profile_photo"), updateEmployee);
router.delete("/employees/:id", authorize("superadmin"), deleteEmployee);

// Audit Logs — Superadmin only
router.get("/audit-logs", authorize("superadmin"), listAuditLogs);

module.exports = router;
