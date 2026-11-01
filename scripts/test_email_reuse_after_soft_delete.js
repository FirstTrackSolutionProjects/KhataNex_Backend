/**
 * scripts/test_email_reuse_after_soft_delete.js
 * 
 * Comprehensive End-to-End Test Suite for:
 * - Test A: Initial Account Creation and Multi-module Activity
 * - Test B: Soft Deletion Lifecycle, Metadata & Session Revocation
 * - Test C: Re-registration with the Exact Same Email (NEW_USER_ID !== OLD_USER_ID)
 * - Test D: Strict Data Isolation Verification (Ledger zero-state for new user vs preserved historical state)
 * - Test E: Authentication, Password Routing, Uniqueness Concurrency & Restore Conflict Resolution (409)
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
  console.log("🧪 KHATANEX END-TO-END EMAIL REUSE AFTER SOFT DELETION TEST SUITE");
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
  const testEmail = `reuse_test_${ts}@khatanex.test`;
  const passwordOld = "PasswordOld123!";
  const passwordNew = "PasswordNew456!";

  let oldUserId = null;
  let oldUserToken = null;
  let oldCustomerId = null;

  let newUserId = null;
  let newUserToken = null;

  let superadminUser = null;
  let superadminToken = null;
  let employeeUser = null;
  let employeeToken = null;

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES: Superadmin and Delegated Employee
    // -------------------------------------------------------------------------
    const hashedSapass = await bcrypt.hash("AdminPass123!", 10);
    const [saRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status)
       VALUES (?, ?, ?, 'superadmin', 'active')`,
      [`SuperAdmin Reuse ${ts}`, `sa_reuse_${ts}@khatanex.test`, hashedSapass]
    );
    superadminUser = { id: saRes.insertId, name: `SuperAdmin Reuse ${ts}`, email: `sa_reuse_${ts}@khatanex.test`, role: "superadmin" };
    superadminToken = signToken(superadminUser);

    const [empRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, permissions, status)
       VALUES (?, ?, ?, 'employee', 'manager', ?, ?, 'active')`,
      [
        `Employee Reuse ${ts}`,
        `emp_reuse_${ts}@khatanex.test`,
        hashedSapass,
        JSON.stringify(["users", "customers", "invoices", "quotations", "payments", "khata", "reports", "inventory", "vehicles", "billing"]),
        JSON.stringify({ users: ["view"], customers: ["view"], invoices: ["view"], quotations: ["view"], payments: ["view"], khata: ["view"], reports: ["view"], inventory: ["view"], vehicles: ["view"], billing: ["view"] }),
      ]
    );
    employeeUser = { id: empRes.insertId, name: `Employee Reuse ${ts}`, email: `emp_reuse_${ts}@khatanex.test`, role: "employee" };
    employeeToken = signToken(employeeUser);

    // =========================================================================
    // TEST A: INITIAL ACCOUNT CREATION AND MULTI-MODULE ACTIVITY
    // =========================================================================
    console.log("--- TEST A: Initial Account Creation and Multi-Module Activity ---");

    await test("A.1 Register initial user account and record OLD_USER_ID", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Original Account Owner",
          email: testEmail,
          password: passwordOld,
          phone: "9876500001",
          business_name: "Original Business Pvt Ltd",
          address: "101 Old Heritage Road",
        },
      });

      if (res.status !== 201) {
        throw new Error(`Expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.token || !res.data.user?.id) {
        throw new Error("Missing token or user in registration response");
      }

      oldUserId = res.data.user.id;
      oldUserToken = res.data.token;
      if (res.data.user.email !== testEmail) {
        throw new Error(`Email mismatch: expected ${testEmail}, got ${res.data.user.email}`);
      }
      console.log(`     Recorded OLD_USER_ID: ${oldUserId}`);
    });

    await test("A.2 Confirm initial account is active and can authenticate", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${oldUserToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200 from /api/auth/me: ${JSON.stringify(res.data)}`);
      }
      if (res.data.user.id !== oldUserId || res.data.user.status !== "active") {
        throw new Error(`User status or ID mismatch: ${JSON.stringify(res.data.user)}`);
      }
    });

    await test("A.3 Populate multi-module ledger records for OLD_USER_ID", async () => {
      // 1. Activate subscription in test mode so mutations pass requireSubscription
      const orderRes = await request({
        method: "POST",
        path: "/api/subscriptions/orders",
        headers: { Authorization: `Bearer ${oldUserToken}` },
        body: { plan_code: "monthly" },
      });

      if ((orderRes.status === 200 || orderRes.status === 201) && orderRes.data?.order?.id) {
        const orderData = orderRes.data.order;
        const rzpPaymentId = `pay_test_${Date.now()}`;
        const secret = process.env.RAZORPAY_KEY_SECRET || "rzp_test_mock_secret_default_2026";
        const signature = crypto
          .createHmac("sha256", secret)
          .update(`${orderData.providerOrderId}|${rzpPaymentId}`)
          .digest("hex");

        await request({
          method: "POST",
          path: `/api/subscriptions/orders/${orderData.id}/verify`,
          headers: { Authorization: `Bearer ${oldUserToken}` },
          body: {
            provider_payment_id: rzpPaymentId,
            provider_signature: signature,
          },
        });
      } else {
        // Fallback: grant complimentary subscription directly in DB
        await pool.query(
          `INSERT INTO subscriptions (user_id, plan_id, starts_at, ends_at, is_complimentary, status)
           VALUES (?, 1, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 1, 'active')`,
          [oldUserId]
        );
      }

      // 2. Customer
      const custRes = await request({
        method: "POST",
        path: "/api/customers",
        headers: { Authorization: `Bearer ${oldUserToken}` },
        body: {
          name: "Old Corp Customer",
          phone: "9900011122",
          email: "billing@oldcorp.test",
          address: "Old Corp Tower, Suite 400",
        },
      });
      if (custRes.status !== 201 && custRes.status !== 200) {
        throw new Error(`Failed to create customer: HTTP ${custRes.status}: ${JSON.stringify(custRes.data)}`);
      }
      oldCustomerId = custRes.data?.customer?.id || custRes.data?.id;

      // 3. Invoices
      await pool.query(
        `INSERT INTO invoices (created_by, customer_id, invoice_number, total_amount, subtotal, document_status, invoice_date, due_date)
         VALUES (?, ?, ?, 25000.00, 25000.00, 'issued', CURDATE(), CURDATE())`,
        [oldUserId, oldCustomerId, `INV-OLD-${ts}`]
      );

      // 4. Khata entries (credit and debit)
      await pool.query(
        `INSERT INTO khata_entries (customer_id, type, amount, description, entry_date, created_by)
         VALUES (?, 'credit', 25000.00, 'Historical shipment delivery', NOW(), ?),
                (?, 'debit', 5000.00, 'Advance settlement', NOW(), ?)`,
        [oldCustomerId, oldUserId, oldCustomerId, oldUserId]
      );

      // 5. Payment
      await pool.query(
        `INSERT INTO payments (created_by, customer_id, amount, payment_mode, payment_category, purpose, payment_date)
         VALUES (?, ?, 20000.00, 'online', 'due_received', 'Old Account Cleared Dues', CURDATE())`,
        [oldUserId, oldCustomerId]
      );

      // 6. Vehicle trip
      await pool.query(
        `INSERT INTO vehicle_trips (created_by, vehicle_number, driver_name, from_location, to_location, goods_description, status)
         VALUES (?, 'WB-OLD-9999', 'Suresh Driver', 'Warehouse Old', 'Hub Old', 'Historical machinery', 'completed')`,
        [oldUserId]
      );

      // 7. Support ticket
      await pool.query(
        `INSERT INTO support_tickets (ticket_number, user_id, department, category, subject, description, status)
         VALUES (?, ?, 'billing', 'Invoicing', 'Old Ticket Issue', 'Historical query for old account', 'resolved')`,
        [`TKT-OLD-${ts}`, oldUserId]
      );
    });

    await test("A.4 Verify in DB that all created records have foreign key user_id = OLD_USER_ID", async () => {
      const [invs] = await pool.query("SELECT id FROM invoices WHERE created_by = ?", [oldUserId]);
      const [khatas] = await pool.query("SELECT id FROM khata_entries WHERE created_by = ?", [oldUserId]);
      const [pays] = await pool.query("SELECT id FROM payments WHERE created_by = ?", [oldUserId]);
      const [trips] = await pool.query("SELECT id FROM vehicle_trips WHERE created_by = ?", [oldUserId]);
      const [tickets] = await pool.query("SELECT id FROM support_tickets WHERE user_id = ?", [oldUserId]);

      if (invs.length < 1 || khatas.length < 2 || pays.length < 1 || trips.length < 1 || tickets.length < 1) {
        throw new Error(`Record count mismatch in DB: invs=${invs.length}, khatas=${khatas.length}, pays=${pays.length}, trips=${trips.length}, tickets=${tickets.length}`);
      }
    });

    // =========================================================================
    // TEST B: SOFT DELETION
    // =========================================================================
    console.log("\n--- TEST B: Soft Deletion Lifecycle ---");

    await test("B.1 Superadmin soft-deletes OLD_USER_ID with audit reason", async () => {
      const res = await request({
        method: "DELETE",
        path: `/api/superadmin/users/${oldUserId}`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: "User requested account retirement for email reuse testing" },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.user?.is_deleted) {
        throw new Error("Response did not report is_deleted = true");
      }
    });

    await test("B.2 Verify deletion metadata and generated active_email = NULL in DB", async () => {
      const [rows] = await pool.query("SELECT id, email, active_email, status, deleted_at, deleted_by, deletion_reason FROM users WHERE id = ?", [oldUserId]);
      const u = rows[0];
      if (u.status !== "deleted" || !u.deleted_at || u.deleted_by !== superadminUser.id) {
        throw new Error(`Deletion metadata mismatch: ${JSON.stringify(u)}`);
      }
      if (u.active_email !== null) {
        throw new Error(`Expected active_email to be NULL for deleted user, got: ${u.active_email}`);
      }
    });

    await test("B.3 Verify user is removed from Active tab and appears in Deleted tab", async () => {
      const activeRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const inActive = (activeRes.data?.users || []).some((u) => u.id === oldUserId);
      if (inActive) throw new Error("OLD_USER_ID erroneously found in Active Users tab");

      const delRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=deleted",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const inDel = (delRes.data?.users || []).find((u) => u.id === oldUserId);
      if (!inDel) throw new Error("OLD_USER_ID missing from Deleted Users tab");
      if (!inDel.is_deleted || inDel.status !== "deleted") {
        throw new Error(`Deleted user missing deleted indicators: ${JSON.stringify(inDel)}`);
      }
    });

    await test("B.4 Verify old user cannot log in (HTTP 403)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: { email: testEmail, password: passwordOld },
      });

      if (res.status !== 403) {
        throw new Error(`Expected HTTP 403 on login with deleted account, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("B.5 Verify existing token for OLD_USER_ID is rejected (HTTP 403)", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${oldUserToken}` },
      });

      if (res.status !== 403) {
        throw new Error(`Expected HTTP 403 on protected route with old token, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("B.6 Verify all historical records remain safely intact in DB with OLD_USER_ID", async () => {
      const [invs] = await pool.query("SELECT id FROM invoices WHERE created_by = ?", [oldUserId]);
      const [khatas] = await pool.query("SELECT id FROM khata_entries WHERE created_by = ?", [oldUserId]);
      const [pays] = await pool.query("SELECT id FROM payments WHERE created_by = ?", [oldUserId]);
      if (invs.length < 1 || khatas.length < 2 || pays.length < 1) {
        throw new Error("Historical records were erroneously purged upon soft deletion");
      }
    });

    await test("B.7 Verify Superadmin can inspect deleted account and its historical records", async () => {
      const res = await request({
        method: "GET",
        path: `/api/superadmin/users/${oldUserId}/overview`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      const u = res.data.user;
      const ov = res.data.overview;
      if (!u.is_deleted || u.status !== "deleted") {
        throw new Error("User record did not indicate deleted status");
      }
      if (Number(ov.customer_count || 0) < 1) {
        throw new Error(`Historical counts not visible to Superadmin: ${JSON.stringify(ov)}`);
      }
    });

    // =========================================================================
    // TEST C: RE-REGISTRATION WITH SAME EMAIL
    // =========================================================================
    console.log("\n--- TEST C: Re-registration with Same Email ---");

    await test("C.1 Register a new user with the EXACT SAME email address", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Fresh Second Owner",
          email: testEmail,
          password: passwordNew,
          phone: "9876599999",
          business_name: "Fresh Business Innovations",
          address: "202 New Horizon Boulevard",
        },
      });

      if (res.status !== 201) {
        throw new Error(`Expected HTTP 201 on re-registration, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.token || !res.data.user?.id) {
        throw new Error("Missing token or user in re-registration response");
      }

      newUserId = res.data.user.id;
      newUserToken = res.data.token;
      console.log(`     Recorded NEW_USER_ID: ${newUserId}`);
    });

    await test("C.2 Assert strictly that NEW_USER_ID !== OLD_USER_ID", async () => {
      if (newUserId === oldUserId) {
        throw new Error(`Re-registration failed isolation: NEW_USER_ID (${newUserId}) === OLD_USER_ID (${oldUserId})`);
      }
      if (typeof newUserId !== "number" || newUserId <= 0) {
        throw new Error(`Invalid NEW_USER_ID format: ${newUserId}`);
      }
    });

    await test("C.3 Verify new user can authenticate and receives valid token for NEW_USER_ID", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200: ${JSON.stringify(res.data)}`);
      }
      if (res.data.user.id !== newUserId || res.data.user.status !== "active") {
        throw new Error(`Authenticated user mismatch: ${JSON.stringify(res.data.user)}`);
      }
    });

    await test("C.4 Verify new user appears in Active Users and old user still appears in Deleted Users", async () => {
      // 1. Check Active Users
      const activeRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=active",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const activeList = activeRes.data?.users || [];
      const hasNewInActive = activeList.some((u) => u.id === newUserId);
      const hasOldInActive = activeList.some((u) => u.id === oldUserId);
      if (!hasNewInActive) throw new Error("NEW_USER_ID missing from Active Users tab");
      if (hasOldInActive) throw new Error("OLD_USER_ID erroneously present in Active Users tab");

      // 2. Check Deleted Users
      const delRes = await request({
        method: "GET",
        path: "/api/superadmin/users?tab=deleted",
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      const delList = delRes.data?.users || [];
      const hasOldInDel = delList.some((u) => u.id === oldUserId);
      const hasNewInDel = delList.some((u) => u.id === newUserId);
      if (!hasOldInDel) throw new Error("OLD_USER_ID missing from Deleted Users tab");
      if (hasNewInDel) throw new Error("NEW_USER_ID erroneously present in Deleted Users tab");
    });

    await test("C.5 Verify both user records coexist in DB under the exact same email address", async () => {
      const [rows] = await pool.query(
        "SELECT id, email, active_email, status, deleted_at FROM users WHERE email = ? ORDER BY id ASC",
        [testEmail]
      );

      if (rows.length !== 2) {
        throw new Error(`Expected exactly 2 records for email, found ${rows.length}`);
      }
      const [first, second] = rows;
      if (first.id !== oldUserId || first.status !== "deleted" || first.active_email !== null) {
        throw new Error(`First user record mismatch: ${JSON.stringify(first)}`);
      }
      if (second.id !== newUserId || second.status !== "active" || second.active_email !== testEmail) {
        throw new Error(`Second user record mismatch: ${JSON.stringify(second)}`);
      }
    });

    // =========================================================================
    // TEST D: STRICT DATA ISOLATION VERIFICATION
    // =========================================================================
    console.log("\n--- TEST D: Strict Data Isolation Verification ---");

    await test("D.1 As NEW_USER_ID, verify all multi-module queries return 0 records (empty list)", async () => {
      // 1. Customers
      const custRes = await request({
        method: "GET",
        path: "/api/customers",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      const custs = custRes.data?.customers || [];
      if (custs.length !== 0) throw new Error(`Customers not isolated: got ${custs.length} items`);

      // 2. Invoices / Documents
      const invRes = await request({
        method: "GET",
        path: "/api/documents?type=invoice",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      const invs = invRes.data?.documents || [];
      if (invs.length !== 0) throw new Error(`Invoices not isolated: got ${invs.length} items`);

      // 3. Khata entries
      const khataRes = await request({
        method: "GET",
        path: "/api/khata",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      const entries = khataRes.data?.entries || [];
      if (entries.length !== 0) throw new Error(`Khata entries not isolated: got ${entries.length} items`);

      // 4. Payments
      const payRes = await request({
        method: "GET",
        path: "/api/payments",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      const pays = payRes.data?.payments || [];
      if (pays.length !== 0) throw new Error(`Payments not isolated: got ${pays.length} items`);

      // 5. Vehicles
      const vehicleRes = await request({
        method: "GET",
        path: "/api/vehicles/trips",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      const trips = vehicleRes.data?.trips || [];
      if (trips.length !== 0) throw new Error(`Vehicles not isolated: got ${trips.length} items`);

      // 6. Profile
      const meRes = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${newUserToken}` },
      });
      if (meRes.data.user.business_name !== "Fresh Business Innovations" || meRes.data.user.address !== "202 New Horizon Boulevard") {
        throw new Error(`Profile inherited old business info: ${JSON.stringify(meRes.data.user)}`);
      }
    });

    await test("D.2 As Superadmin, verify OLD_USER_ID has historical data while NEW_USER_ID is clean", async () => {
      // 1. Old User overview
      const oldRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${oldUserId}/overview`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      if (Number(oldRes.data.overview?.customer_count || 0) < 1) {
        throw new Error(`Old user historical data lost: ${JSON.stringify(oldRes.data.overview)}`);
      }

      // 2. New User overview
      const newRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${newUserId}/overview`,
        headers: { Authorization: `Bearer ${superadminToken}` },
      });
      if (Number(newRes.data.overview?.customer_count || 0) !== 0) {
        throw new Error(`New user has non-zero records: ${JSON.stringify(newRes.data.overview)}`);
      }
    });

    await test("D.3 As Employee, confirm OLD_USER_ID shows historical data and NEW_USER_ID shows empty data", async () => {
      const oldEmpRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${oldUserId}/overview`,
        headers: { Authorization: `Bearer ${employeeToken}` },
      });
      if (Number(oldEmpRes.data.overview?.customer_count || 0) < 1) {
        throw new Error("Employee cannot see old user historical records");
      }

      const newEmpRes = await request({
        method: "GET",
        path: `/api/superadmin/users/${newUserId}/overview`,
        headers: { Authorization: `Bearer ${employeeToken}` },
      });
      if (Number(newEmpRes.data.overview?.customer_count || 0) !== 0) {
        throw new Error("Employee sees contaminated records for new user");
      }
    });

    // =========================================================================
    // TEST E: AUTHENTICATION & UNIQUENESS EDGE CASES
    // =========================================================================
    console.log("\n--- TEST E: Authentication & Uniqueness Edge Cases ---");

    await test("E.1 Third registration with same email while NEW_USER_ID is active must be rejected (409)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Third Illegal Registrant",
          email: testEmail,
          password: "ThirdPassword789!",
        },
      });

      if (res.status !== 409) {
        throw new Error(`Expected HTTP 409 Conflict, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("E.2 Login with shared email: NEW password succeeds (NEW_USER_ID), OLD password fails (401)", async () => {
      // 1. Authenticate with NEW password
      const newLoginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: { email: testEmail, password: passwordNew },
      });
      if (newLoginRes.status !== 200 || newLoginRes.data?.user?.id !== newUserId) {
        throw new Error(`Login with new password did not yield NEW_USER_ID: HTTP ${newLoginRes.status}: ${JSON.stringify(newLoginRes.data)}`);
      }

      // 2. Authenticate with OLD password
      const oldLoginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: { email: testEmail, password: passwordOld },
      });
      if (oldLoginRes.status !== 401) {
        throw new Error(`Expected HTTP 401 on login with old password, got ${oldLoginRes.status}: ${JSON.stringify(oldLoginRes.data)}`);
      }
    });

    await test("E.3 Attempting to restore OLD_USER_ID while NEW_USER_ID is active must be rejected (409)", async () => {
      const res = await request({
        method: "POST",
        path: `/api/superadmin/users/${oldUserId}/restore`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: "Attempting illegal restoration without freeing email" },
      });

      if (res.status !== 409) {
        throw new Error(`Expected HTTP 409 Conflict on restore collision, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.message || !res.data.message.includes("Cannot restore account")) {
        throw new Error(`Conflict message did not explain active conflict: ${res.data.message}`);
      }

      // Verify OLD_USER_ID remains deleted and NEW_USER_ID remains active
      const [oldCheck] = await pool.query("SELECT status, deleted_at FROM users WHERE id = ?", [oldUserId]);
      const [newCheck] = await pool.query("SELECT status, deleted_at FROM users WHERE id = ?", [newUserId]);
      if (oldCheck[0].status !== "deleted" || !oldCheck[0].deleted_at) {
        throw new Error("OLD_USER_ID state was corrupted despite 409 conflict");
      }
      if (newCheck[0].status !== "active" || newCheck[0].deleted_at !== null) {
        throw new Error("NEW_USER_ID state was corrupted during restore attempt");
      }
    });

    await test("E.4 Soft-delete NEW_USER_ID, then restore OLD_USER_ID: succeeds cleanly", async () => {
      // 1. Soft-delete NEW_USER_ID
      const delNewRes = await request({
        method: "DELETE",
        path: `/api/superadmin/users/${newUserId}`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: "Soft deleting second user to permit restoring first user" },
      });
      if (delNewRes.status !== 200 || !delNewRes.data?.success) {
        throw new Error(`Failed to soft-delete NEW_USER_ID: HTTP ${delNewRes.status}`);
      }

      // 2. Now both are soft-deleted; restore OLD_USER_ID
      const restoreRes = await request({
        method: "POST",
        path: `/api/superadmin/users/${oldUserId}/restore`,
        headers: { Authorization: `Bearer ${superadminToken}` },
        body: { reason: "Restoring first user now that active slot is available" },
      });
      if (restoreRes.status !== 200 || !restoreRes.data?.success) {
        throw new Error(`Expected HTTP 200 on restore, got ${restoreRes.status}: ${JSON.stringify(restoreRes.data)}`);
      }

      // 3. Verify in DB: OLD_USER_ID is active, NEW_USER_ID is deleted
      const [oldDb] = await pool.query("SELECT id, status, deleted_at, active_email FROM users WHERE id = ?", [oldUserId]);
      const [newDb] = await pool.query("SELECT id, status, deleted_at, active_email FROM users WHERE id = ?", [newUserId]);

      if (oldDb[0].status !== "active" || oldDb[0].deleted_at !== null || oldDb[0].active_email !== testEmail) {
        throw new Error(`OLD_USER_ID DB state unexpected: ${JSON.stringify(oldDb[0])}`);
      }
      if (newDb[0].status !== "deleted" || newDb[0].deleted_at === null || newDb[0].active_email !== null) {
        throw new Error(`NEW_USER_ID DB state unexpected: ${JSON.stringify(newDb[0])}`);
      }

      // 4. Login with email now authenticates OLD_USER_ID using OLD password!
      const oldReLoginRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: { email: testEmail, password: passwordOld },
      });
      if (oldReLoginRes.status !== 200 || oldReLoginRes.data?.user?.id !== oldUserId) {
        throw new Error(`Login after restoration did not return OLD_USER_ID: HTTP ${oldReLoginRes.status}: ${JSON.stringify(oldReLoginRes.data)}`);
      }

      // 5. Verify all historical records from Test A are still intact and accessible under OLD_USER_ID
      const [historicalInvs] = await pool.query("SELECT id FROM invoices WHERE created_by = ?", [oldUserId]);
      if (historicalInvs.length < 1) {
        throw new Error("Historical invoices lost after account restoration");
      }
    });

  } catch (err) {
    console.error("💥 Unhandled Test Suite Exception:", err);
  } finally {
    // Clean up test fixtures safely
    try {
      if (superadminUser) {
        await pool.query("DELETE FROM user_audit_logs WHERE superadmin_id = ?", [superadminUser.id]);
        await pool.query("DELETE FROM users WHERE id = ?", [superadminUser.id]);
      }
      if (employeeUser) {
        await pool.query("DELETE FROM users WHERE id = ?", [employeeUser.id]);
      }
      if (oldUserId) {
        await pool.query("DELETE FROM support_tickets WHERE user_id = ?", [oldUserId]);
        await pool.query("DELETE FROM vehicle_trips WHERE created_by = ?", [oldUserId]);
        await pool.query("DELETE FROM payments WHERE created_by = ?", [oldUserId]);
        await pool.query("DELETE FROM khata_entries WHERE created_by = ?", [oldUserId]);
        await pool.query("DELETE FROM invoices WHERE created_by = ?", [oldUserId]);
        if (oldCustomerId) {
          await pool.query("DELETE FROM customers WHERE id = ?", [oldCustomerId]);
        }
        await pool.query("DELETE FROM subscription_invoices WHERE user_id = ?", [oldUserId]);
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [oldUserId]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [oldUserId]);
        await pool.query("DELETE FROM users WHERE id = ?", [oldUserId]);
      }
      if (newUserId) {
        await pool.query("DELETE FROM subscription_invoices WHERE user_id = ?", [newUserId]);
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [newUserId]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [newUserId]);
        await pool.query("DELETE FROM users WHERE id = ?", [newUserId]);
      }
      console.log("\n🧹 Test fixtures cleaned up successfully.");
    } catch (cleanupErr) {
      console.warn("⚠️ Cleanup warning:", cleanupErr.message);
    }

    console.log("\n================================================================================");
    console.log("📊 TEST EXECUTION SUMMARY");
    console.log("================================================================================");
    const passedCount = results.filter((r) => r.passed).length;
    const totalCount = results.length;
    console.log(`Passed: ${passedCount}/${totalCount} (${Math.round((passedCount / totalCount) * 100)}%)\n`);

    results.forEach((r, idx) => {
      console.log(`  ${idx + 1}. [${r.passed ? "PASS" : "FAIL"}] ${r.name}`);
    });

    if (passedCount !== totalCount) {
      process.exit(1);
    }
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

