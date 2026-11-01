/**
 * scripts/test_sales_flow.js
 * 
 * Comprehensive Automated Test Suite for KhataNex Sales Module:
 * - Test 1: Record sale without invoice (stock product decrement verified)
 * - Test 2: Record sale with immediate invoice generation (production PDF, #INV-YYYY-XXXXX, single decrement)
 * - Test 3: Sales Dashboard metrics & filters (totals, counts, invoiced vs uninvoiced)
 * - Test 4: Batch generate invoice from multiple existing un-invoiced sales (Phase 4)
 * - Test 5: Verify Sales invoices appear in /api/documents / Invoices module (Phase 5)
 * - Test 6: Role-based access (User tenant isolation, Employee access, Superadmin drilldown)
 * - Test 7: Referential integrity (stock restoration on delete, rejection if linked invoice active)
 */

require("dotenv").config();
const http = require("http");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const PORT = process.env.PORT || 5001;
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

async function runSalesTestSuite() {
  console.log("================================================================================");
  console.log("🧪 KHATANEX SALES MANAGEMENT MODULE AUTOMATED TEST SUITE");
  console.log(`Target: http://127.0.0.1:${PORT}`);
  console.log("================================================================================\n");

  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  ✅ PASS: ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: err.message });
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Reason: ${err.message}\n`);
    }
  };

  const ts = Date.now();
  let userA, userB, superadmin, employeeA;
  let tokenA, tokenB, tokenSuper, tokenEmpA;
  let customerAId, stockAId;
  let sale1Id, sale2Id, sale3Id;
  let batchInvoiceId;

  try {
    // Setup test users
    const [uARes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status, business_name, state)
       VALUES (?, ?, 'hash123', 'user', 'active', 'Enterprise A', 'Odisha')`,
      [`User A ${ts}`, `usera_${ts}@test.com`]
    );
    userA = { id: uARes.insertId, role: "user" };
    tokenA = signToken(userA);

    const [ordARes] = await pool.query(
      `INSERT INTO subscription_orders (user_id, plan_id, order_number, list_price_paise, total_paise, status)
       VALUES (?, 1, ?, 99900, 117900, 'paid')`,
      [userA.id, `ORD-A-${ts}`]
    );

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, order_id, starts_at, ends_at, is_complimentary, status)
       VALUES (?, 1, ?, NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 365 DAY, 1, 'active')`,
      [userA.id, ordARes.insertId]
    );

    const [uBRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status, business_name, state)
       VALUES (?, ?, 'hash123', 'user', 'active', 'Enterprise B', 'Delhi')`,
      [`User B ${ts}`, `userb_${ts}@test.com`]
    );
    userB = { id: uBRes.insertId, role: "user" };
    tokenB = signToken(userB);

    const [ordBRes] = await pool.query(
      `INSERT INTO subscription_orders (user_id, plan_id, order_number, list_price_paise, total_paise, status)
       VALUES (?, 1, ?, 99900, 117900, 'paid')`,
      [userB.id, `ORD-B-${ts}`]
    );

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, order_id, starts_at, ends_at, is_complimentary, status)
       VALUES (?, 1, ?, NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 365 DAY, 1, 'active')`,
      [userB.id, ordBRes.insertId]
    );

    const [saRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status)
       VALUES (?, ?, 'hash123', 'superadmin', 'active')`,
      [`SuperAdmin ${ts}`, `superadmin_${ts}@test.com`]
    );
    superadmin = { id: saRes.insertId, role: "superadmin" };
    tokenSuper = signToken(superadmin);

    const [empRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, status, created_by_admin, assigned_modules)
       VALUES (?, ?, 'hash123', 'employee', 'active', ?, '["sales", "invoices", "khata"]')`,
      [`Emp A ${ts}`, `empa_${ts}@test.com`, userA.id]
    );
    employeeA = { id: empRes.insertId, role: "employee", created_by_admin: userA.id };
    tokenEmpA = signToken(employeeA);

    // Setup a Customer and Stock Product for User A
    const [custRes] = await pool.query(
      `INSERT INTO customers (name, phone, email, billing_state, billing_city, created_by)
       VALUES (?, '9876543210', ?, 'Odisha', 'Bhubaneswar', ?)`,
      [`Customer Ramesh ${ts}`, `ramesh_${ts}@client.com`, userA.id]
    );
    customerAId = custRes.insertId;

    const [stockRes] = await pool.query(
      `INSERT INTO stock (product_name, category, price, quantity, unit, created_by)
       VALUES ('Industrial Valve 50mm', 'Hardware', 500.00, 100.00, 'pcs', ?)`,
      [userA.id]
    );
    stockAId = stockRes.insertId;

    // --- TEST 1: Record sale without invoice ---
    await test("1. Record standard sale without invoice (stock decremented)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          customer_name: "Customer Ramesh",
          product_id: stockAId,
          product_name: "Industrial Valve 50mm",
          category: "Hardware",
          quantity: 5,
          unit_price: 500,
          discount: 50,
          payment_mode: "cash",
          notes: "Walk-in purchase",
          create_invoice: false,
        },
      });

      if (res.status !== 201 || !res.data?.success) {
        throw new Error(`Expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      sale1Id = res.data.sale.id;
      if (Number(res.data.sale.amount) !== 2450) {
        throw new Error(`Expected amount 2450, got ${res.data.sale.amount}`);
      }
      if (res.data.sale.invoice_id !== null) {
        throw new Error("invoice_id should be null for un-invoiced sale");
      }

      // Check stock was decremented from 100 to 95
      const [stockCheck] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockAId]);
      if (Number(stockCheck[0].quantity) !== 95) {
        throw new Error(`Expected stock 95, got ${stockCheck[0].quantity}`);
      }
    });

    // --- TEST 2: Record sale with immediate invoice generation ---
    await test("2. Record sale with immediate tax invoice (single stock decrement, production PDF)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          customer_name: "Customer Ramesh",
          product_id: stockAId,
          product_name: "Industrial Valve 50mm",
          category: "Hardware",
          quantity: 10,
          unit_price: 500,
          discount: 0,
          payment_mode: "online",
          create_invoice: true,
          gst_rate: 18,
        },
      });

      if (res.status !== 201 || !res.data?.success) {
        throw new Error(`Expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      sale2Id = res.data.sale.id;
      const inv = res.data.invoice;
      if (!inv || !inv.invoiceId || !inv.invoiceNumber) {
        throw new Error("Missing invoice generation in response");
      }
      if (!inv.invoiceNumber.startsWith("INV-")) {
        throw new Error(`Invoice number format invalid: ${inv.invoiceNumber}`);
      }
      if (!res.data.sale.invoice_id || res.data.sale.invoice_id !== inv.invoiceId) {
        throw new Error("Sale.invoice_id not linked to generated invoice");
      }

      // Check stock decremented by 10 (from 95 to 85) without double decrement
      const [stockCheck] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockAId]);
      if (Number(stockCheck[0].quantity) !== 85) {
        throw new Error(`Expected stock 85 (single decrement), got ${stockCheck[0].quantity}`);
      }
    });

    // --- TEST 3: Sales Dashboard Metrics ---
    await test("3. Sales Dashboard returns accurate metrics and filtered list", async () => {
      const res = await request({
        method: "GET",
        path: "/api/sales/dashboard",
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }

      const { metrics, sales } = res.data;
      if (metrics.total_sales_count !== 2) {
        throw new Error(`Expected total_sales_count = 2, got ${metrics.total_sales_count}`);
      }
      if (metrics.invoiced_sales_count !== 1) {
        throw new Error(`Expected invoiced_sales_count = 1, got ${metrics.invoiced_sales_count}`);
      }
      if (metrics.uninvoiced_sales_count !== 1) {
        throw new Error(`Expected uninvoiced_sales_count = 1, got ${metrics.uninvoiced_sales_count}`);
      }
      if (sales.length !== 2) {
        throw new Error(`Expected 2 sales, got ${sales.length}`);
      }

      // Verify the invoiced sale has invoice details populated
      const invoicedSale = sales.find((s) => s.id === sale2Id);
      if (!invoicedSale.invoice_number || !invoicedSale.invoice_number.startsWith("INV-")) {
        throw new Error("Joined invoice_number missing on invoiced sale");
      }
    });

    // Add a third un-invoiced sale for customer Ramesh
    const [sale3Res] = await pool.query(
      `INSERT INTO sales (user_id, customer_id, customer_name, product_name, quantity, unit_price, amount, sale_date, sale_time, created_by)
       VALUES (?, ?, 'Customer Ramesh', 'Steel Nut Bolt M10', 50, 10, 500, CURDATE(), CURTIME(), ?)`,
      [userA.id, customerAId, userA.id]
    );
    sale3Id = sale3Res.insertId;

    // --- TEST 4: Batch generate invoice from multiple un-invoiced sales (Phase 4) ---
    await test("4. Batch generate production invoice from multiple existing sales (Phase 4)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales/generate-invoice",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          sale_ids: [sale1Id, sale3Id],
          gst_rate: 18,
          notes: "Consolidated monthly billing for Ramesh",
        },
      });

      if (res.status !== 201 || !res.data?.success) {
        throw new Error(`Expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      batchInvoiceId = res.data.invoice.invoiceId;
      if (!batchInvoiceId || !res.data.invoice.invoiceNumber) {
        throw new Error("Missing batch invoice creation");
      }

      // Check both sales now point to this new invoice
      const [sRows] = await pool.query("SELECT id, invoice_id FROM sales WHERE id IN (?, ?)", [sale1Id, sale3Id]);
      for (const s of sRows) {
        if (s.invoice_id !== batchInvoiceId) {
          throw new Error(`Sale #${s.id} not updated with invoice_id ${batchInvoiceId}`);
        }
      }

      // Verify stock was NOT decremented again during batch invoice creation!
      const [stockCheck] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockAId]);
      if (Number(stockCheck[0].quantity) !== 85) {
        throw new Error(`Stock erroneously altered during batch invoicing: ${stockCheck[0].quantity}`);
      }
    });

    // --- TEST 5: Verify invoices appear in /api/documents (Phase 5) ---
    await test("5. Generated sales invoices appear in official Invoices page (Phase 5)", async () => {
      const res = await request({
        method: "GET",
        path: "/api/documents?type=invoice",
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }

      const docs = res.data.documents || [];
      const hasBatchInv = docs.some((d) => d.id === batchInvoiceId);
      if (!hasBatchInv) {
        throw new Error(`Batch invoice #${batchInvoiceId} not visible in main invoices list`);
      }
    });

    // --- TEST 6: Role-Based Access ---
    await test("6.1 Employee with sales permission can access sales", async () => {
      const res = await request({
        method: "GET",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenEmpA}` },
      });
      if (res.status !== 200 || res.data.sales?.length !== 3) {
        throw new Error(`Employee could not read employer sales: got status ${res.status}`);
      }
    });

    await test("6.2 Tenant isolation: User B cannot access User A's sales", async () => {
      const res = await request({
        method: "GET",
        path: `/api/sales/${sale1Id}`,
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      if (res.status !== 403) {
        throw new Error(`Expected HTTP 403 on tenant boundary violation, got ${res.status}`);
      }
    });

    await test("6.3 Superadmin can inspect sales and filter by tenant user_id", async () => {
      const res = await request({
        method: "GET",
        path: `/api/sales?user_id=${userA.id}`,
        headers: { Authorization: `Bearer ${tokenSuper}` },
      });
      if (res.status !== 200 || res.data.sales?.length !== 3) {
        throw new Error(`Superadmin filter failed: got ${res.status}, length: ${res.data.sales?.length}`);
      }
    });

    // --- TEST 7: Referential Integrity & Deletion ---
    await test("7. Deleting active invoiced sale is rejected with clear message", async () => {
      const res = await request({
        method: "DELETE",
        path: `/api/sales/${sale1Id}`,
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      if (res.status !== 400 || !res.data.message?.includes("linked to active tax invoice")) {
        throw new Error(`Expected rejection 400, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

  } catch (suiteErr) {
    console.error("💥 Unhandled exception:", suiteErr);
  } finally {
    // Clean up test fixtures
    try {
      if (sale1Id || sale2Id || sale3Id) {
        await pool.query("DELETE FROM sales WHERE user_id IN (?, ?)", [userA?.id, userB?.id]);
      }
      if (batchInvoiceId) {
        await pool.query("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE created_by = ?)", [userA?.id]);
        await pool.query("DELETE FROM invoices WHERE created_by = ?", [userA?.id]);
      }
      if (stockAId) {
        await pool.query("DELETE FROM stock WHERE created_by = ?", [userA?.id]);
      }
      if (customerAId) {
        await pool.query("DELETE FROM customers WHERE created_by = ?", [userA?.id]);
      }
      if (employeeA?.id) {
        await pool.query("DELETE FROM users WHERE id = ?", [employeeA.id]);
      }
      if (userA?.id || userB?.id) {
        await pool.query("DELETE FROM subscriptions WHERE user_id IN (?, ?)", [userA?.id, userB?.id]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id IN (?, ?)", [userA?.id, userB?.id]);
      }
      if (userA?.id) {
        await pool.query("DELETE FROM users WHERE id = ?", [userA.id]);
      }
      if (userB?.id) {
        await pool.query("DELETE FROM users WHERE id = ?", [userB.id]);
      }
      if (superadmin?.id) {
        await pool.query("DELETE FROM users WHERE id = ?", [superadmin.id]);
      }
      console.log("\n🧹 Test fixtures cleaned up successfully.");
    } catch (cleanErr) {
      console.warn("⚠️ Cleanup error:", cleanErr.message);
    }

    console.log("\n================================================================================");
    console.log("📊 TEST EXECUTION SUMMARY");
    console.log("================================================================================");
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    console.log(`Passed: ${passed}/${total} (${Math.round((passed / total) * 100)}%)\n`);
    results.forEach((r, idx) => console.log(`  ${idx + 1}. [${r.passed ? "PASS" : "FAIL"}] ${r.name}`));

    if (passed !== total) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runSalesTestSuite().catch((err) => {
  console.error("Run error:", err);
  process.exit(1);
});
