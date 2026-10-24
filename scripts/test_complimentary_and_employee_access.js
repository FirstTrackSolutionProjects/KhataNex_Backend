/**
 * test_complimentary_and_employee_access.js
 * End-to-end verification of Complimentary Subscriptions and Employee Access
 */
const http = require("http");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const PORT = process.env.PORT || 5001;

function makeRequest({ method = "GET", path, headers = {}, body = null }) {
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

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET || "default_jwt_secret_for_development_purposes_only",
    { expiresIn: "1h" }
  );
}

async function run() {
  console.log("===============================================================");
  console.log("TEST SUITE: COMPLIMENTARY SUBSCRIPTIONS & EMPLOYEE ENTITLEMENT");
  console.log("===============================================================");

  const results = [];
  const runTest = async (name, fn) => {
    try {
      await fn();
      results.push({ name, status: "PASS", error: null });
      console.log(`  ✅ PASS: ${name}`);
    } catch (err) {
      results.push({ name, status: "FAIL", error: err.message });
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Reason: ${err.message}`);
    }
  };

  const ts = Date.now();
  let superadminUser, regularOwner1, regularOwner2, employeeActive, employeeExpired, orphanEmployee;

  try {
    // 1. Setup test fixtures
    const [saRows] = await pool.query(
      `INSERT INTO users (name, email, password, role, status)
       VALUES (?, ?, 'hash', 'superadmin', 'active')`,
      [`Super Admin ${ts}`, `sa_${ts}@khatanex.test`]
    );
    superadminUser = { id: saRows.insertId, name: `Super Admin ${ts}`, email: `sa_${ts}@khatanex.test`, role: "superadmin" };

    const [ro1Rows] = await pool.query(
      `INSERT INTO users (name, email, password, role, business_name, status)
       VALUES (?, ?, 'hash', 'user', 'Owner 1 Biz', 'active')`,
      [`Owner 1 ${ts}`, `owner1_${ts}@khatanex.test`]
    );
    regularOwner1 = { id: ro1Rows.insertId, name: `Owner 1 ${ts}`, email: `owner1_${ts}@khatanex.test`, role: "user" };

    const [ro2Rows] = await pool.query(
      `INSERT INTO users (name, email, password, role, business_name, status)
       VALUES (?, ?, 'hash', 'user', 'Owner 2 Biz', 'active')`,
      [`Owner 2 ${ts}`, `owner2_${ts}@khatanex.test`]
    );
    regularOwner2 = { id: ro2Rows.insertId, name: `Owner 2 ${ts}`, email: `owner2_${ts}@khatanex.test`, role: "user" };

    // Employee 1 linked to Owner 1 (Owner 1 will receive complimentary subscription)
    const [emp1Rows] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, permissions, created_by_admin, status)
       VALUES (?, ?, 'hash', 'employee', 'staff', ?, ?, ?, 'active')`,
      [
        `Emp Active ${ts}`,
        `emp1_${ts}@khatanex.test`,
        JSON.stringify(["customers", "invoices"]),
        JSON.stringify(["customers:view", "customers:create", "invoices:view", "invoices:create"]),
        regularOwner1.id,
      ]
    );
    employeeActive = { id: emp1Rows.insertId, name: `Emp Active ${ts}`, email: `emp1_${ts}@khatanex.test`, role: "employee", created_by_admin: regularOwner1.id };

    // Employee 2 linked to Owner 2 (Owner 2 has NO active subscription)
    const [emp2Rows] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, permissions, created_by_admin, status)
       VALUES (?, ?, 'hash', 'employee', 'staff', ?, ?, ?, 'active')`,
      [
        `Emp Expired ${ts}`,
        `emp2_${ts}@khatanex.test`,
        JSON.stringify(["customers", "invoices"]),
        JSON.stringify(["customers:view", "customers:create"]),
        regularOwner2.id,
      ]
    );
    employeeExpired = { id: emp2Rows.insertId, name: `Emp Expired ${ts}`, email: `emp2_${ts}@khatanex.test`, role: "employee", created_by_admin: regularOwner2.id };

    const saToken = createToken(superadminUser);
    const owner1Token = createToken(regularOwner1);
    const owner2Token = createToken(regularOwner2);
    const empActiveToken = createToken(employeeActive);
    const empExpiredToken = createToken(employeeExpired);

    console.log("\n--- TEST GROUP 1: SUPERADMIN COMPLIMENTARY SUBSCRIPTION GRANT ---");

    await runTest("Superadmin can grant a complimentary subscription to regular user with custom duration", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${saToken}` },
        body: {
          user_id: regularOwner1.id,
          plan_code: "six_months",
          duration_months: 6,
          notes: "Beta tester appreciation grant",
        },
      });

      if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      if (!res.data.success) throw new Error("Expected success: true");
      if (!res.data.subscription) throw new Error("Expected subscription object");
      if (res.data.subscription.is_complimentary !== 1) throw new Error("Expected is_complimentary = 1");

      // Verify in database
      const [subs] = await pool.query("SELECT * FROM subscriptions WHERE user_id = ?", [regularOwner1.id]);
      if (!subs.length) throw new Error("No subscription found in DB for user");
      if (subs[0].is_complimentary !== 1) throw new Error("DB subscription is_complimentary is not 1");

      // Verify manual order exists with total_paise = 0
      const [orders] = await pool.query("SELECT * FROM subscription_orders WHERE id = ?", [subs[0].order_id]);
      if (!orders.length) throw new Error("No order found for subscription");
      if (orders[0].provider !== "manual") throw new Error(`Expected provider = manual, got ${orders[0].provider}`);
      if (orders[0].total_paise !== 0) throw new Error(`Expected total_paise = 0, got ${orders[0].total_paise}`);
      if (orders[0].status !== "paid") throw new Error(`Expected status = paid, got ${orders[0].status}`);

      // Verify no paid invoice was generated
      const [invoices] = await pool.query("SELECT * FROM subscription_invoices WHERE order_id = ?", [orders[0].id]);
      if (invoices.length > 0) throw new Error("Invoice should not be generated for complimentary grant");

      // Verify admin audit log
      const [audits] = await pool.query(
        "SELECT * FROM admin_audit_logs WHERE action = 'GRANT_COMPLIMENTARY_SUBSCRIPTION' AND target_id = ?",
        [String(subs[0].id)]
      );
      if (!audits.length) throw new Error("No admin audit log found for grant");
      const details = typeof audits[0].details === "string" ? JSON.parse(audits[0].details || "{}") : (audits[0].details || {});
      if (details.plan_code !== "six_months") throw new Error("Audit details plan_code mismatch");
      if (details.duration_months !== 6) throw new Error("Audit details duration_months mismatch");
    });

    await runTest("Duplicate/concurrent complimentary grant within 5 seconds is blocked (409 Conflict)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${saToken}` },
        body: {
          user_id: regularOwner1.id,
          plan_code: "monthly",
          duration_months: 1,
        },
      });

      if (res.status !== 409) {
        throw new Error(`Expected 409 Conflict for duplicate grant, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    console.log("\n--- TEST GROUP 2: ACCESS CONTROL & TARGET VALIDATION ---");

    await runTest("Regular user cannot invoke grant endpoint (403 Forbidden)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${owner1Token}` },
        body: {
          user_id: regularOwner2.id,
          plan_code: "monthly",
        },
      });

      if (res.status !== 403) {
        throw new Error(`Expected 403 Forbidden, got ${res.status}`);
      }
    });

    await runTest("Employee cannot invoke grant endpoint (403 Forbidden)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${empActiveToken}` },
        body: {
          user_id: regularOwner2.id,
          plan_code: "monthly",
        },
      });

      if (res.status !== 403) {
        throw new Error(`Expected 403 Forbidden, got ${res.status}`);
      }
    });

    await runTest("Superadmin cannot grant subscription to another superadmin (400 Bad Request)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${saToken}` },
        body: {
          user_id: superadminUser.id,
          plan_code: "monthly",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected 400 Bad Request, got ${res.status}`);
      }
    });

    await runTest("Superadmin cannot grant subscription directly to an employee (400 Bad Request)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/superadmin/billing/grant",
        headers: { Authorization: `Bearer ${saToken}` },
        body: {
          user_id: employeeActive.id,
          plan_code: "monthly",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected 400 Bad Request, got ${res.status}`);
      }
    });

    console.log("\n--- TEST GROUP 3: EMPLOYEE SUBSCRIPTION ENTITLEMENT & INHERITANCE ---");

    await runTest("Employee inherits active subscription from business owner in GET /api/subscriptions/me", async () => {
      const res = await makeRequest({
        method: "GET",
        path: "/api/subscriptions/me",
        headers: { Authorization: `Bearer ${empActiveToken}` },
      });

      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!res.data.success) throw new Error("Expected success: true");
      if (!res.data.isEmployee) throw new Error("Expected isEmployee: true");
      if (!res.data.activeSubscription) throw new Error("Expected activeSubscription inherited from owner");
      if (res.data.remainingDays <= 0) throw new Error("Expected positive remainingDays");
      if (!res.data.owner || res.data.owner.id !== regularOwner1.id) {
        throw new Error("Expected owner metadata matching Owner 1");
      }
    });

    await runTest("Employee cannot create a subscription order (400 Bad Request)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/subscriptions/orders",
        headers: { Authorization: `Bearer ${empActiveToken}` },
        body: { plan_code: "monthly" },
      });

      if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await runTest("Employee of active owner can perform write actions in permitted module (customers)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/customers",
        headers: { Authorization: `Bearer ${empActiveToken}` },
        body: {
          name: `Cust By Emp ${ts}`,
          phone: `91987${String(ts).slice(-6)}`,
          payment_type: "credit",
        },
      });

      if (res.status !== 201) {
        throw new Error(`Expected 201 Created, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await runTest("Employee of active owner cannot access unpermitted module (vehicles)", async () => {
      const res = await makeRequest({
        method: "POST",
        path: "/api/vehicles",
        headers: { Authorization: `Bearer ${empActiveToken}` },
        body: { vehicle_number: "WB01AB1234" },
      });

      if (res.status !== 403) {
        throw new Error(`Expected 403 Forbidden for unassigned module, got ${res.status}`);
      }
    });

    await runTest("Employee of unsubscribed/expired owner has activeSubscription = null and is blocked on write", async () => {
      const meRes = await makeRequest({
        method: "GET",
        path: "/api/subscriptions/me",
        headers: { Authorization: `Bearer ${empExpiredToken}` },
      });

      if (meRes.status !== 200) throw new Error(`Expected 200, got ${meRes.status}`);
      if (meRes.data.activeSubscription !== null) throw new Error("Expected activeSubscription: null for unsubscribed owner");

      // Mutating operation with subscription enforcement active
      // Temporarily ensure subscription enforcement is ON for this test
      await pool.query("UPDATE subscription_settings SET subscription_enforcement = 'on' WHERE id = 1");
      const { invalidateSettingsCache } = require("../utils/subscriptionLogic");
      invalidateSettingsCache();

      const custRes = await makeRequest({
        method: "POST",
        path: "/api/customers",
        headers: { Authorization: `Bearer ${empExpiredToken}` },
        body: {
          name: `Cust Blocked ${ts}`,
          phone: `91988${String(ts).slice(-6)}`,
        },
      });

      if (custRes.status !== 403) {
        throw new Error(`Expected 403 Forbidden, got ${custRes.status}: ${JSON.stringify(custRes.data)}`);
      }
      if (custRes.data.code !== "SUBSCRIPTION_REQUIRED") {
        throw new Error(`Expected code SUBSCRIPTION_REQUIRED, got ${custRes.data.code}`);
      }
      if (!custRes.data.isEmployee) {
        throw new Error("Expected isEmployee: true in response");
      }
    });

    console.log("\n--- TEST GROUP 4: SUPERADMIN USER OVERVIEW & GRANT HISTORY ENDPOINTS ---");

    await runTest("GET /api/superadmin/users/:id/overview returns subscription with is_complimentary and grant_history", async () => {
      const res = await makeRequest({
        method: "GET",
        path: `/api/superadmin/users/${regularOwner1.id}/overview`,
        headers: { Authorization: `Bearer ${saToken}` },
      });

      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!res.data.user) throw new Error("Expected user in overview");
      if (!res.data.user.subscription) throw new Error("Expected subscription in user overview");
      if (res.data.user.subscription.is_complimentary !== true) throw new Error("Expected is_complimentary: true");
      if (!Array.isArray(res.data.user.grant_history)) throw new Error("Expected grant_history array");
      if (res.data.user.grant_history.length === 0) throw new Error("Expected at least 1 grant history entry");
      const first = res.data.user.grant_history[0];
      if (!first.granted_by_name) throw new Error("Expected granted_by_name in grant history");
    });

    await runTest("GET /api/superadmin/billing/users/:id returns grantHistory", async () => {
      const res = await makeRequest({
        method: "GET",
        path: `/api/superadmin/billing/users/${regularOwner1.id}`,
        headers: { Authorization: `Bearer ${saToken}` },
      });

      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      if (!Array.isArray(res.data.grantHistory)) throw new Error("Expected grantHistory array");
      if (res.data.grantHistory.length === 0) throw new Error("Expected grantHistory to contain entries");
    });

  } finally {
    // Cleanup
    try {
      if (regularOwner1) {
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [regularOwner1.id]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [regularOwner1.id]);
        await pool.query("DELETE FROM customers WHERE created_by = ?", [regularOwner1.id]);
      }
      if (superadminUser) await pool.query("DELETE FROM users WHERE id = ?", [superadminUser.id]);
      if (regularOwner1) await pool.query("DELETE FROM users WHERE id = ?", [regularOwner1.id]);
      if (regularOwner2) await pool.query("DELETE FROM users WHERE id = ?", [regularOwner2.id]);
      if (employeeActive) await pool.query("DELETE FROM users WHERE id = ?", [employeeActive.id]);
      if (employeeExpired) await pool.query("DELETE FROM users WHERE id = ?", [employeeExpired.id]);
    } catch (_) {}
  }

  console.log("\n===============================================================");
  console.log(`SUMMARY: ${results.filter((r) => r.status === "PASS").length} PASSED, ${results.filter((r) => r.status === "FAIL").length} FAILED`);
  console.log("===============================================================");

  if (results.some((r) => r.status === "FAIL")) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
