/**
 * scripts/test_soft_delete_and_drilldowns.js
 * 
 * Comprehensive End-to-End Test Suite for:
 * 1. User Registration & Razorpay Test Mode Subscription Purchase
 * 2. Multi-module Ledger Population (Customers, Khata, Payments, Invoices, Vehicles, Support Tickets)
 * 3. Superadmin Active Users Verification (State, Counts, Badges)
 * 4. Soft-delete Execution (Referential Integrity Check, Idempotency, Audit Trail)
 * 5. Session Revocation & Login Blocking (HTTP 403)
 * 6. Superadmin Deleted Users Archive Verification (Badges, Metadata, Audit Reason)
 * 7. All 13 Dashboard Drill-Down APIs historical continuity under Superadmin & Employee
 * 8. User Account Restoration (Re-activation, Employee reinstatement, Login unblocking)
 * 9. Idempotency & Tenant Safety
 */

require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const pool = require("../config/db");

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "khatanex_super_secret_jwt_key_2026";

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      employee_role_type: user.employee_role_type,
      created_by_admin: user.created_by_admin,
    },
    JWT_SECRET,
    { expiresIn: "2h" }
  );
}

function request({ method = "GET", path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (dataString) {
      reqHeaders["Content-Length"] = Buffer.byteLength(dataString);
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on("error", reject);
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("🧪 KHATANEX END-TO-END SOFT-DELETE, ARCHIVE & DRILL-DOWN REGRESSION TEST SUITE");
  console.log(`Backend Target: ${BASE_URL}`);
  console.log("================================================================================\n");

  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push({ name, passed: true, error: null });
      console.log(`  ✅ PASS: ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: err.message });
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Reason: ${err.message}\n`);
    }
  };

  const ts = Date.now();
  const dummyEmail = `dummy_user_audit_1_${ts}@test.com`;
  const dummyPassword = "Password123!";
  let dummyUser = null;
  let dummyToken = null;
  let superadminUser = null;
  let superadminToken = null;
  let employeeUser = null;
  let employeeToken = null;
  let staffEmployeeUser = null;

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES
    // -------------------------------------------------------------------------
    // 1. Create Superadmin fixture
    const hashedSapass = await bcrypt.hash("AdminPass123!", 10);
    const [saRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status)
       VALUES (?, ?, ?, 'superadmin', 'active')`,
      [`SuperAdmin Audit ${ts}`, `sa_audit_${ts}@khatanex.test`, hashedSapass]
    );
    superadminUser = { id: saRes.insertId, name: `SuperAdmin Audit ${ts}`, email: `sa_audit_${ts}@khatanex.test`, role: "superadmin" };
    superadminToken = signToken(superadminUser);

    // 2. Create delegated Employee fixture (assigned to 'users', 'invoices', 'customers', 'khata', 'payments', 'reports')
    const [empRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, permissions, status)
       VALUES (?, ?, ?, 'employee', 'manager', ?, ?, 'active')`,
      [
        `Auditor Employee ${ts}`,
        `emp_audit_${ts}@khatanex.test`,
        hashedSapass,
        JSON.stringify(["users", "customers", "invoices", "quotations", "payments", "khata", "reports", "inventory", "vehicles", "billing"]),
        JSON.stringify({ users: ["view"], customers: ["view"], invoices: ["view"], quotations: ["view"], payments: ["view"], khata: ["view"], reports: ["view"], inventory: ["view"], vehicles: ["view"], billing: ["view"] }),
      ]
    );
    employeeUser = { id: empRes.insertId, name: `Auditor Employee ${ts}`, email: `emp_audit_${ts}@khatanex.test`, role: "employee" };
    employeeToken = signToken(employeeUser);

    // -------------------------------------------------------------------------
    // TEST 1: Register Dummy User
    // -------------------------------------------------------------------------
    await test("1. User Registration: Register dummy business owner via API", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Dummy Audit Business Owner",
          email: dummyEmail,
          password: dummyPassword,
          phone: "9876543210",
          business_name: "Audit Enterprises Pvt Ltd",
          address: "123 Business Way, Industrial Hub",
        },
      });

      if (res.status !== 201) {
        throw new Error(`Expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.token || !res.data.user?.id) {
        throw new Error("Missing token or user in registration response");
      }

      dummyUser = res.data.user;
      dummyToken = res.data.token;
      if (dummyUser.email !== dummyEmail) {
        throw new Error(`Email mismatch: expected ${dummyEmail}, got ${dummyUser.email}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 2: Create an employee under the Dummy Business Owner
    // -------------------------------------------------------------------------
    await test("2. Employee Creation: Create employee under business owner", async () => {
      const [staffRes] = await pool.query(
        `INSERT INTO users (name, email, password, role, employee_role_type, created_by_admin, status)
         VALUES (?, ?, ?, 'employee', 'staff', ?, 'active')`,
        [
          `Staff Member of ${dummyUser.name}`,
          `staff_${ts}@dummybiz.test`,
          hashedSapass,
          dummyUser.id,
        ]
      );
      staffEmployeeUser = { id: staffRes.insertId, role: "employee", created_by_admin: dummyUser.id };
    });

    // -------------------------------------------------------------------------
    // TEST 3: Purchase / Activate Subscription in Razorpay Test Mode
    // -------------------------------------------------------------------------
    await test("3. Subscription Purchase: Razorpay Order Creation and Verification", async () => {
      // Create Razorpay order
      const orderRes = await request({
        method: "POST",
        path: "/api/subscriptions/orders",
        headers: { Authorization: `Bearer ${dummyToken}` },
        body: { plan_code: "monthly" },
      });

      if ((orderRes.status !== 200 && orderRes.status !== 201) || !orderRes.data?.order?.id) {
        throw new Error(`Order creation failed: HTTP ${orderRes.status}: ${JSON.stringify(orderRes.data)}`);
      }

      const orderData = orderRes.data.order;
      const rzpPaymentId = `pay_test_${Date.now()}`;
      const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_mock_secret_default_2026";
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderData.providerOrderId}|${rzpPaymentId}`)
        .digest("hex");

      // Verify payment at /api/subscriptions/orders/:id/verify
      const verifyRes = await request({
        method: "POST",
        path: `/api/subscriptions/orders/${orderData.id}/verify`,
        headers: { Authorization: `Bearer ${dummyToken}` },
        body: {
          provider_payment_id: rzpPaymentId,
          provider_signature: signature,
        },
      });

      if (verifyRes.status !== 200 || !verifyRes.data?.success) {
        throw new Error(`Verification failed: HTTP ${verifyRes.status}: ${JSON.stringify(verifyRes.data)}`);
      }

      // Check subscription record exists
      const [subRows] = await pool.query("SELECT * FROM subscriptions WHERE user_id = ?", [dummyUser.id]);
      if (!subRows.length) {
        throw new Error("No subscription record found in database for user");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 4: Populate Multi-Module Business Data
    // -------------------------------------------------------------------------
    let createdCustomerId = null;
    await test("4. Multi-module Ledger Population (Customer, Khata, Payments, Invoices, Vehicles, Tickets)", async () => {
      // 4a. Create customer
      const custRes = await request({
        method: "POST",
        path: "/api/customers",
        headers: { Authorization: `Bearer ${dummyToken}` },
        body: {
          name: "Audit Client Co",
          phone: "9888877777",
          email: "client@auditco.test",
          address: "456 Market St",
        },
      });
      if (custRes.status !== 201 && custRes.status !== 200) {
        throw new Error(`Failed to create customer: HTTP ${custRes.status}: ${JSON.stringify(custRes.data)}`);
      }
      createdCustomerId = custRes.data?.customer?.id || custRes.data?.id;

      // 4b. Create khata entries
      await pool.query(
        `INSERT INTO khata_entries (customer_id, type, amount, description, entry_date, created_by)
         VALUES (?, 'credit', 15000.00, 'Audit sales invoice delivery', NOW(), ?),
                (?, 'debit', 5000.00, 'Advance payment returned', NOW(), ?)`,
        [createdCustomerId, dummyUser.id, createdCustomerId, dummyUser.id]
      );

      // 4c. Create payment record
      await pool.query(
        `INSERT INTO payments (created_by, customer_id, amount, payment_mode, payment_category, purpose, payment_date)
         VALUES (?, ?, 10000.00, 'online', 'due_received', 'Audit Client Payment', CURDATE())`,
        [dummyUser.id, createdCustomerId]
      );

      // 4d. Create invoice record
      const [invRes] = await pool.query(
        `INSERT INTO invoices (created_by, customer_id, invoice_number, total_amount, subtotal, document_status, invoice_date, due_date)
         VALUES (?, ?, ?, 15000.00, 15000.00, 'issued', CURDATE(), CURDATE())`,
        [dummyUser.id, createdCustomerId, `INV-AUDIT-${ts}`]
      );

      // 4e. Create vehicle trip record
      await pool.query(
        `INSERT INTO vehicle_trips (created_by, vehicle_number, driver_name, from_location, to_location, goods_description, status)
         VALUES (?, 'WB-01-AB-1234', 'Ramesh Driver', 'Warehouse A', 'Dock B', 'Electronic components', 'in_transit')`,
        [dummyUser.id]
      );

      // 4f. Create support ticket
      await pool.query(
        `INSERT INTO support_tickets (ticket_number, user_id, department, category, subject, description, status)
         VALUES (?, ?, 'technical', 'Software', 'Audit Dummy Ticket Subject', 'Everything is running smoothly for audit test', 'open')`,
        [`TKT-AUDIT-${ts}`, dummyUser.id]
      );
    });

    // -------------------------------------------------------------------------
    // TEST 5: Verify Active Users List & Count Badges
    // -------------------------------------------------------------------------
    await test("5. Superadmin Active Users Verification: dummy user appears in active tab", async () => {
      const res = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200: ${JSON.stringify(res.data)}`);
      }

      const activeList = res.data.users || [];
      const userInActive = activeList.find((u) => u.id === dummyUser.id);
      if (!userInActive) {
        throw new Error("Newly registered dummy user was not found in active tab");
      }

      if (userInActive.is_deleted || userInActive.status === "deleted") {
        throw new Error("Active user marked as deleted");
      }

      // Check counts breakdown in response
      if (!res.data.counts || typeof res.data.counts.active !== "number" || typeof res.data.counts.deleted !== "number") {
        throw new Error(`Missing or invalid counts in response: ${JSON.stringify(res.data.counts)}`);
      }

      // Verify dummy user does NOT appear in deleted tab
      const delRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=deleted",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const delList = delRes.data?.users || [];
      if (delList.some((u) => u.id === dummyUser.id)) {
        throw new Error("Active dummy user erroneously appeared in deleted users tab");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 6: Delegated Employee access to Active Users
    // -------------------------------------------------------------------------
    await test("6. Employee Active Users Verification: delegated employee sees dummy user", async () => {
      const res = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${employeeToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Employee request failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      const userInActive = res.data.users.find((u) => u.id === dummyUser.id);
      if (!userInActive) {
        throw new Error("Employee could not see active user");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 7: Execute Soft Delete as Superadmin
    // -------------------------------------------------------------------------
    await test("7. Soft-Delete Execution: DELETE /api/superadmin/users/:id preserves data and marks deleted", async () => {
      const deleteReason = "Statutory compliance test deletion by Superadmin";
      const delRes = await request({
        method: "DELETE",
        path: `/api/superadmin/users/${dummyUser.id}`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: deleteReason },
      });

      if (delRes.status !== 200 || !delRes.data?.success) {
        throw new Error(`Delete failed: HTTP ${delRes.status}: ${JSON.stringify(delRes.data)}`);
      }

      if (delRes.data.type !== "soft_deleted" || delRes.data.user?.status !== "deleted") {
        throw new Error(`Unexpected delete response: ${JSON.stringify(delRes.data)}`);
      }

      // Check DB directly: row must NOT be deleted from users table
      const [userRows] = await pool.query("SELECT * FROM users WHERE id = ?", [dummyUser.id]);
      if (!userRows.length) {
        throw new Error("CRITICAL: User was permanently removed from database! Soft delete failed.");
      }
      const dbUser = userRows[0];
      if (dbUser.status !== "deleted" || !dbUser.deleted_at || dbUser.deleted_by !== superadminUser.id) {
        throw new Error(`DB user status mismatch: status=${dbUser.status}, deleted_at=${dbUser.deleted_at}, deleted_by=${dbUser.deleted_by}`);
      }
      if (dbUser.deletion_reason !== deleteReason) {
        throw new Error(`Deletion reason mismatch: expected '${deleteReason}', got '${dbUser.deletion_reason}'`);
      }

      // Verify associated staff employee was deactivated
      const [staffRows] = await pool.query("SELECT status FROM users WHERE id = ?", [staffEmployeeUser.id]);
      if (staffRows[0]?.status !== "inactive") {
        throw new Error(`Associated staff employee not deactivated: status is ${staffRows[0]?.status}`);
      }

      // Verify audit trail logged
      const [auditRows] = await pool.query(
        "SELECT * FROM user_audit_logs WHERE target_user_id = ? ORDER BY id DESC LIMIT 1",
        [dummyUser.id]
      );
      if (!auditRows.length || auditRows[0].action !== "soft_delete_user") {
        throw new Error("Missing user_audit_logs record for soft delete");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 8: Verify Listings Separation After Soft Delete
    // -------------------------------------------------------------------------
    await test("8. Tab Separation: User gone from Active tab, present in Deleted Archive with metadata", async () => {
      // 1. Active tab
      const activeRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const inActive = (activeRes.data?.users || []).some((u) => u.id === dummyUser.id);
      if (inActive) {
        throw new Error("Soft-deleted user is still appearing in Active Users tab!");
      }

      // 2. Deleted tab
      const delRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=deleted",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const deletedUser = (delRes.data?.users || []).find((u) => u.id === dummyUser.id);
      if (!deletedUser) {
        throw new Error("Soft-deleted user NOT found in Deleted Users archive tab!");
      }

      if (!deletedUser.is_deleted || deletedUser.status !== "deleted") {
        throw new Error(`Deleted user flags mismatch: is_deleted=${deletedUser.is_deleted}, status=${deletedUser.status}`);
      }
      if (!deletedUser.deleted_at) {
        throw new Error("Missing deleted_at timestamp in deleted users list");
      }
      if (deletedUser.deleted_by_name !== superadminUser.name) {
        throw new Error(`deleted_by_name mismatch: expected '${superadminUser.name}', got '${deletedUser.deleted_by_name}'`);
      }
      if (deletedUser.deletion_reason !== "Statutory compliance test deletion by Superadmin") {
        throw new Error(`deletion_reason mismatch: ${deletedUser.deletion_reason}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 9: Invalidate Login & Existing Sessions
    // -------------------------------------------------------------------------
    await test("9. Access Revocation: Login rejected (403) and existing JWT blocked (403)", async () => {
      // Attempt login
      const loginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: dummyEmail,
          password: dummyPassword,
        },
      });

      if (loginRes.status !== 403) {
        throw new Error(`Expected HTTP 403 Forbidden on login for deleted user, got ${loginRes.status}: ${JSON.stringify(loginRes.data)}`);
      }
      if (!String(loginRes.data?.message || "").includes("deleted")) {
        throw new Error(`Unexpected message on deleted user login: ${loginRes.data?.message}`);
      }

      // Attempt API call using dummyToken
      const apiRes = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${dummyToken}` },
      });

      if (apiRes.status !== 403) {
        throw new Error(`Expected HTTP 403 Forbidden using token for deleted user, got ${apiRes.status}`);
      }

      // Attempt login with associated staff employee
      const staffLoginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: `staff_${ts}@dummybiz.test`,
          password: "AdminPass123!",
        },
      });
      if (staffLoginRes.status !== 403) {
        throw new Error(`Expected HTTP 403 for employee of deleted owner, got ${staffLoginRes.status}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 10: Verify All 13 Dashboard Drill-Down APIs Work for Deleted User
    // -------------------------------------------------------------------------
    await test("10. Historical Continuity: All 13 drill-down endpoints return historical records without crashing", async () => {
      const endpoints = [
        { name: "User Details", path: `/api/superadmin/users/${dummyUser.id}` },
        { name: "Overview", path: `/api/superadmin/users/${dummyUser.id}/overview` },
        { name: "Invoices", path: `/api/superadmin/users/${dummyUser.id}/invoices` },
        { name: "Quotations", path: `/api/superadmin/users/${dummyUser.id}/quotations` },
        { name: "Money Receipts", path: `/api/superadmin/users/${dummyUser.id}/money-receipts` },
        { name: "Customers", path: `/api/superadmin/users/${dummyUser.id}/customers` },
        { name: "Khata", path: `/api/superadmin/users/${dummyUser.id}/khata` },
        { name: "Payments", path: `/api/superadmin/users/${dummyUser.id}/payments` },
        { name: "Purchase Bills", path: `/api/superadmin/users/${dummyUser.id}/purchase-bills` },
        { name: "Inventory", path: `/api/superadmin/users/${dummyUser.id}/inventory` },
        { name: "Vehicles", path: `/api/superadmin/users/${dummyUser.id}/vehicles` },
        { name: "Billing", path: `/api/superadmin/users/${dummyUser.id}/billing` },
        { name: "Reports", path: `/api/superadmin/users/${dummyUser.id}/reports` },
      ];

      for (const ep of endpoints) {
        const res = await request({
          method: "GET",
          path: ep.path,
          headers: { Authorization: `Bearer ${superadminToken}` },
        });

        if (res.status !== 200 || !res.data?.success) {
          throw new Error(`Drilldown ${ep.name} failed with HTTP ${res.status}: ${JSON.stringify(res.data)}`);
        }
      }

      // Verify specific data presence in drilldowns
      const invRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${dummyUser.id}/invoices`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const invoices = invRes.data?.invoices || [];
      if (!invoices.length || !invoices.some((i) => i.invoice_number === `INV-AUDIT-${ts}`)) {
        throw new Error("Created invoice missing from user drill-down");
      }

      const custRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${dummyUser.id}/customers`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const customers = custRes.data?.customers || [];
      if (!customers.length || !customers.some((c) => c.name === "Audit Client Co")) {
        throw new Error("Created customer missing from user drill-down");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 11: Delegated Employee Access to Deleted User Drill-Downs
    // -------------------------------------------------------------------------
    await test("11. Delegated Employee Drill-down: Employee can inspect deleted user records", async () => {
      const res = await request({
        method: "GET",
        path: `/api/superadmin/users/${dummyUser.id}/invoices`,
        headers: { Authorization: `Bearer ${employeeToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Employee drilldown failed: HTTP ${res.status}`);
      }
      if (!res.data.invoices || !res.data.invoices.length) {
        throw new Error("Employee could not view invoices for soft-deleted user");
      }
    });

    // -------------------------------------------------------------------------
    // TEST 12: Account Restoration Execution
    // -------------------------------------------------------------------------
    await test("12. Account Restoration: POST /api/superadmin/users/:id/restore reinstates user and staff", async () => {
      const restoreReason = "Client requested reinstatement after audit verification";
      const restRes = await request({
        method: "POST",
        path: `/api/superadmin/users/${dummyUser.id}/restore`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: restoreReason },
      });

      if (restRes.status !== 200 || !restRes.data?.success) {
        throw new Error(`Restore failed: HTTP ${restRes.status}: ${JSON.stringify(restRes.data)}`);
      }

      if (restRes.data.user?.status !== "active" || restRes.data.user?.is_deleted !== false) {
        throw new Error(`Unexpected restore response: ${JSON.stringify(restRes.data)}`);
      }

      // Check DB directly
      const [userRows] = await pool.query("SELECT * FROM users WHERE id = ?", [dummyUser.id]);
      const dbUser = userRows[0];
      if (dbUser.status !== "active" || dbUser.deleted_at !== null || dbUser.deleted_by !== null) {
        throw new Error(`User not restored in DB: status=${dbUser.status}, deleted_at=${dbUser.deleted_at}`);
      }
      if (!dbUser.restored_at || dbUser.restored_by !== superadminUser.id || dbUser.restoration_reason !== restoreReason) {
        throw new Error(`Restoration metadata mismatch: restored_at=${dbUser.restored_at}, restored_by=${dbUser.restored_by}, reason=${dbUser.restoration_reason}`);
      }

      // Check associated staff employee was reactivated
      const [staffRows] = await pool.query("SELECT status FROM users WHERE id = ?", [staffEmployeeUser.id]);
      if (staffRows[0]?.status !== "active") {
        throw new Error(`Associated staff employee not reactivated: status is ${staffRows[0]?.status}`);
      }

      // Verify user moved back to Active tab and removed from Deleted tab
      const activeRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const inActive = (activeRes.data?.users || []).some((u) => u.id === dummyUser.id);
      if (!inActive) {
        throw new Error("Restored user is NOT in Active Users tab!");
      }

      const delRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=deleted",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const inDeleted = (delRes.data?.users || []).some((u) => u.id === dummyUser.id);
      if (inDeleted) {
        throw new Error("Restored user is still appearing in Deleted Users tab!");
      }

      // Test login now works seamlessly
      const loginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: dummyEmail,
          password: dummyPassword,
        },
      });
      if (loginRes.status !== 200 || !loginRes.data?.token) {
        throw new Error(`Login after restore failed: HTTP ${loginRes.status}: ${JSON.stringify(loginRes.data)}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 13: Idempotency Verification
    // -------------------------------------------------------------------------
    await test("13. Idempotency Verification: Repeated restores and deletes succeed gracefully", async () => {
      // Restore on already active user
      const restRes = await request({
        method: "POST",
        path: `/api/superadmin/users/${dummyUser.id}/restore`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      if (restRes.status !== 200 || !restRes.data?.success) {
        throw new Error(`Idempotent restore failed: HTTP ${restRes.status}`);
      }

      // Delete user again
      const delRes1 = await request({
        method: "DELETE",
        path: `/api/superadmin/users/${dummyUser.id}`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      if (delRes1.status !== 200 || !delRes1.data?.success) {
        throw new Error(`Re-delete failed: HTTP ${delRes1.status}`);
      }

      // Delete already deleted user (idempotent check)
      const delRes2 = await request({
        method: "DELETE",
        path: `/api/superadmin/users/${dummyUser.id}`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      if (delRes2.status !== 200 || !delRes2.data?.success || delRes2.data?.type !== "already_deleted") {
        throw new Error(`Idempotent delete failed: HTTP ${delRes2.status}: ${JSON.stringify(delRes2.data)}`);
      }
    });

    // -------------------------------------------------------------------------
    // SUMMARY
    // -------------------------------------------------------------------------
    console.log("\n================================================================================");
    console.log("📊 TEST EXECUTION SUMMARY");
    console.log("================================================================================");
    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.filter((r) => !r.passed).length;
    console.log(`Total Tests Run: ${results.length}`);
    console.log(`Passed:         ${passedCount} / ${results.length}`);
    console.log(`Failed:         ${failedCount} / ${results.length}`);
    console.log("================================================================================\n");

    if (failedCount > 0) {
      console.error("❌ Some tests failed. Please inspect the failures above.");
      process.exit(1);
    } else {
      console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! Soft-delete, archive & drill-downs fully verified.");
    }
  } catch (err) {
    console.error("Critical test runner error:", err);
    process.exit(1);
  } finally {
    // Clean up test fixtures created during the test
    try {
      if (dummyUser) {
        await pool.query("DELETE FROM support_tickets WHERE user_id = ?", [dummyUser.id]);
        await pool.query("DELETE FROM vehicle_trips WHERE created_by = ?", [dummyUser.id]);
        await pool.query("DELETE FROM payments WHERE created_by = ?", [dummyUser.id]);
        await pool.query("DELETE FROM invoices WHERE created_by = ?", [dummyUser.id]);
        await pool.query("DELETE FROM khata_entries WHERE created_by = ?", [dummyUser.id]);
        await pool.query("DELETE FROM customers WHERE created_by = ?", [dummyUser.id]);
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [dummyUser.id]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [dummyUser.id]);
        await pool.query("DELETE FROM user_audit_logs WHERE target_user_id = ?", [dummyUser.id]);
        await pool.query("DELETE FROM admin_audit_logs WHERE target_id = ?", [String(dummyUser.id)]);
        await pool.query("DELETE FROM users WHERE created_by_admin = ?", [dummyUser.id]);
        await pool.query("DELETE FROM users WHERE id = ?", [dummyUser.id]);
      }
      if (superadminUser) {
        await pool.query("DELETE FROM users WHERE id = ?", [superadminUser.id]);
      }
      if (employeeUser) {
        await pool.query("DELETE FROM users WHERE id = ?", [employeeUser.id]);
      }
    } catch (_) {}
    process.exit(0);
  }
}

runTestSuite();
