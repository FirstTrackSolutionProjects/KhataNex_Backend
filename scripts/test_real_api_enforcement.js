/**
 * Integration Test: Real HTTP API Subscription Enforcement
 * Tests all 10 scenarios against running backend (http://localhost:5001)
 */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const BASE_URL = process.env.API_BASE_URL || "http://localhost:5001";
const JWT_SECRET = process.env.JWT_SECRET || "supersecretjwtkey_khatanex_dev_2024";

const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, employee_role_type: user.employee_role_type },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

async function runTests() {
  console.log("===============================================================");
  console.log("🚀 STARTING REAL HTTP API SUBSCRIPTION ENFORCEMENT TEST SUITE");
  console.log(`Target: ${BASE_URL}`);
  console.log("===============================================================\n");

  const createdUserIds = [];
  const createdCustomerIds = [];
  const createdKhataIds = [];
  const createdSubIds = [];
  const createdOrderIds = [];

  try {
    const timestamp = Date.now();

    // 1. Fixture: Unsubscribed User
    const [unsubRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [`Unsub User ${timestamp}`, `unsub_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const unsubUser = { id: unsubRes.insertId, role: "user" };
    createdUserIds.push(unsubUser.id);
    const unsubToken = signToken(unsubUser);

    // 2. Fixture: Expired Subscription User
    const [expRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [`Expired User ${timestamp}`, `exp_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const expUser = { id: expRes.insertId, role: "user" };
    createdUserIds.push(expUser.id);
    const expToken = signToken(expUser);

    // Order & expired subscription
    const [expOrderRes] = await pool.query(
      "INSERT INTO subscription_orders (order_number, user_id, plan_id, list_price_paise, total_paise, status, provider) VALUES (?, ?, 1, 24900, 24900, 'paid', 'manual')",
      [`ORD-EXP-${timestamp}`, expUser.id]
    );
    createdOrderIds.push(expOrderRes.insertId);

    const [expSubRes] = await pool.query(
      "INSERT INTO subscriptions (user_id, plan_id, order_id, starts_at, ends_at, status) VALUES (?, 1, ?, NOW() - INTERVAL 10 DAY, NOW() - INTERVAL 1 DAY, 'active')",
      [expUser.id, expOrderRes.insertId]
    );
    createdSubIds.push(expSubRes.insertId);

    // 3. Fixture: Subscribed User (Active)
    const [subRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [`Subscribed User ${timestamp}`, `sub_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const subUser = { id: subRes.insertId, role: "user" };
    createdUserIds.push(subUser.id);
    const subToken = signToken(subUser);

    // Order & active subscription
    const [subOrderRes] = await pool.query(
      "INSERT INTO subscription_orders (order_number, user_id, plan_id, list_price_paise, total_paise, status, provider) VALUES (?, ?, 1, 24900, 24900, 'paid', 'manual')",
      [`ORD-SUB-${timestamp}`, subUser.id]
    );
    createdOrderIds.push(subOrderRes.insertId);

    const [activeSubRes] = await pool.query(
      "INSERT INTO subscriptions (user_id, plan_id, order_id, starts_at, ends_at, status) VALUES (?, 1, ?, NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 30 DAY, 'active')",
      [subUser.id, subOrderRes.insertId]
    );
    createdSubIds.push(activeSubRes.insertId);

    // 4. Fixture: Employee of Subscribed Owner
    const [empSubRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status, created_by_admin, assigned_modules, permissions) VALUES (?, ?, ?, 'employee', 'active', ?, ?, ?)",
      [`Emp Sub Owner ${timestamp}`, `emp_sub_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456", subUser.id, JSON.stringify(["customers"]), JSON.stringify(["customers:create", "customers:view"])]
    );
    const empSubUser = { id: empSubRes.insertId, role: "employee" };
    createdUserIds.push(empSubUser.id);
    const empSubToken = signToken(empSubUser);

    // 5. Fixture: Employee of Unsubscribed Owner
    const [empUnsubRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status, created_by_admin, assigned_modules, permissions) VALUES (?, ?, ?, 'employee', 'active', ?, ?, ?)",
      [`Emp Unsub Owner ${timestamp}`, `emp_unsub_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456", unsubUser.id, JSON.stringify(["customers"]), JSON.stringify(["customers:create", "customers:view"])]
    );
    const empUnsubUser = { id: empUnsubRes.insertId, role: "employee" };
    createdUserIds.push(empUnsubUser.id);
    const empUnsubToken = signToken(empUnsubUser);

    // 6. Fixture: Superadmin
    const [saRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'superadmin', 'active')",
      [`SuperAdmin ${timestamp}`, `sa_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const saUser = { id: saRes.insertId, role: "superadmin" };
    createdUserIds.push(saUser.id);
    const saToken = signToken(saUser);

    console.log("✅ Test fixtures created in database.");

    // Helper counts
    const getCustomerCount = async (userId) => {
      const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?", [userId]);
      return count;
    };
    const getKhataCount = async (userId) => {
      const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM khata_entries WHERE created_by = ?", [userId]);
      return count;
    };

    const results = [];

    // TEST 1: Unsubscribed user GET /api/customers -> Expect 200 (read-only allowed)
    {
      const res = await fetch(`${BASE_URL}/api/customers`, {
        headers: { Authorization: `Bearer ${unsubToken}` },
      });
      const data = await res.json();
      const pass = res.status === 200;
      results.push({
        test: "1. Unsubscribed GET /api/customers (Read-only allowed)",
        status: res.status,
        expectedStatus: 200,
        code: data.code || "OK",
        pass,
      });
    }

    // TEST 2: Unsubscribed user POST /api/customers -> Expect 403 SUBSCRIPTION_REQUIRED, 0 records created
    {
      const countBefore = await getCustomerCount(unsubUser.id);
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${unsubToken}`,
        },
        body: JSON.stringify({ name: "Attempted Customer", phone: "9999999999" }),
      });
      const data = await res.json();
      const countAfter = await getCustomerCount(unsubUser.id);
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED" && countBefore === countAfter;
      results.push({
        test: "2. Unsubscribed POST /api/customers (Blocked & 0 records created)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        dbRecordAdded: countAfter - countBefore,
        pass,
      });
    }

    // TEST 3: Unsubscribed user POST /api/khata -> Expect 403 SUBSCRIPTION_REQUIRED, 0 records created
    {
      const countBefore = await getKhataCount(unsubUser.id);
      const res = await fetch(`${BASE_URL}/api/khata`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${unsubToken}`,
        },
        body: JSON.stringify({
          type: "debit",
          amount: 500,
          description: "Attempted Khata Entry",
          entry_date: "2026-10-14",
        }),
      });
      const data = await res.json();
      const countAfter = await getKhataCount(unsubUser.id);
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED" && countBefore === countAfter;
      results.push({
        test: "3. Unsubscribed POST /api/khata (Blocked & 0 records created)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        dbRecordAdded: countAfter - countBefore,
        pass,
      });
    }

    // TEST 4: Unsubscribed user POST /api/documents (invoice) -> Expect 403 SUBSCRIPTION_REQUIRED
    {
      const res = await fetch(`${BASE_URL}/api/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${unsubToken}`,
        },
        body: JSON.stringify({
          doc_type: "invoice",
          to_name: "Test Client",
          items: [{ item_name: "Item 1", qty: 1, rate: 100 }],
        }),
      });
      const data = await res.json();
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED";
      results.push({
        test: "4. Unsubscribed POST /api/documents (Blocked invoice creation)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        pass,
      });
    }

    // TEST 5: Unsubscribed user POST /api/payments -> Expect 403 SUBSCRIPTION_REQUIRED
    {
      const res = await fetch(`${BASE_URL}/api/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${unsubToken}`,
        },
        body: JSON.stringify({
          amount: 500,
          payment_method: "cash",
          payment_date: "2026-10-14",
        }),
      });
      const data = await res.json();
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED";
      results.push({
        test: "5. Unsubscribed POST /api/payments (Blocked payment creation)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        pass,
      });
    }

    // TEST 6: Expired subscription user mutating request -> Expect 403 SUBSCRIPTION_REQUIRED
    {
      const countBefore = await getCustomerCount(expUser.id);
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${expToken}`,
        },
        body: JSON.stringify({ name: "Expired Attempt Customer", phone: "9888888888" }),
      });
      const data = await res.json();
      const countAfter = await getCustomerCount(expUser.id);
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED" && countBefore === countAfter;
      results.push({
        test: "6. Expired subscription POST /api/customers (Blocked & 0 created)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        dbRecordAdded: countAfter - countBefore,
        pass,
      });
    }

    // TEST 7: Subscribed user mutating request -> Expect 201/200 (Success)
    {
      const countBefore = await getCustomerCount(subUser.id);
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${subToken}`,
        },
        body: JSON.stringify({ name: "Valid Subscribed Customer", phone: "9777777777" }),
      });
      const data = await res.json();
      const countAfter = await getCustomerCount(subUser.id);
      if (data?.customer?.id) createdCustomerIds.push(data.customer.id);
      const pass = (res.status === 201 || res.status === 200) && countAfter === countBefore + 1;
      results.push({
        test: "7. Subscribed user POST /api/customers (Allowed & record created)",
        status: res.status,
        expectedStatus: 201,
        code: data.code || "OK",
        dbRecordAdded: countAfter - countBefore,
        pass,
      });
    }

    // TEST 8: Employee of subscribed owner mutating request -> Expect 201/200 (Inherited Access)
    {
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${empSubToken}`,
        },
        body: JSON.stringify({ name: "Employee Added Customer", phone: "9666666666" }),
      });
      const data = await res.json();
      if (data?.customer?.id) createdCustomerIds.push(data.customer.id);
      const pass = res.status === 201 || res.status === 200;
      results.push({
        test: "8. Employee of subscribed owner POST /api/customers (Inherits access)",
        status: res.status,
        expectedStatus: 201,
        code: data.code || "OK",
        pass,
      });
    }

    // TEST 9: Employee of unsubscribed owner mutating request -> Expect 403 SUBSCRIPTION_REQUIRED
    {
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${empUnsubToken}`,
        },
        body: JSON.stringify({ name: "Blocked Emp Customer", phone: "9555555555" }),
      });
      const data = await res.json();
      const pass = res.status === 403 && data.code === "SUBSCRIPTION_REQUIRED";
      results.push({
        test: "9. Employee of unsubscribed owner POST /api/customers (Blocked)",
        status: res.status,
        expectedStatus: 403,
        code: data.code,
        pass,
      });
    }

    // TEST 10: Superadmin mutating request -> Expect 201/200 (Superadmin bypass)
    {
      const res = await fetch(`${BASE_URL}/api/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${saToken}`,
        },
        body: JSON.stringify({ name: "SuperAdmin Customer", phone: "9444444444" }),
      });
      const data = await res.json();
      if (data?.customer?.id) createdCustomerIds.push(data.customer.id);
      const pass = res.status === 201 || res.status === 200;
      results.push({
        test: "10. Superadmin POST /api/customers (Superadmin bypasses restriction)",
        status: res.status,
        expectedStatus: 201,
        code: data.code || "OK",
        pass,
      });
    }

    // Print Results Table
    console.log("\n======================== TEST RESULTS ========================");
    console.table(
      results.map((r) => ({
        "Test Case": r.test,
        "HTTP Status": r.status,
        Expected: r.expectedStatus,
        "Response Code": r.code || "-",
        Result: r.pass ? "✅ PASS" : "❌ FAIL",
      }))
    );

    const allPassed = results.every((r) => r.pass);
    if (!allPassed) {
      console.error("\n❌ ONE OR MORE TESTS FAILED!");
      process.exit(1);
    } else {
      console.log("\n🎉 ALL 10 TESTS PASSED PERFECTLY!");
    }
  } catch (error) {
    console.error("Test execution error:", error);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      if (createdCustomerIds.length > 0) {
        await pool.query(`DELETE FROM customers WHERE id IN (${createdCustomerIds.join(",")})`);
      }
      if (createdSubIds.length > 0) {
        await pool.query(`DELETE FROM subscriptions WHERE id IN (${createdSubIds.join(",")})`);
      }
      if (createdOrderIds.length > 0) {
        await pool.query(`DELETE FROM subscription_orders WHERE id IN (${createdOrderIds.join(",")})`);
      }
      if (createdUserIds.length > 0) {
        await pool.query(`DELETE FROM users WHERE id IN (${createdUserIds.join(",")})`);
      }
      console.log("🧹 Cleaned up temporary test fixtures.");
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }
    await pool.end();
  }
}

runTests();
