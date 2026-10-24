const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const pool = require("../config/db");
const { generateInvoicePdf, generateQuotationPdf } = require("../utils/generateDocumentPdf");

const API_BASE = "http://localhost:5001";
const JWT_SECRET = process.env.JWT_SECRET || "fallback_superadmin_secret_key_123!";

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log("========================================================================");
  console.log("🚀 VERIFYING NEW FIXES: SUPERADMIN USER PATCH, DRILLDOWNS, BILLING RBAC, PDFS");
  console.log("========================================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Get a Superadmin
    const [saRows] = await pool.query("SELECT id, name, email, role FROM users WHERE role = 'superadmin' LIMIT 1");
    const superadmin = saRows[0] || { id: 1, role: "superadmin", email: "admin@khatanex.com", name: "Super Admin" };
    const saToken = createToken({ id: superadmin.id, role: "superadmin", email: superadmin.email });

    // 2. Test Superadmin PATCH /api/superadmin/users/:id
    console.log("\n--- Testing PATCH /api/superadmin/users/:id ---");
    const [testUserRows] = await pool.query("SELECT id, name, email, phone, business_name FROM users WHERE role = 'user' LIMIT 1");
    if (testUserRows.length > 0) {
      const targetUser = testUserRows[0];
      const origName = targetUser.name;
      const testName = origName + " (Verified)";

      const patchRes = await request(`${API_BASE}/api/superadmin/users/${targetUser.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${saToken}`
        },
        body: JSON.stringify({
          name: testName,
          business_name: targetUser.business_name || "Test Enterprise",
          city: "Kolkata",
          state: "West Bengal"
        })
      });

      assert(patchRes.status === 200, "PATCH /api/superadmin/users/:id returns HTTP 200");
      assert(patchRes.data?.user?.name === testName, "User name updated in response");

      // Verify audit log
      const [auditRows] = await pool.query(
        "SELECT * FROM admin_audit_logs WHERE target_type = 'user' AND target_id = ? ORDER BY id DESC LIMIT 1",
        [String(targetUser.id)]
      );
      assert(auditRows.length > 0, "Audit log record written to admin_audit_logs");
      assert(auditRows[0].action === "UPDATE_USER_PROFILE", "Audit action is 'UPDATE_USER_PROFILE'");

      // Restore original name
      await request(`${API_BASE}/api/superadmin/users/${targetUser.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${saToken}`
        },
        body: JSON.stringify({ name: origName })
      });
      console.log(`   Restored user name to "${origName}"`);
    }

    // 3. Test Superadmin Drilldowns
    console.log("\n--- Testing Superadmin Dashboard Drilldowns ---");
    const drilldownTypes = [
      "active_subscribers",
      "complimentary",
      "revenue",
      "successful_payments",
      "failed_pending",
      "upcoming_expirations",
      "campaigns_coupons"
    ];

    for (const dtype of drilldownTypes) {
      const res = await request(
        `${API_BASE}/api/superadmin/dashboard/drilldown?type=${dtype}&period=this_month`,
        { headers: { Authorization: `Bearer ${saToken}` } }
      );
      assert(res.status === 200, `Drilldown '${dtype}' returns HTTP 200`);
      assert(Array.isArray(res.data?.rows), `Drilldown '${dtype}' returns rows array`);
      assert(typeof res.data?.pagination?.totalCount === "number", `Drilldown '${dtype}' pagination totalCount is number`);
    }

    // 4. Test Employee Billing RBAC & Granular Permissions
    console.log("\n--- Testing Employee Billing Granular Permissions ---");
    // Ensure a test employee exists in DB with billing permission
    const testEmpEmail = "billing.employee.test@khatanex.com";
    await pool.query("DELETE FROM users WHERE email = ?", [testEmpEmail]);
    const [empInsert] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, permissions, status, created_by_admin)
       VALUES (?, ?, ?, 'employee', 'support_executive', ?, ?, 'active', ?)`,
      [
        "Billing Test Emp",
        testEmpEmail,
        "$2b$10$dummyhashedpasswordfortesting1234567890",
        JSON.stringify(["billing"]),
        JSON.stringify({ billing: ["view"] }),
        superadmin.id
      ]
    );
    const testEmpId = empInsert.insertId;

    const empWithBillingToken = createToken({
      id: testEmpId,
      role: "employee",
      email: testEmpEmail
    });

    const billingOverviewRes = await request(
      `${API_BASE}/api/superadmin/billing/overview`,
      { headers: { Authorization: `Bearer ${empWithBillingToken}` } }
    );
    assert(billingOverviewRes.status === 200, "Employee with billing view permission can access billing overview");

    // Now remove billing module and verify 403
    await pool.query(
      `UPDATE users SET assigned_modules = ?, permissions = ? WHERE id = ?`,
      [JSON.stringify(["customers"]), JSON.stringify({ customers: ["view"] }), testEmpId]
    );

    const billingBlockedRes = await request(
      `${API_BASE}/api/superadmin/billing/overview`,
      { headers: { Authorization: `Bearer ${empWithBillingToken}` } }
    );
    assert(billingBlockedRes.status === 403, "Employee WITHOUT billing receives HTTP 403 Forbidden");

    // Clean up test employee
    await pool.query("DELETE FROM users WHERE id = ?", [testEmpId]);
    console.log("   Cleaned up temporary test employee record.");

    // 5. Test Quotation and Invoice PDF Generation
    console.log("\n--- Testing Quotation and Invoice PDF Generation ---");
    const testDoc = {
      id: 99999,
      document_number: "QT-TEST-2026-9999",
      quotation_number: "QT-TEST-2026-9999",
      invoice_number: "INV-TEST-2026-9999",
      invoice_date: "2026-10-23",
      due_date: "2026-11-23",
      quotation_date: "2026-10-23",
      valid_until: "2026-11-23",
      customer_name: "Acme Corp Ltd",
      customer_email: "contact@acme.com",
      customer_phone: "+91 9876543210",
      customer_address: "123 Commercial St, Business Park",
      customer_city: "Bengaluru",
      customer_state: "Karnataka",
      customer_pincode: "560001",
      customer_gstin: "29AAAAA0000A1Z5",
      subtotal: 10000,
      discount_amount: 500,
      tax_amount: 1710,
      total_amount: 11210,
      notes: "Thank you for your business.",
      terms_conditions: "Payment due within 30 days.",
      items: [
        { name: "Cloud Accounting Platform", quantity: 1, unit_price: 6000, total: 6000, hsn_code: "998311" },
        { name: "Implementation & Training", quantity: 2, unit_price: 2000, total: 4000, hsn_code: "998313" }
      ]
    };

    const business = {
      business_name: "KhataNex SaaS Technologies",
      phone: "+91 8001234567",
      email: "billing@khatanex.com",
      address: "KhataNex Tower, MG Road",
      city: "Kolkata",
      state: "West Bengal",
      pincode: "700001",
      gstin: "19AAAAA0000A1Z5"
    };

    // Quotation PDF
    const qPdfPath = await generateQuotationPdf({
      doc: testDoc,
      company: business,
      items: testDoc.items
    });
    assert(typeof qPdfPath === "string" && fs.existsSync(qPdfPath), "Quotation PDF generated on disk at: " + qPdfPath);
    const qFileBuffer = fs.readFileSync(qPdfPath);
    assert(qFileBuffer.length > 1000, `Quotation PDF file size is healthy (${qFileBuffer.length} bytes)`);
    assert(qFileBuffer.slice(0, 4).toString() === "%PDF", "Quotation PDF header starts with %PDF");
    const qPages = (qFileBuffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
    assert(qPages === 1, `Quotation PDF has exactly 1 page (actual: ${qPages})`);

    // Invoice PDF
    const invPdfPath = await generateInvoicePdf({
      doc: testDoc,
      company: business,
      items: testDoc.items
    });
    assert(typeof invPdfPath === "string" && fs.existsSync(invPdfPath), "Invoice PDF generated on disk at: " + invPdfPath);
    const invFileBuffer = fs.readFileSync(invPdfPath);
    assert(invFileBuffer.length > 1000, `Invoice PDF file size is healthy (${invFileBuffer.length} bytes)`);
    assert(invFileBuffer.slice(0, 4).toString() === "%PDF", "Invoice PDF header starts with %PDF");
    const invPages = (invFileBuffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
    assert(invPages === 1, `Invoice PDF has exactly 1 page (actual: ${invPages})`);

  } catch (err) {
    console.error("Test execution error:", err.message);
    failed++;
  } finally {
    console.log("\n========================================================================");
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("========================================================================");
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();

