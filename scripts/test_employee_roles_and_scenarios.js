require("dotenv").config();
const pool = require("../config/db");
const jwt = require("jsonwebtoken");

const BASE_URL = process.env.BASE_URL || "http://localhost:5001";
const JWT_SECRET = process.env.JWT_SECRET || "khatanex_super_secret_jwt_key_2026";

async function main() {
  console.log("========================================================================");
  console.log("KHATANEX E2E VERIFICATION: 10 EMPLOYEE PROFILES (E1-E10) & SCENARIOS A-H");
  console.log("========================================================================\n");

  const results = [];
  const report = (name, passed, details = "") => {
    results.push({ name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: ${name}`);
    if (details) console.log(`   └─ ${details}`);
  };

  const cleanupUserIds = [];
  const cleanupStockIds = [];
  const cleanupPurchaseBillIds = [];

  try {
    // 0. Superadmin setup
    const [superAdmins] = await pool.query("SELECT id, email FROM users WHERE role = 'superadmin' LIMIT 1");
    if (!superAdmins.length) throw new Error("No superadmin found in database");
    const saUser = superAdmins[0];
    const saToken = jwt.sign({ id: saUser.id, role: "superadmin" }, JWT_SECRET);
    report("Superadmin access verified", true, `ID: ${saUser.id}, Email: ${saUser.email}`);

    // 0.1 Create Business Owner A & B for tenant isolation testing
    const ts = Date.now();
    const [resOwnerA] = await pool.query(
      `INSERT INTO users (name, email, password, role, phone, status) VALUES (?, ?, 'Password@123', 'user', ?, 'active')`,
      [`Owner A ${ts}`, `owner_a_${ts}@test.com`, `98765${String(ts).slice(-5)}`]
    );
    const ownerAId = resOwnerA.insertId;
    cleanupUserIds.push(ownerAId);
    const ownerAToken = jwt.sign({ id: ownerAId, role: "user" }, JWT_SECRET);

    const [resOwnerB] = await pool.query(
      `INSERT INTO users (name, email, password, role, phone, status) VALUES (?, ?, 'Password@123', 'user', ?, 'active')`,
      [`Owner B ${ts}`, `owner_b_${ts}@test.com`, `98766${String(ts).slice(-5)}`]
    );
    const ownerBId = resOwnerB.insertId;
    cleanupUserIds.push(ownerBId);
    const ownerBToken = jwt.sign({ id: ownerBId, role: "user" }, JWT_SECRET);

    // Provision active subscription for Owner A so mutating actions (POST, PUT, DELETE) pass subscription gating
    const [orderRes] = await pool.query(
      `INSERT INTO subscription_orders (order_number, user_id, plan_id, list_price_paise, total_paise, currency, status, provider)
       VALUES (?, ?, 1, 99900, 99900, 'INR', 'paid', 'razorpay')`,
      [`ORD-${ts}`, ownerAId]
    );
    const orderId = orderRes.insertId;

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, order_id, status, starts_at, ends_at, is_complimentary)
       VALUES (?, 1, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 0)`,
      [ownerAId, orderId]
    );

    report("Provisioned Business Owners A & B (Owner A has active subscription)", true, `Owner A: ${ownerAId}, Owner B: ${ownerBId}`);

    // 1. Provision 10 Employee Profiles (E1 - E10) under Owner A
    const employeeConfigs = [
      {
        code: "E1",
        title: "Khata Specialist",
        assigned_modules: ["khata"],
        permissions: ["khata:*"],
      },
      {
        code: "E2",
        title: "Invoice Specialist",
        assigned_modules: ["invoices"],
        permissions: ["invoices:*"],
      },
      {
        code: "E3",
        title: "Payment Specialist",
        assigned_modules: ["payments"],
        permissions: ["payments:*"],
      },
      {
        code: "E4",
        title: "Inventory + Purchases Inherited",
        assigned_modules: ["inventory"],
        permissions: ["inventory:view", "inventory:create", "inventory:edit"],
      },
      {
        code: "E5",
        title: "Vehicles Specialist",
        assigned_modules: ["vehicles"],
        permissions: ["vehicles:*"],
      },
      {
        code: "E6",
        title: "Customers Specialist",
        assigned_modules: ["customers"],
        permissions: ["customers:*"],
      },
      {
        code: "E7",
        title: "Billing Specialist",
        assigned_modules: ["billing"],
        permissions: ["billing:*"],
      },
      {
        code: "E8",
        title: "Reports & Dashboard Specialist",
        assigned_modules: ["reports"],
        permissions: ["reports:*"],
      },
      {
        code: "E9",
        title: "Purchases Explicit Specialist",
        assigned_modules: ["purchases"],
        permissions: ["purchases:*"],
      },
      {
        code: "E10",
        title: "Read-Only Auditor",
        assigned_modules: ["invoices", "khata", "payments", "inventory", "purchases"],
        permissions: ["invoices:view", "khata:view", "payments:view", "inventory:view", "purchases:view"],
      },
    ];

    const employees = {};

    for (const cfg of employeeConfigs) {
      const email = `emp_${cfg.code.toLowerCase()}_${ts}@test.com`;
      const [res] = await pool.query(
        `INSERT INTO users (name, email, password, role, created_by_admin, employee_role_type, assigned_modules, permissions, status)
         VALUES (?, ?, 'Password@123', 'employee', ?, 'staff', ?, ?, 'active')`,
        [
          `Staff ${cfg.code} - ${cfg.title}`,
          email,
          ownerAId,
          JSON.stringify(cfg.assigned_modules),
          JSON.stringify(cfg.permissions),
        ]
      );
      const empId = res.insertId;
      cleanupUserIds.push(empId);
      const token = jwt.sign(
        {
          id: empId,
          role: "employee",
          created_by_admin: ownerAId,
          assigned_modules: cfg.assigned_modules,
          permissions: cfg.permissions,
        },
        JWT_SECRET
      );
      employees[cfg.code] = {
        id: empId,
        token,
        config: cfg,
      };
    }

    report("Provisioned 10 Distinct Employee Profiles (E1-E10)", true, Object.keys(employees).join(", "));

    // =========================================================================
    // SCENARIO A: Role-Based Navigation & Module Authorization
    // =========================================================================
    console.log("\n--- SCENARIO A: Role-Based Navigation & Module Authorization ---");

    // E1: Khata Specialist
    const e1KhataRes = await fetch(`${BASE_URL}/api/khata`, {
      headers: { Authorization: `Bearer ${employees.E1.token}` },
    });
    report("E1 accesses Khata -> 200 OK", e1KhataRes.status === 200, `Status: ${e1KhataRes.status}`);

    const e1StockRes = await fetch(`${BASE_URL}/api/stock`, {
      headers: { Authorization: `Bearer ${employees.E1.token}` },
    });
    report("E1 denied Stock (Inventory) -> 403 Forbidden", e1StockRes.status === 403, `Status: ${e1StockRes.status}`);

    // E2: Invoice Specialist
    const e2DocRes = await fetch(`${BASE_URL}/api/documents?type=invoice`, {
      headers: { Authorization: `Bearer ${employees.E2.token}` },
    });
    report("E2 accesses Documents (Invoices) -> 200 OK", e2DocRes.status === 200, `Status: ${e2DocRes.status}`);

    const e2VehiclesRes = await fetch(`${BASE_URL}/api/vehicles`, {
      headers: { Authorization: `Bearer ${employees.E2.token}` },
    });
    report("E2 denied Vehicles -> 403 Forbidden", e2VehiclesRes.status === 403, `Status: ${e2VehiclesRes.status}`);

    // E3: Payment Specialist
    const e3PayRes = await fetch(`${BASE_URL}/api/payments`, {
      headers: { Authorization: `Bearer ${employees.E3.token}` },
    });
    report("E3 accesses Payments -> 200 OK", e3PayRes.status === 200, `Status: ${e3PayRes.status}`);

    const e3CustRes = await fetch(`${BASE_URL}/api/customers`, {
      headers: { Authorization: `Bearer ${employees.E3.token}` },
    });
    report("E3 denied Customers -> 403 Forbidden", e3CustRes.status === 403, `Status: ${e3CustRes.status}`);

    // E5: Vehicles Specialist
    const e5VehiclesRes = await fetch(`${BASE_URL}/api/vehicles`, {
      headers: { Authorization: `Bearer ${employees.E5.token}` },
    });
    report("E5 accesses Vehicles -> 200 OK", e5VehiclesRes.status === 200, `Status: ${e5VehiclesRes.status}`);

    const e5KhataRes = await fetch(`${BASE_URL}/api/khata`, {
      headers: { Authorization: `Bearer ${employees.E5.token}` },
    });
    report("E5 denied Khata -> 403 Forbidden", e5KhataRes.status === 403, `Status: ${e5KhataRes.status}`);

    // E6: Customers Specialist
    const e6CustRes = await fetch(`${BASE_URL}/api/customers`, {
      headers: { Authorization: `Bearer ${employees.E6.token}` },
    });
    report("E6 accesses Customers -> 200 OK", e6CustRes.status === 200, `Status: ${e6CustRes.status}`);

    const e6DocRes = await fetch(`${BASE_URL}/api/documents`, {
      headers: { Authorization: `Bearer ${employees.E6.token}` },
    });
    report("E6 denied Documents -> 403 Forbidden", e6DocRes.status === 403, `Status: ${e6DocRes.status}`);

    // E7: Billing Specialist
    const e7BillingRes = await fetch(`${BASE_URL}/api/superadmin/billing/overview`, {
      headers: { Authorization: `Bearer ${employees.E7.token}` },
    });
    report("E7 accesses Billing Overview -> 200 OK", e7BillingRes.status === 200, `Status: ${e7BillingRes.status}`);

    const e7StockRes = await fetch(`${BASE_URL}/api/stock`, {
      headers: { Authorization: `Bearer ${employees.E7.token}` },
    });
    report("E7 denied Stock -> 403 Forbidden", e7StockRes.status === 403, `Status: ${e7StockRes.status}`);

    const e1BillingRes = await fetch(`${BASE_URL}/api/superadmin/billing/overview`, {
      headers: { Authorization: `Bearer ${employees.E1.token}` },
    });
    report("E1 (Khata only) denied Billing Overview -> 403 Forbidden", e1BillingRes.status === 403, `Status: ${e1BillingRes.status}`);

    // E8: Reports Specialist
    const e8ReportsRes = await fetch(`${BASE_URL}/api/reports`, {
      headers: { Authorization: `Bearer ${employees.E8.token}` },
    });
    report("E8 accesses Reports -> 200 OK", e8ReportsRes.status === 200, `Status: ${e8ReportsRes.status}`);

    const e8SaStatsRes = await fetch(`${BASE_URL}/api/superadmin/dashboard/stats`, {
      headers: { Authorization: `Bearer ${employees.E8.token}` },
    });
    report("E8 denied Superadmin Dashboard Stats -> 403 Forbidden", e8SaStatsRes.status === 403, `Status: ${e8SaStatsRes.status}`);

    // =========================================================================
    // SCENARIO B: Inventory -> Purchases Automatic Inheritance
    // =========================================================================
    console.log("\n--- SCENARIO B: Inventory -> Purchases Automatic Inheritance ---");

    // E4 has assigned_modules: ["inventory"] and NO "purchases" explicitly
    const e4PBListRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      headers: { Authorization: `Bearer ${employees.E4.token}` },
    });
    report(
      "E4 (Inventory assigned) automatically inherits GET /api/purchase-bills",
      e4PBListRes.status === 200,
      `Status: ${e4PBListRes.status}`
    );

    const billNumberE4 = `PB-E4-${Date.now()}`;
    const e4PBCreateRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${employees.E4.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bill_number: billNumberE4,
        vendor_name: "Inherited Vendor",
        bill_date: new Date().toISOString().slice(0, 10),
        items: [
          {
            item_name: "Inherited Goods Item",
            quantity: 4,
            price: 50,
            unit: "Unit",
            item_type: "goods",
            gst_rate: 18,
          },
        ],
      }),
    });
    const e4PBCreateData = await e4PBCreateRes.json();
    const createdPBE4Id = e4PBCreateData.purchase_bill?.id;
    if (createdPBE4Id) cleanupPurchaseBillIds.push(createdPBE4Id);

    report(
      "E4 (Inventory assigned) automatically inherits POST /api/purchase-bills",
      e4PBCreateRes.status === 201 && createdPBE4Id > 0,
      `Status: ${e4PBCreateRes.status}, Created Bill ID: ${createdPBE4Id}`
    );

    // E9 has purchases explicitly assigned
    const e9PBListRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      headers: { Authorization: `Bearer ${employees.E9.token}` },
    });
    report(
      "E9 (Purchases explicit) accesses GET /api/purchase-bills -> 200 OK",
      e9PBListRes.status === 200,
      `Status: ${e9PBListRes.status}`
    );

    // E1 has only khata -> denied purchase-bills
    const e1PBListRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      headers: { Authorization: `Bearer ${employees.E1.token}` },
    });
    report(
      "E1 (Khata only) denied /api/purchase-bills -> 403 Forbidden",
      e1PBListRes.status === 403,
      `Status: ${e1PBListRes.status}`
    );

    // =========================================================================
    // SCENARIO C: Normal User Dashboard vs Superadmin Dashboard
    // =========================================================================
    console.log("\n--- SCENARIO C: Normal User Dashboard vs Superadmin Dashboard ---");

    const saDashboardRes = await fetch(`${BASE_URL}/api/superadmin/dashboard/stats`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const saDashboardData = await saDashboardRes.json();
    report(
      "Superadmin accesses /api/superadmin/dashboard/stats -> 200 OK",
      saDashboardRes.status === 200 && saDashboardData.success === true,
      `Status: ${saDashboardRes.status}, Total Users Metric: ${saDashboardData.metrics?.total_users?.value}`
    );

    const normalUserDashboardRes = await fetch(`${BASE_URL}/api/superadmin/dashboard/stats`, {
      headers: { Authorization: `Bearer ${ownerAToken}` },
    });
    report(
      "Normal User denied /api/superadmin/dashboard/stats -> 403 Forbidden",
      normalUserDashboardRes.status === 403,
      `Status: ${normalUserDashboardRes.status}`
    );

    const normalUserReportsRes = await fetch(`${BASE_URL}/api/reports`, {
      headers: { Authorization: `Bearer ${ownerAToken}` },
    });
    report(
      "Normal User accesses Reports (which serves as their Dashboard) -> 200 OK",
      normalUserReportsRes.status === 200,
      `Status: ${normalUserReportsRes.status}`
    );

    // =========================================================================
    // SCENARIO D: Purchase Bills to Inventory Stock Integration
    // =========================================================================
    console.log("\n--- SCENARIO D: Purchase Bills to Inventory Stock Integration ---");

    // 1. Create a Product Master stock item for Owner A
    const productName = `Product-Integration-${ts}`;
    const [initStockRes] = await pool.query(
      `INSERT INTO stock (product_name, item_type, type, unit, price, quantity, created_by)
       VALUES (?, 'goods', 'goods', 'Unit', 120, 5, ?)`,
      [productName, ownerAId]
    );
    const testStockId = initStockRes.insertId;
    cleanupStockIds.push(testStockId);

    report(
      "Created initial Product Master stock item",
      testStockId > 0,
      `Product ID: ${testStockId}, Name: ${productName}, Initial Qty: 5`
    );

    // 2. E4 creates a purchase bill including this product with quantity = 10
    const billNumberInt = `PB-INT-${ts}`;
    const intBillRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${employees.E4.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bill_number: billNumberInt,
        vendor_name: "Apex Supplies",
        bill_date: new Date().toISOString().slice(0, 10),
        items: [
          {
            product_id: testStockId,
            item_name: productName,
            quantity: 10,
            price: 80,
            unit: "Unit",
            item_type: "goods",
            gst_rate: 18,
          },
        ],
      }),
    });
    const intBillData = await intBillRes.json();
    const intBillId = intBillData.purchase_bill?.id;
    if (intBillId) cleanupPurchaseBillIds.push(intBillId);

    report(
      "E4 creates Purchase Bill linked to Product Master item",
      intBillRes.status === 201 && intBillId > 0,
      `Bill ID: ${intBillId}, Total: ₹${intBillData.purchase_bill?.total_amount}`
    );

    // 3. Verify stock quantity updated by exactly +10 (5 -> 15)
    const [updatedStockRows] = await pool.query(
      "SELECT quantity FROM stock WHERE id = ? AND created_by = ?",
      [testStockId, ownerAId]
    );
    const newQty = Number(updatedStockRows[0]?.quantity || 0);
    report(
      "Stock quantity accurately incremented without duplicates (5 + 10 = 15)",
      newQty === 15,
      `Expected: 15, Actual: ${newQty}`
    );

    // 4. Verify single linked payment record created
    const [linkedPayments] = await pool.query(
      "SELECT id, amount, payment_mode FROM payments WHERE purchase_bill_id = ? AND created_by = ?",
      [intBillId, ownerAId]
    );
    report(
      "Exactly one payment automatically linked to Purchase Bill",
      linkedPayments.length === 1,
      `Payments Count: ${linkedPayments.length}, Amount: ₹${linkedPayments[0]?.amount}`
    );

    // 5. Test search purchase items for Product Master autofill
    const searchItemsRes = await fetch(`${BASE_URL}/api/purchase-bills/items?search=${productName}`, {
      headers: { Authorization: `Bearer ${employees.E4.token}` },
    });
    const searchItemsData = await searchItemsRes.json();
    report(
      "Search purchase items returns matching items for product autofill",
      searchItemsRes.status === 200 && searchItemsData.items?.length > 0,
      `Returned: ${searchItemsData.items?.length} items matching '${productName}'`
    );

    // =========================================================================
    // SCENARIO E: Superadmin On-Behalf-Of Operations & Audit Logs API
    // =========================================================================
    console.log("\n--- SCENARIO E: Superadmin On-Behalf-Of Operations & Audit Logs API ---");

    const saAuditRes = await fetch(`${BASE_URL}/api/superadmin/audit-logs`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const saAuditData = await saAuditRes.json();
    report(
      "Superadmin accesses GET /api/superadmin/audit-logs -> 200 OK",
      saAuditRes.status === 200 && Array.isArray(saAuditData.data),
      `Status: ${saAuditRes.status}, Total Logged: ${saAuditData.pagination?.total}`
    );

    const normalUserAuditRes = await fetch(`${BASE_URL}/api/superadmin/audit-logs`, {
      headers: { Authorization: `Bearer ${ownerAToken}` },
    });
    report(
      "Normal User denied GET /api/superadmin/audit-logs -> 403 Forbidden",
      normalUserAuditRes.status === 403,
      `Status: ${normalUserAuditRes.status}`
    );

    const empAuditRes = await fetch(`${BASE_URL}/api/superadmin/audit-logs`, {
      headers: { Authorization: `Bearer ${employees.E4.token}` },
    });
    report(
      "Employee denied GET /api/superadmin/audit-logs -> 403 Forbidden",
      empAuditRes.status === 403,
      `Status: ${empAuditRes.status}`
    );

    // =========================================================================
    // SCENARIO F: Granular Employee Permission Enforcement (Read-only vs Write)
    // =========================================================================
    console.log("\n--- SCENARIO F: Granular Employee Permission Enforcement (Read-only vs Write) ---");

    // E10: Read-Only Auditor has view permissions only
    const e10StockViewRes = await fetch(`${BASE_URL}/api/stock`, {
      headers: { Authorization: `Bearer ${employees.E10.token}` },
    });
    report(
      "E10 (Read-Only) accesses GET /api/stock -> 200 OK",
      e10StockViewRes.status === 200,
      `Status: ${e10StockViewRes.status}`
    );

    const e10StockCreateRes = await fetch(`${BASE_URL}/api/stock`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${employees.E10.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_name: "E10 Unauthorized Product",
        price: 100,
        quantity: 1,
      }),
    });
    report(
      "E10 (Read-Only) denied POST /api/stock -> 403 Forbidden",
      e10StockCreateRes.status === 403,
      `Status: ${e10StockCreateRes.status}`
    );

    const e10PBViewRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      headers: { Authorization: `Bearer ${employees.E10.token}` },
    });
    report(
      "E10 (Read-Only) accesses GET /api/purchase-bills -> 200 OK",
      e10PBViewRes.status === 200,
      `Status: ${e10PBViewRes.status}`
    );

    const e10PBCreateRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${employees.E10.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bill_number: "E10-ILLEGAL-BILL",
        vendor_name: "Illegal Vendor",
        items: [],
      }),
    });
    report(
      "E10 (Read-Only) denied POST /api/purchase-bills -> 403 Forbidden",
      e10PBCreateRes.status === 403,
      `Status: ${e10PBCreateRes.status}`
    );

    // =========================================================================
    // SCENARIO G: Audit Trail Logging & Retrieval
    // =========================================================================
    console.log("\n--- SCENARIO G: Audit Trail Logging & Retrieval ---");

    const [auditRows] = await pool.query(
      `SELECT * FROM admin_audit_logs WHERE action = 'CREATE_PURCHASE_BILL' AND target_id = ?`,
      [String(intBillId)]
    );
    report(
      "Audit event recorded for CREATE_PURCHASE_BILL in admin_audit_logs",
      auditRows.length > 0,
      `Found ${auditRows.length} audit entry for Target ID: ${intBillId}`
    );

    const saFilterRes = await fetch(`${BASE_URL}/api/superadmin/audit-logs?action=CREATE_PURCHASE_BILL&search=${billNumberInt}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const saFilterData = await saFilterRes.json();
    report(
      "Superadmin can filter audit trail by action and search term",
      saFilterRes.status === 200 && saFilterData.data?.length > 0,
      `Found ${saFilterData.data?.length} matching entries for search '${billNumberInt}'`
    );

    // =========================================================================
    // SCENARIO H: Tenant Isolation Across Business Owners
    // =========================================================================
    console.log("\n--- SCENARIO H: Tenant Isolation Across Business Owners ---");

    // Owner B lists purchase bills -> must NOT see Owner A's purchase bill
    const ownerBPBRes = await fetch(`${BASE_URL}/api/purchase-bills`, {
      headers: { Authorization: `Bearer ${ownerBToken}` },
    });
    const ownerBPBData = await ownerBPBRes.json();
    const foundOwnerABillInOwnerB = (ownerBPBData.purchase_bills || []).some((b) => b.id === intBillId);
    report(
      "Owner B list query isolates tenant data (Owner A's bill is NOT visible)",
      ownerBPBRes.status === 200 && !foundOwnerABillInOwnerB,
      `Owner B Bills Count: ${ownerBPBData.purchase_bills?.length}, Leak: ${foundOwnerABillInOwnerB}`
    );

    // Owner B directly querying Owner A's bill ID -> 404 Not Found
    const ownerBGetABillRes = await fetch(`${BASE_URL}/api/purchase-bills/${intBillId}`, {
      headers: { Authorization: `Bearer ${ownerBToken}` },
    });
    report(
      "Owner B cannot access Owner A's bill by ID -> 404 Not Found",
      ownerBGetABillRes.status === 404,
      `Status: ${ownerBGetABillRes.status}`
    );

    // Owner B directly querying Owner A's stock ID -> 404 Not Found
    const ownerBGetAStockRes = await fetch(`${BASE_URL}/api/stock/${testStockId}`, {
      headers: { Authorization: `Bearer ${ownerBToken}` },
    });
    report(
      "Owner B cannot access Owner A's stock by ID -> 404 Not Found",
      ownerBGetAStockRes.status === 404,
      `Status: ${ownerBGetAStockRes.status}`
    );

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log("\n========================================================================");
    console.log("TEST EXECUTION SUMMARY");
    console.log("========================================================================");
    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.filter((r) => !r.passed).length;
    console.log(`Total Tests Run : ${results.length}`);
    console.log(`Passed         : ${passedCount}`);
    console.log(`Failed         : ${failedCount}`);

    if (failedCount > 0) {
      console.log("\n❌ FAILED TESTS:");
      results.filter((r) => !r.passed).forEach((r) => console.log(` - ${r.name}: ${r.details}`));
      process.exitCode = 1;
    } else {
      console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY!");
    }
  } catch (err) {
    console.error("\n❌ Test Suite Aborted with Unhandled Error:", err);
    process.exitCode = 1;
  } finally {
    // Cleanup test artifacts
    console.log("\nCleaning up test records...");
    try {
      if (cleanupPurchaseBillIds.length) {
        await pool.query("DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (?)", [cleanupPurchaseBillIds]);
        await pool.query("DELETE FROM payments WHERE purchase_bill_id IN (?)", [cleanupPurchaseBillIds]);
        await pool.query("DELETE FROM purchase_bills WHERE id IN (?)", [cleanupPurchaseBillIds]);
      }
      if (cleanupStockIds.length) {
        await pool.query("DELETE FROM stock WHERE id IN (?)", [cleanupStockIds]);
      }
      if (cleanupUserIds.length) {
        await pool.query("DELETE FROM subscriptions WHERE user_id IN (?)", [cleanupUserIds]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id IN (?)", [cleanupUserIds]);
        await pool.query("DELETE FROM admin_audit_logs WHERE actor_id IN (?)", [cleanupUserIds]);
        await pool.query("DELETE FROM users WHERE id IN (?)", [cleanupUserIds]);
      }
      console.log("Cleanup completed.");
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr.message);
    }
    process.exit(process.exitCode || 0);
  }
}

main();
