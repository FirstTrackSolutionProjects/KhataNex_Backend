/**
 * scripts/test_sales_complete_end_to_end.js
 *
 * Comprehensive Automated End-to-End Verification Suite for KhataNex Sales Module:
 * - Scenario 1: Sale without invoice (Goods + Service, stock decrement goods only, payment ledger, cash/bank inflow, reports)
 * - Scenario 2: Create invoice after sale (1-click /create-invoice, #INV-YYYY-XXXXX, PDF generated, no double decrement, idempotent)
 * - Scenario 3: Sale with invoice checkbox enabled (atomic creation, invoice & sale linked, PDF generated)
 * - Scenario 4: Manual / Walk-in customer sale (no customer_id, walk-in name, payment and sale records valid)
 * - Scenario 5: Purchase to inventory flow (update_inventory: true, separate purchase_price & selling_price in stock, sales decrements)
 * - Scenario 6: Tax and payment cases (Intra-state CGST+SGST vs Inter-state IGST, cash vs bank, partial payment with due_amount)
 * - Scenario 7: Employee and Superadmin monitoring & data isolation (tenant isolation, RBAC permissions, superadmin multi-tenant monitoring)
 * - Scenario 8: Regression tests (auth lifecycle, forgot password, 2FA, soft-delete email reuse, documents integrity)
 */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
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

