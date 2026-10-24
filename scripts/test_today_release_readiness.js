require("dotenv").config();
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const http = require("http");
const db = require("../config/db");
const { generateInvoicePdf, generateQuotationPdf } = require("../utils/generateDocumentPdf");

let passed = 0;
let failed = 0;

function report(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

function countPdfPages(filePath) {
  const buf = fs.readFileSync(filePath);
  const matches = buf.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, "http://localhost:5001");
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function runAudit() {
  console.log("========================================================================");
  console.log("🚀 KHATANEX RELEASE-READINESS INTEGRATION & REGRESSION TEST SUITE");
  console.log("Target API: http://localhost:5001");
  console.log("========================================================================\n");

  let testUserId = null;
  let testUserToken = null;
  let createdDocId = null;
  let createdQuotationId = null;
  let createdPurchaseBillId = null;

  try {
    // -------------------------------------------------------------------------
    // 1. GET A VALID ACTIVE SUBSCRIBED USER & TOKEN FOR API CALLS
    // -------------------------------------------------------------------------
    const [users] = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.business_name, u.has_used_intro_offer
       FROM users u 
       JOIN subscriptions s ON u.id = s.user_id
       WHERE u.role = 'user' AND u.status = 'active' AND s.status = 'active' AND s.ends_at > NOW()
       ORDER BY u.id ASC LIMIT 1`
    );

    assert(users.length > 0, "At least one active subscribed user found in database");
    const user = users[0];
    testUserId = user.id;

    // Generate valid JWT token for test user
    const jwt = require("jsonwebtoken");
    testUserToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "khatanex_jwt_secret_key_2026",
      { expiresIn: "1h" }
    );
    const authHeader = { Authorization: `Bearer ${testUserToken}` };

    console.log(`👤 Using test tenant user #${user.id} (${user.email})\n`);

    // -------------------------------------------------------------------------
    // 2. STRICT ONE-PAGE A4 PDF GENERATION VERIFICATION
    // -------------------------------------------------------------------------
    console.log("--- 1. Strict One-Page A4 PDF Verification ---");

    const sampleBusiness = {
      business_name: "KhataNex Premier Testing Corp",
      address_line1: "42 Enterprise Way",
      city: "Kolkata",
      state: "West Bengal",
      pincode: "700091",
      gstin: "19AABCK1234F1Z0",
      phone: "9830000000",
      email: "billing@khatanexcorp.com",
    };

    // Test Invoice PDF with 1 item
    const inv1Doc = {
      invoice_number: "INV-AUDIT-001",
      invoice_date: new Date(),
      due_date: new Date(),
      subtotal: 1000,
      total_amount: 1180,
      cgst_amount: 90,
      sgst_amount: 90,
      items: [{ product_name: "Standalone Custom Service", quantity: 1, rate: 1000, tax_rate: 18, total_amount: 1180 }],
    };
    const inv1Path = await generateInvoicePdf({ doc: inv1Doc, company: sampleBusiness, items: inv1Doc.items });
    report(fs.existsSync(inv1Path), "Invoice PDF (1 item) written to disk: " + path.basename(inv1Path));
    const inv1Pages = countPdfPages(inv1Path);
    report(inv1Pages === 1, `Invoice PDF (1 item) has strictly 1 page (actual: ${inv1Pages})`);

    // Test Invoice PDF with 12 items (dense table)
    const inv12Items = Array.from({ length: 12 }).map((_, i) => ({
      product_name: `Automated Batch Item #${i + 1}`,
      hsn_code: "8471",
      quantity: i + 1,
      rate: (i + 1) * 100,
      tax_rate: 18,
      total_amount: (i + 1) * 100 * 1.18,
    }));
    const inv12Doc = {
      invoice_number: "INV-AUDIT-012",
      invoice_date: new Date(),
      due_date: new Date(),
      items: inv12Items,
      subtotal: 7800,
      total_tax: 1404,
      total_amount: 9204,
    };
    const inv12Path = await generateInvoicePdf({ doc: inv12Doc, company: sampleBusiness, items: inv12Items });
    const inv12Pages = countPdfPages(inv12Path);
    report(inv12Pages === 1, `Invoice PDF (12 dense items) strictly fits on 1 page (actual: ${inv12Pages})`);

    // Test Quotation PDF with 8 items
    const quo8Items = Array.from({ length: 8 }).map((_, i) => ({
      product_name: `Quotation Scope Item #${i + 1}`,
      quantity: 2,
      rate: 450,
      tax_rate: 18,
      total_amount: 1062,
    }));
    const quoDoc = {
      quotation_number: "QT-AUDIT-008",
      doc_type: "quotation",
      quotation_date: new Date(),
      valid_until: new Date(),
      items: quo8Items,
      subtotal: 3600,
      total_amount: 4248,
    };
    const quoPath = await generateQuotationPdf({ doc: quoDoc, company: sampleBusiness, items: quo8Items });
    const quoPages = countPdfPages(quoPath);
    report(quoPages === 1, `Quotation PDF (8 items) strictly fits on 1 page (actual: ${quoPages})`);

    // Watermark check: Customer invoice PDF must NOT contain "Powered by KhataNex"
    const invBuf = fs.readFileSync(inv1Path).toString("latin1");
    const hasWatermark = invBuf.includes("Powered by KhataNex");
    report(!hasWatermark, "Watermark check: Customer PDF does NOT contain KhataNex branding watermark");

    // -------------------------------------------------------------------------
    // 3. MANUAL ITEMS PERSISTENCE WITHOUT INVENTORY REQUIREMENT
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Manual Custom Item Persistence (Without Stock Depletion) ---");

    // Create a unique customer for testing
    const [custResult] = await db.query(
      `INSERT INTO customers (created_by, name, phone, email, created_at, updated_at) 
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [user.id, "Audit Test Customer", "9998887776", "audit.customer@test.com"]
    );
    const testCustomerId = custResult.insertId;

    // Create invoice with an item not present in inventory stock (product_id = null)
    const customItemName = `Manual Consulting Service ${Date.now()}`;
    const invoicePayload = {
      doc_type: "invoice",
      invoice_number: `INV-MAN-${Date.now()}`,
      customer_id: testCustomerId,
      invoice_date: new Date().toISOString().slice(0, 10),
      due_date: new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10),
      items: [
        {
          product_name: customItemName,
          item_type: "goods", // marked as goods but has no product_id
          quantity: 3,
          rate: 1250,
          discount: 0,
          tax_rate: 18,
          total_amount: 4425,
        },
      ],
      subtotal: 3750,
      total_tax: 675,
      total_amount: 4425,
      terms: "Standard payment within 7 days.",
      notes: "Custom manual item test.",
    };

    const invRes = await makeRequest("POST", "/api/documents", authHeader, invoicePayload);
    report(invRes.status === 200 || invRes.status === 201, `POST /api/documents returns HTTP ${invRes.status} (manual item invoice created without error)`);

    const createdDoc = invRes.body?.document || invRes.body;
    createdDocId = createdDoc?.id;
    report(Boolean(createdDocId), `Invoice created with ID #${createdDocId}`);

    // Retrieve the created document and verify manual item name persisted
    const getDocRes = await makeRequest("GET", `/api/documents/${createdDocId}`, authHeader);
    const retrievedItems = getDocRes.body?.document?.items || getDocRes.body?.items || [];
    const savedItem = retrievedItems.find((it) => (it.product_name || it.name) === customItemName);
    report(Boolean(savedItem), `Manual item "${customItemName}" persisted in database with correct name`);
    report(Number(savedItem?.quantity || 0) === 3, `Manual item quantity is 3 (actual: ${savedItem?.quantity})`);

    // Verify quotation creation with manual item
    const quotationPayload = {
      doc_type: "quotation",
      quotation_number: `QT-MAN-${Date.now()}`,
      customer_id: testCustomerId,
      quotation_date: new Date().toISOString().slice(0, 10),
      valid_until: new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10),
      items: [
        {
          product_name: `Custom Quotation Spec Item ${Date.now()}`,
          quantity: 5,
          rate: 800,
          tax_rate: 18,
          total_amount: 4720,
        },
      ],
      subtotal: 4000,
      total_amount: 4720,
    };
    const quoRes = await makeRequest("POST", "/api/documents", authHeader, quotationPayload);
    report(quoRes.status === 200 || quoRes.status === 201, `POST /api/documents (quotation) returns HTTP ${quoRes.status} without stock check error`);
    createdQuotationId = quoRes.body?.document?.id || quoRes.body?.id;

    // -------------------------------------------------------------------------
    // 4. DEDICATED PURCHASES MANAGEMENT (/api/purchase-bills)
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Dedicated Purchases Management CRUD (/api/purchase-bills) ---");

    const purchaseBillPayload = {
      bill_number: `BILL-TEST-${Date.now()}`,
      vendor_name: "Apex Raw Materials Ltd",
      bill_date: new Date().toISOString(),
      total_amount: 15750,
      gst_amount: 2400,
      items: [
        {
          item_name: "Industrial Steel Sheets Grade A",
          item_type: "goods",
          quantity: 10,
          unit: "Sheets",
          price: 1000,
          discount: 0,
          gst_rate: 18,
          hsn_code: "7208",
        },
        {
          item_name: "Hydraulic Oil 20L",
          item_type: "goods",
          quantity: 2,
          unit: "Cans",
          price: 1675,
          discount: 0,
          gst_rate: 18,
          hsn_code: "2710",
        },
      ],
    };

    // 1. Create Purchase Bill
    const createBillRes = await makeRequest("POST", "/api/purchase-bills", authHeader, purchaseBillPayload);
    report(createBillRes.status === 200 || createBillRes.status === 201, `POST /api/purchase-bills returns HTTP ${createBillRes.status} (Purchase bill created)`);
    createdPurchaseBillId = createBillRes.body?.purchase_bill?.id || createBillRes.body?.id || createBillRes.body?.bill?.id;
    report(Boolean(createdPurchaseBillId), `Purchase bill created with ID #${createdPurchaseBillId}`);

    // 2. List Purchase Bills
    const listBillsRes = await makeRequest("GET", "/api/purchase-bills", authHeader);
    report(listBillsRes.status === 200, "GET /api/purchase-bills returns HTTP 200");
    const billsList = listBillsRes.body?.purchase_bills || listBillsRes.body?.bills || listBillsRes.body || [];
    const foundBill = Array.isArray(billsList) && billsList.some((b) => b.id === createdPurchaseBillId);
    report(foundBill, `Newly created purchase bill #${createdPurchaseBillId} present in purchases list`);

    // 3. Get Purchase Bill by ID
    const getBillRes = await makeRequest("GET", `/api/purchase-bills/${createdPurchaseBillId}`, authHeader);
    report(getBillRes.status === 200, `GET /api/purchase-bills/${createdPurchaseBillId} returns HTTP 200`);
    const billDetail = getBillRes.body?.purchase_bill || getBillRes.body?.bill || getBillRes.body;
    report(billDetail?.vendor_name === "Apex Raw Materials Ltd", "Purchase bill vendor matches 'Apex Raw Materials Ltd'");
    report(Array.isArray(billDetail?.items) && billDetail.items.length === 2, "Purchase bill items contains 2 line items");

    // 4. Search Purchase Items
    const searchItemsRes = await makeRequest("GET", "/api/purchase-bills/items?query=Steel", authHeader);
    report(searchItemsRes.status === 200, "GET /api/purchase-bills/items?query=Steel returns HTTP 200");
    const matchedItems = searchItemsRes.body?.items || searchItemsRes.body || [];
    report(Array.isArray(matchedItems), "Search purchase items returns array for inventory autofill");

    // 5. Update Purchase Bill
    const updateBillRes = await makeRequest("PUT", `/api/purchase-bills/${createdPurchaseBillId}`, authHeader, {
      ...purchaseBillPayload,
      vendor_name: "Apex Raw Materials International",
    });
    report(updateBillRes.status === 200, `PUT /api/purchase-bills/${createdPurchaseBillId} updates bill successfully`);

    // 6. Delete Purchase Bill
    const deleteBillRes = await makeRequest("DELETE", `/api/purchase-bills/${createdPurchaseBillId}`, authHeader);
    report(deleteBillRes.status === 200, `DELETE /api/purchase-bills/${createdPurchaseBillId} removes bill successfully`);
    createdPurchaseBillId = null;

    // -------------------------------------------------------------------------
    // 5. INTRODUCTORY OFFER SINGLE-USE RE-USE PROTECTION
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Introductory Offer Re-Use Protection ---");

    // Query active plans
    const [plans] = await db.query("SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY duration_months ASC");
    assert(plans.length > 0, "Active plans exist");
    const targetPlan = plans[0];

    // Ensure user has has_used_intro_offer = 1
    await db.query("UPDATE users SET has_used_intro_offer = 1 WHERE id = ?", [user.id]);

    // Request price calculation for target plan
    const calcRes = await makeRequest("POST", "/api/subscriptions/price", authHeader, {
      plan_code: targetPlan.plan_code || "monthly",
    });
    report(calcRes.status === 200, "POST /api/subscriptions/price returns HTTP 200");

    const pricing = calcRes.body?.pricing || calcRes.body;
    report(pricing?.isIntroductory === false && pricing?.introductoryDiscountPaise === 0,
      "Server flags user as ineligible for introductory pricing (has_used_intro_offer = 1 enforced, isIntroductory: false, discount: ₹0)");

    // Clean up temporary records
    try {
      if (createdDocId) {
        await db.query("DELETE FROM invoice_items WHERE invoice_id = ?", [createdDocId]);
        await db.query("DELETE FROM documents WHERE id = ?", [createdDocId]);
      }
      if (createdQuotationId) {
        await db.query("DELETE FROM quotation_items WHERE quotation_id = ?", [createdQuotationId]);
        await db.query("DELETE FROM documents WHERE id = ?", [createdQuotationId]);
      }
      if (createdPurchaseBillId) {
        await db.query("DELETE FROM purchase_bill_items WHERE purchase_bill_id = ?", [createdPurchaseBillId]);
        await db.query("DELETE FROM purchase_bills WHERE id = ?", [createdPurchaseBillId]);
      }
      if (testCustomerId) {
        await db.query("DELETE FROM customers WHERE id = ?", [testCustomerId]);
      }
    } catch (_) {}

  } catch (err) {
    console.error("Test failure:", err);
    failed++;
  } finally {
    console.log("\n========================================================================");
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("========================================================================");
    process.exit(failed > 0 ? 1 : 0);
  }
}

runAudit();