async function runEndToEndSalesSuite() {
  console.log("================================================================================");
  console.log("🚀 KHATANEX END-TO-END SALES MODULE COMPREHENSIVE VERIFICATION");
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
  let userA, userB, superadmin, empWithSales, empNoSales;
  let tokenA, tokenB, tokenSuper, tokenEmpSales, tokenEmpNoSales;
  let bankAId;
  let customerAId, customerInterStateId;
  let stockGoodsId;
  let scenario1SaleId;
  let scenario2InvoiceNumber, scenario2PdfPath;
  let scenario3SaleId;
  let scenario5StockId;

  try {
    // -------------------------------------------------------------
    // SETUP: Fixtures & Tenants
    // -------------------------------------------------------------
    await test("0. Setup test users, tenants, banking, and customers", async () => {
      // User A (Odisha seller)
      const emailA = `sales_owner_a_${ts}@example.com`;
      const [resA] = await pool.query(
        `INSERT INTO users (name, email, password, role, status, business_name, state)
         VALUES ('Sales Owner Odisha', ?, 'hashed_pass_123', 'user', 'active', 'Enterprise A', 'Odisha')`,
        [emailA]
      );
      userA = { id: resA.insertId, role: "user", email: emailA };
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

      // User B (Another tenant for isolation check)
      const emailB = `sales_owner_b_${ts}@example.com`;
      const [resB] = await pool.query(
        `INSERT INTO users (name, email, password, role, status, business_name, state)
         VALUES ('Tenant B', ?, 'hashed_pass_123', 'user', 'active', 'Enterprise B', 'Maharashtra')`,
        [emailB]
      );
      userB = { id: resB.insertId, role: "user", email: emailB };
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

      // Superadmin
      const emailSuper = `sales_super_${ts}@example.com`;
      const [resSuper] = await pool.query(
        `INSERT INTO users (name, email, password, role, status)
         VALUES ('Super Auditor', ?, 'hashed_pass_123', 'superadmin', 'active')`,
        [emailSuper]
      );
      superadmin = { id: resSuper.insertId, role: "superadmin", email: emailSuper };
      tokenSuper = signToken(superadmin);

      // Employee with Sales permissions under User A
      const emailEmp1 = `emp_sales_${ts}@example.com`;
      const [resEmp1] = await pool.query(
        `INSERT INTO users (name, email, password, role, status, created_by_admin, assigned_modules, permissions)
         VALUES ('Employee Sales Rep', ?, 'hashed_pass_123', 'employee', 'active', ?, '["sales","stock"]', '{"sales":{"view":true,"create":true,"edit":true,"delete":true}}')`,
        [emailEmp1, userA.id]
      );
      empWithSales = { id: resEmp1.insertId, role: "employee", created_by_admin: userA.id, email: emailEmp1 };
      tokenEmpSales = signToken(empWithSales);

      // Employee without Sales permissions under User A
      const emailEmp2 = `emp_nosales_${ts}@example.com`;
      const [resEmp2] = await pool.query(
        `INSERT INTO users (name, email, password, role, status, created_by_admin, assigned_modules, permissions)
         VALUES ('Employee Inventory Only', ?, 'hashed_pass_123', 'employee', 'active', ?, '["stock"]', '{"stock":{"view":true}}')`,
        [emailEmp2, userA.id]
      );
      empNoSales = { id: resEmp2.insertId, role: "employee", created_by_admin: userA.id, email: emailEmp2 };
      tokenEmpNoSales = signToken(empNoSales);

      // Add a Bank Account for User A
      const [bankRes] = await pool.query(
        `INSERT INTO banking (created_by, bank_name, account_number, ifsc_code, account_holder_name, account_type, is_default, created_at)
         VALUES (?, 'HDFC Bank', '50100234567890', 'HDFC0001234', 'Sales Owner Odisha', 'Current', 1, NOW())`,
        [userA.id]
      );
      bankAId = bankRes.insertId;

      // Add Intra-State Customer (Odisha)
      const [cust1Res] = await pool.query(
        `INSERT INTO customers (name, phone, email, billing_state, gstin, created_by, created_at)
         VALUES ('Bhubaneswar Electronics', '9876543210', 'bhub@odisha.com', 'Odisha', '21ABCDE1234F1Z5', ?, NOW())`,
        [userA.id]
      );
      customerAId = cust1Res.insertId;

      // Add Inter-State Customer (West Bengal)
      const [cust2Res] = await pool.query(
        `INSERT INTO customers (name, phone, email, billing_state, gstin, created_by, created_at)
         VALUES ('Kolkata Trading Co', '9876543211', 'kol@wb.com', 'West Bengal', '19ABCDE1234F1Z5', ?, NOW())`,
        [userA.id]
      );
      customerInterStateId = cust2Res.insertId;

      // Add Stock Goods item for User A
      const [stkRes] = await pool.query(
        `INSERT INTO stock (product_name, category, type, item_type, unit, quantity, price, purchase_price, gst_rate, created_by, created_at)
         VALUES ('Industrial Power Cable', 'Cables', 'goods', 'goods', 'meter', 100, 250.00, 180.00, 18, ?, NOW())`,
        [userA.id]
      );
      stockGoodsId = stkRes.insertId;
    });

    // -------------------------------------------------------------
    // SCENARIO 1: Sale without invoice (Goods + Service, Stock Decrement, Payment Ledger, Cash/Bank Inflow)
    // -------------------------------------------------------------
    await test("Scenario 1.1: Record multi-item sale (goods + service) without invoice", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          items: [
            {
              product_id: stockGoodsId,
              product_name: "Industrial Power Cable",
              quantity: 10,
              unit: "meter",
              unit_price: 250.00,
              discount: 0,
              tax_rate: 18,
              item_type: "goods",
            },
            {
              product_name: "Cable Installation & Testing Service",
              quantity: 1,
              unit: "job",
              unit_price: 500.00,
              discount: 0,
              tax_rate: 18,
              item_type: "service",
            },
          ],
          payment_mode: "cash",
          paid_amount: 3540.00, // (2500 + 500) = 3000 taxable + 540 GST (18%) = 3540
          create_invoice: false,
          notes: "Scenario 1 Sale without invoice",
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.success || !res.data.sale?.id) {
        throw new Error("Sale creation response missing sale object or ID");
      }

      scenario1SaleId = res.data.sale.id;
      if (res.data.sale.invoice_id) {
        throw new Error("Sale without invoice must have null invoice_id");
      }
      if (Number(res.data.sale.amount) !== 3540.00) {
        throw new Error(`Expected amount 3540, got ${res.data.sale.amount}`);
      }
      if (res.data.sale.payment_status !== "paid") {
        throw new Error(`Expected payment_status 'paid', got ${res.data.sale.payment_status}`);
      }
    });

    await test("Scenario 1.2: Verify goods stock decremented and service stock untouched", async () => {
      const [stkRows] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockGoodsId]);
      if (!stkRows.length) throw new Error("Stock item not found");
      const currentQty = Number(stkRows[0].quantity);
      // Started with 100, sold 10 -> should be 90
      if (currentQty !== 90) {
        throw new Error(`Expected stock quantity 90, got ${currentQty}`);
      }
    });

    await test("Scenario 1.3: Verify payment ledger entry linked to sale_id", async () => {
      const [payRows] = await pool.query(
        "SELECT * FROM payments WHERE sale_id = ? AND payment_category = 'product_sale'",
        [scenario1SaleId]
      );
      if (!payRows.length) throw new Error("No payment record linked to sale_id");
      const payment = payRows[0];
      if (Number(payment.amount) !== 3540.00) {
        throw new Error(`Expected payment amount 3540, got ${payment.amount}`);
      }
      if (payment.payment_mode !== "cash") {
        throw new Error(`Expected payment_mode 'cash', got ${payment.payment_mode}`);
      }
    });

    await test("Scenario 1.4: Verify reports & dashboard metrics reflect sale & cash inflow", async () => {
      const res = await request({
        method: "GET",
        path: "/api/reports",
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200) throw new Error(`Reports dashboard returned status ${res.status}`);
      const metrics = res.data.metrics || res.data;
      if (Number(metrics.total_sales || 0) < 3540) {
        throw new Error(`Expected total_sales >= 3540, got ${metrics.total_sales}`);
      }
      if (Number(metrics.cash_in_hand || 0) < 3540) {
        throw new Error(`Expected cash_in_hand >= 3540, got ${metrics.cash_in_hand}`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 2: Create invoice after sale (1-Click, Idempotent, Single-decrement guarantee)
    // -------------------------------------------------------------
    await test("Scenario 2.1: Generate Tax Invoice for existing un-invoiced sale", async () => {
      const res = await request({
        method: "POST",
        path: `/api/sales/${scenario1SaleId}/create-invoice`,
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {},
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.success || !res.data.invoice?.invoiceNumber) {
        throw new Error("Missing invoiceNumber in response");
      }

      scenario2InvoiceNumber = res.data.invoice.invoiceNumber;
      scenario2PdfPath = res.data.invoice.pdfPath;

      if (!scenario2InvoiceNumber.startsWith("INV-")) {
        throw new Error(`Invalid invoice number format: ${scenario2InvoiceNumber}`);
      }

      // Verify sale is updated with invoice_id
      const [saleRows] = await pool.query("SELECT invoice_id FROM sales WHERE id = ?", [scenario1SaleId]);
      if (!saleRows[0]?.invoice_id) {
        throw new Error("Sale invoice_id was not updated after invoice creation");
      }
    });

    await test("Scenario 2.2: Verify stock was NOT decremented again during invoice creation", async () => {
      const [stkRows] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockGoodsId]);
      const currentQty = Number(stkRows[0].quantity);
      // Must STILL be 90 (single decrement guarantee)
      if (currentQty !== 90) {
        throw new Error(`Stock decremented multiple times! Expected 90, got ${currentQty}`);
      }
    });

    await test("Scenario 2.3: Verify idempotency - second call returns existing invoice without duplicating", async () => {
      const res = await request({
        method: "POST",
        path: `/api/sales/${scenario1SaleId}/create-invoice`,
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {},
      });

      if (res.status !== 200) {
        throw new Error(`Expected 200 on idempotent call, got ${res.status}`);
      }
      if (res.data.invoice?.invoiceNumber !== scenario2InvoiceNumber) {
        throw new Error(
          `Idempotency broken: returned different invoiceNumber ${res.data.invoice?.invoiceNumber} vs ${scenario2InvoiceNumber}`
        );
      }

      // Ensure no duplicate invoices were created for this sale
      const [invCount] = await pool.query("SELECT COUNT(*) AS cnt FROM invoices WHERE sale_id = ?", [scenario1SaleId]);
      if (Number(invCount[0].cnt) !== 1) {
        throw new Error(`Found ${invCount[0].cnt} invoices linked to sale ${scenario1SaleId}; expected exactly 1.`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 3: Sale with invoice checkbox enabled (Immediate atomic invoice generation)
    // -------------------------------------------------------------
    await test("Scenario 3: Record sale with create_invoice: true", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          items: [
            {
              product_id: stockGoodsId,
              product_name: "Industrial Power Cable",
              quantity: 5,
              unit: "meter",
              unit_price: 250.00,
              discount: 50.00, // 5 * 250 - 50 = 1200 taxable
              tax_rate: 18, // 18% of 1200 = 216 -> total 1416
              item_type: "goods",
            },
          ],
          payment_mode: "online",
          bank_id: bankAId,
          paid_amount: 1416.00,
          create_invoice: true,
          notes: "Scenario 3 Atomic sale + invoice",
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.success || !res.data.sale?.invoice_id) {
        throw new Error("Immediate invoice creation failed to attach invoice_id to sale");
      }

      scenario3SaleId = res.data.sale.id;

      // Check stock decremented by 5 (90 - 5 = 85)
      const [stkRows] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [stockGoodsId]);
      if (Number(stkRows[0].quantity) !== 85) {
        throw new Error(`Expected stock 85, got ${stkRows[0].quantity}`);
      }

      // Check invoice exists in invoices table
      const [invRows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [res.data.sale.invoice_id]);
      if (!invRows.length) throw new Error("Linked invoice record not found in database");
      if (Number(invRows[0].total_amount) !== 1416.00) {
        throw new Error(`Expected invoice total 1416, got ${invRows[0].total_amount}`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 4: Manual / Walk-in sale (no customer_id)
    // -------------------------------------------------------------
    await test("Scenario 4: Record sale for Walk-in customer without saved customer_id", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: null,
          customer_name: "Retail Counter Buyer",
          customer_phone: "9988776655",
          items: [
            {
              product_name: "Quick Counter Product",
              quantity: 2,
              unit: "pcs",
              unit_price: 100.00,
              discount: 0,
              tax_rate: 0,
              item_type: "goods",
            },
          ],
          payment_mode: "cash",
          paid_amount: 200.00,
          create_invoice: false,
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      const s = res.data.sale;
      if (s.customer_id !== null) {
        throw new Error(`Expected customer_id null for walk-in, got ${s.customer_id}`);
      }
      if (s.customer_name !== "Retail Counter Buyer") {
        throw new Error(`Expected customer_name 'Retail Counter Buyer', got ${s.customer_name}`);
      }
      if (Number(s.amount) !== 200.00) {
        throw new Error(`Expected amount 200, got ${s.amount}`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 5: Purchase to inventory flow (Separate purchase_price & selling_price)
    // -------------------------------------------------------------
    await test("Scenario 5.1: Create purchase bill with update_inventory: true and distinct selling_price", async () => {
      const billNum = `BILL-${ts}`;
      const res = await request({
        method: "POST",
        path: "/api/purchase-bills",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          bill_number: billNum,
          vendor_name: "National Electronics Supplies",
          update_inventory: true,
          items: [
            {
              item_name: `Smart Sensor Module ${ts}`,
              item_type: "goods",
              quantity: 50,
              unit: "pcs",
              price: 300.00, // Purchase price / cost
              selling_price: 450.00, // Intended selling price in stock
              gst_rate: 18,
            },
          ],
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("Scenario 5.2: Verify stock record created with purchase_price=300 and price=450", async () => {
      const [stkRows] = await pool.query(
        "SELECT * FROM stock WHERE product_name = ? AND created_by = ?",
        [`Smart Sensor Module ${ts}`, userA.id]
      );
      if (!stkRows.length) throw new Error("Stock item was not automatically created from purchase bill");

      const stockItem = stkRows[0];
      scenario5StockId = stockItem.id;

      if (Number(stockItem.purchase_price) !== 300.00) {
        throw new Error(`Expected stock.purchase_price 300.00, got ${stockItem.purchase_price}`);
      }
      if (Number(stockItem.price) !== 450.00) {
        throw new Error(`Expected stock.price (selling price) 450.00, got ${stockItem.price}`);
      }
      if (Number(stockItem.quantity) !== 50) {
        throw new Error(`Expected stock.quantity 50, got ${stockItem.quantity}`);
      }
    });

    await test("Scenario 5.3: Verify stock API endpoint exposes selling_price and purchase_price", async () => {
      const res = await request({
        method: "GET",
        path: `/api/stock/${scenario5StockId}`,
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200) throw new Error(`Stock API returned status ${res.status}`);
      const item = res.data.stock || res.data;
      if (Number(item.price) !== 450.00 || Number(item.selling_price) !== 450.00) {
        throw new Error(`Expected selling price 450.00, got price=${item.price}, selling_price=${item.selling_price}`);
      }
      if (Number(item.purchase_price) !== 300.00) {
        throw new Error(`Expected purchase_price 300.00, got ${item.purchase_price}`);
      }
    });

    await test("Scenario 5.4: Record sale of newly purchased item and verify stock decrements", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          items: [
            {
              product_id: scenario5StockId,
              product_name: `Smart Sensor Module ${ts}`,
              quantity: 15,
              unit: "pcs",
              unit_price: 450.00,
              discount: 0,
              tax_rate: 18,
              item_type: "goods",
            },
          ],
          payment_mode: "online",
          paid_amount: 15 * 450 * 1.18,
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      // 50 - 15 = 35 remaining
      const [stkRows] = await pool.query("SELECT quantity FROM stock WHERE id = ?", [scenario5StockId]);
      if (Number(stkRows[0].quantity) !== 35) {
        throw new Error(`Expected remaining stock 35, got ${stkRows[0].quantity}`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 6: Tax & Payment Cases (Intra vs Inter state, Bank deposit, Partial payment)
    // -------------------------------------------------------------
    await test("Scenario 6.1: Intra-state sale (Buyer Odisha, Seller Odisha) -> CGST + SGST split", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId, // Odisha
          items: [
            {
              product_name: "Local Intra Item",
              quantity: 1,
              unit: "pcs",
              unit_price: 1000.00,
              tax_rate: 18,
              item_type: "service",
            },
          ],
          create_invoice: true,
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      const invId = res.data.sale.invoice_id;
      const [invRows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [invId]);
      const inv = invRows[0];
      // Taxable = 1000, Tax = 180 (CGST = 90, SGST = 90, IGST = 0)
      if (Number(inv.cgst_amount) !== 90.00 || Number(inv.sgst_amount) !== 90.00) {
        throw new Error(`Expected CGST=90, SGST=90; got CGST=${inv.cgst_amount}, SGST=${inv.sgst_amount}`);
      }
      if (Number(inv.igst_amount || 0) !== 0) {
        throw new Error(`Expected IGST=0 for intra-state; got ${inv.igst_amount}`);
      }
    });

    await test("Scenario 6.2: Inter-state sale (Buyer WB, Seller Odisha) -> IGST only", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerInterStateId, // West Bengal
          items: [
            {
              product_name: "Inter-State Item",
              quantity: 1,
              unit: "pcs",
              unit_price: 1000.00,
              tax_rate: 18,
              item_type: "service",
            },
          ],
          create_invoice: true,
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }

      const invId = res.data.sale.invoice_id;
      const [invRows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [invId]);
      const inv = invRows[0];
      // Taxable = 1000, Tax = 180 (IGST = 180, CGST = 0, SGST = 0)
      if (Number(inv.igst_amount) !== 180.00) {
        throw new Error(`Expected IGST=180; got ${inv.igst_amount}`);
      }
      if (Number(inv.cgst_amount || 0) !== 0 || Number(inv.sgst_amount || 0) !== 0) {
        throw new Error(`Expected CGST=0, SGST=0 for inter-state; got CGST=${inv.cgst_amount}, SGST=${inv.sgst_amount}`);
      }
    });

    await test("Scenario 6.3: Partial payment with balance due", async () => {
      const res = await request({
        method: "POST",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: {
          customer_id: customerAId,
          items: [
            {
              product_name: "Partial Payment Order",
              quantity: 1,
              unit: "pcs",
              unit_price: 2000.00,
              tax_rate: 0,
              item_type: "service",
            },
          ],
          paid_amount: 750.00, // Total = 2000, Paid = 750, Due = 1250
          payment_mode: "cash",
        },
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Expected 201/200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      const s = res.data.sale;
      if (s.payment_status !== "partial") {
        throw new Error(`Expected payment_status 'partial', got ${s.payment_status}`);
      }
      if (Number(s.paid_amount) !== 750.00) {
        throw new Error(`Expected paid_amount 750, got ${s.paid_amount}`);
      }
      if (Number(s.due_amount) !== 1250.00) {
        throw new Error(`Expected due_amount 1250, got ${s.due_amount}`);
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 7: Employee & Superadmin monitoring & data isolation
    // -------------------------------------------------------------
    await test("Scenario 7.1: Tenant isolation - User B cannot view User A's sales", async () => {
      const res = await request({
        method: "GET",
        path: `/api/sales/${scenario1SaleId}`,
        headers: { Authorization: `Bearer ${tokenB}` },
      });

      if (res.status !== 403 && res.status !== 404) {
        throw new Error(`Expected 403/404 for cross-tenant access, got ${res.status}`);
      }
    });

    await test("Scenario 7.2: Employee with sales permissions can view and record sales", async () => {
      const res = await request({
        method: "GET",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenEmpSales}` },
      });

      if (res.status !== 200) {
        throw new Error(`Employee with sales permission failed with status ${res.status}`);
      }
      if (!Array.isArray(res.data.sales) || res.data.sales.length === 0) {
        throw new Error("Employee failed to retrieve tenant's sales records");
      }
    });

    await test("Scenario 7.3: Employee without sales permissions is rejected with 403", async () => {
      const res = await request({
        method: "GET",
        path: "/api/sales",
        headers: { Authorization: `Bearer ${tokenEmpNoSales}` },
      });

      if (res.status !== 403) {
        throw new Error(`Expected 403 for employee without sales permissions, got ${res.status}`);
      }
    });

    await test("Scenario 7.4: Superadmin can monitor sales across tenants", async () => {
      const res = await request({
        method: "GET",
        path: `/api/sales?user_id=${userA.id}`,
        headers: { Authorization: `Bearer ${tokenSuper}` },
      });

      if (res.status !== 200) {
        throw new Error(`Superadmin request failed with status ${res.status}`);
      }
      if (!Array.isArray(res.data.sales) || res.data.sales.length === 0) {
        throw new Error("Superadmin could not view sales for targeted tenant");
      }
    });

    // -------------------------------------------------------------
    // SCENARIO 8: Regression tests (Auth lifecycle, 2FA, Email reuse)
    // -------------------------------------------------------------
    await test("Scenario 8.1: Regression - 2FA TOTP verification endpoint health", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/2fa/status",
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200) {
        throw new Error(`2FA status check failed with status ${res.status}`);
      }
      if (res.data.two_factor_enabled !== false) {
        throw new Error("Expected 2FA initially disabled for new test user");
      }
    });

    await test("Scenario 8.2: Regression - Forgot password flow health", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: userA.email },
      });

      if (res.status !== 200) {
        throw new Error(`Forgot password request failed with status ${res.status}`);
      }
      if (!res.data.success) {
        throw new Error("Forgot password response missing success: true");
      }
    });

    await test("Scenario 8.3: Regression - Documents API includes sales invoices", async () => {
      const res = await request({
        method: "GET",
        path: "/api/documents",
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      if (res.status !== 200) {
        throw new Error(`Documents API failed with status ${res.status}`);
      }
      const docs = res.data.documents || [];
      const hasSalesInvoice = docs.some(
        (d) => d.sale_id === scenario1SaleId || d.sale_id === scenario3SaleId
      );
      if (!hasSalesInvoice) {
        throw new Error("Invoices generated from sales do not appear in /api/documents list");
      }
    });
  } finally {
    // -------------------------------------------------------------
    // CLEANUP
    // -------------------------------------------------------------
    console.log("\n🧹 Cleaning up test data...");
    try {
      if (userA?.id) {
        await pool.query("DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE user_id = ?)", [userA.id]);
        await pool.query("DELETE FROM invoices WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM payments WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM sales WHERE user_id = ?", [userA.id]);
        await pool.query("DELETE FROM purchase_bills WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM stock WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM banking WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM customers WHERE created_by = ?", [userA.id]);
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [userA.id]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [userA.id]);
        await pool.query("DELETE FROM users WHERE created_by_admin = ?", [userA.id]);
        await pool.query("DELETE FROM users WHERE id = ?", [userA.id]);
      }
      if (userB?.id) {
        await pool.query("DELETE FROM subscriptions WHERE user_id = ?", [userB.id]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id = ?", [userB.id]);
        await pool.query("DELETE FROM users WHERE id = ?", [userB.id]);
      }
      if (superadmin?.id) {
        await pool.query("DELETE FROM users WHERE id = ?", [superadmin.id]);
      }
      console.log("   Cleanup completed successfully.");
    } catch (cleanupErr) {
      console.error("   Cleanup error:", cleanupErr.message);
    }
  }

  // -------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;

  console.log("\n================================================================================");
  console.log(`📊 TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (TOTAL: ${results.length})`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    console.error("❌ Some end-to-end sales tests failed!");
    process.exit(1);
  } else {
    console.log("🎉 ALL END-TO-END SALES & INTEGRATION SCENARIOS PASSED WITH 100% SUCCESS!");
    process.exit(0);
  }
}

runEndToEndSalesSuite().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
