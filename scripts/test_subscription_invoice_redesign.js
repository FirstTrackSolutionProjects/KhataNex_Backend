const fs = require("fs");
const path = require("path");
const pool = require("../config/db");
const {
  generateSubscriptionInvoicePdf,
  amountInWordsINR,
  rs,
  fmtDate,
  DEFAULT_SUBSCRIPTION_SAC,
  SELLER_DETAILS,
} = require("../utils/generateSubscriptionInvoicePdf");
const { issueInvoice } = require("../utils/subscriptionInvoice");

async function runTests() {
  console.log("======================================================");
  console.log("TEST SUITE: Subscription Invoice PDF Redesign & Persistence");
  console.log("======================================================\n");

  let passed = 0;
  let failed = 0;

  const assert = (condition, msg) => {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  };

  // -----------------------------------------------------------
  // TEST 1: Helper formatting & Amount In Words
  // -----------------------------------------------------------
  console.log("--- 1. Testing Formatters & Amount In Words ---");
  assert(rs(59900) === "Rs. 599.00", "rs(59900) formats to Rs. 599.00");
  assert(rs(117900) === "Rs. 1,179.00", "rs(117900) formats to Rs. 1,179.00");
  assert(rs(0) === "Rs. 0.00", "rs(0) formats to Rs. 0.00");

  assert(
    amountInWordsINR(599) === "Rupees Five Hundred Ninety Nine Only",
    `amountInWordsINR(599) -> "Rupees Five Hundred Ninety Nine Only"`
  );
  assert(
    amountInWordsINR(1179) === "Rupees One Thousand One Hundred Seventy Nine Only",
    `amountInWordsINR(1179) -> "Rupees One Thousand One Hundred Seventy Nine Only"`
  );
  assert(
    amountInWordsINR(1179.5) === "Rupees One Thousand One Hundred Seventy Nine and Fifty Paise Only",
    `amountInWordsINR(1179.5) -> includes paise properly`
  );

  // -----------------------------------------------------------
  // TEST 2: Static seller & SAC configuration
  // -----------------------------------------------------------
  console.log("\n--- 2. Testing Seller Details & SAC Code ---");
  assert(SELLER_DETAILS.companyName === "First Track Solution Technologies Pvt. Ltd.", "Seller name exact match");
  assert(SELLER_DETAILS.address === "Saheed Nagar, Bhubaneswar, Odisha, India-751007", "Seller address exact match");
  assert(SELLER_DETAILS.contactNo === "+91 8240742313", "Seller contact exact match");
  assert(SELLER_DETAILS.email === "contact@firsttrackkhatanex.in", "Seller email exact match");
  assert(SELLER_DETAILS.gstin === "21AAECF0000A1Z5", "Seller GSTIN exact match");
  assert(SELLER_DETAILS.pan === "AAECF0000A", "Seller PAN exact match");
  assert(DEFAULT_SUBSCRIPTION_SAC === "997331", "SAC code is 997331");

  // -----------------------------------------------------------
  // TEST 3: Render PDF for Intra-State (Odisha) Order
  // -----------------------------------------------------------
  console.log("\n--- 3. Testing PDF Generation: Intra-State (Odisha) with GST ---");
  const intraStateInvoice = {
    invoice_number: "SUB-2026-TEST01",
    issued_at: new Date("2026-10-24T10:00:00Z"),
    pdf_filename: "TEST-INTRASTATE-INVOICE.pdf",
  };

  const intraStateOrder = {
    id: 991,
    order_number: "SUB-ORD-TEST-001",
    plan_name: "KhataNex Pro Annual",
    duration_months: 12,
    business_name: "M/s Maa Tarini Traders",
    user_name: "Debasish Mohapatra",
    user_email: "tarini.traders@gmail.com",
    user_phone: "+91 9876543210",
    user_address: "Plot 102, Chandrasekharpur",
    user_city: "Bhubaneswar",
    user_state: "Odisha",
    user_pincode: "751024",
    user_gstin: "21ABCDE1234F1Z5",
    user_pan: "ABCDE1234F",
    provider_payment_id: "pay_test_intra_12345",
    paid_at: new Date("2026-10-24T10:00:00Z"),
    starts_at: new Date("2026-10-24T00:00:00Z"),
    ends_at: new Date("2027-10-24T23:59:59Z"),
    list_price_paise: 117900,
    total_paise: 117900,
    taxable_paise: 99915,
    tax_percent: 18,
    tax_paise: 17985,
  };

  const intraPdfPath = await generateSubscriptionInvoicePdf({
    invoice: intraStateInvoice,
    order: intraStateOrder,
  });

  assert(fs.existsSync(intraPdfPath), `Intra-state PDF generated at ${intraPdfPath}`);
  const intraStats = fs.statSync(intraPdfPath);
  assert(intraStats.size > 5000, `PDF size is valid (${intraStats.size} bytes)`);

  // -----------------------------------------------------------
  // TEST 4: Render PDF for Inter-State Order with Blank Fields
  // -----------------------------------------------------------
  console.log("\n--- 4. Testing PDF Generation: Inter-State with missing/blank fields ---");
  const interStateInvoice = {
    invoice_number: "SUB-2026-TEST02",
    issued_at: new Date("2026-10-28T14:30:00Z"),
    pdf_filename: "TEST-INTERSTATE-BLANKS-INVOICE.pdf",
  };

  const interStateOrder = {
    id: 992,
    order_number: "SUB-ORD-TEST-002",
    plan_name: "KhataNex Starter",
    duration_months: 1,
    business_name: null, // Test blank
    user_name: "Rajesh Sharma",
    user_email: "rajesh.sharma@example.com",
    user_phone: null, // Test blank
    user_address: null, // Test blank
    user_city: "Bengaluru",
    user_state: "Karnataka",
    user_pincode: null,
    user_gstin: null, // Unregistered / Blank
    user_pan: null,   // Blank
    provider_payment_id: "pay_test_inter_67890",
    paid_at: new Date("2026-10-28T14:30:00Z"),
    starts_at: new Date("2026-10-28T00:00:00Z"),
    ends_at: new Date("2026-11-28T23:59:59Z"),
    list_price_paise: 59900,
    introductory_discount_paise: 10000,
    coupon_discount_paise: 5000,
    coupon_code: "FESTIVE50",
    total_paise: 44900,
    taxable_paise: 38051,
    tax_percent: 18,
    tax_paise: 6849,
  };

  const interPdfPath = await generateSubscriptionInvoicePdf({
    invoice: interStateInvoice,
    order: interStateOrder,
  });

  assert(fs.existsSync(interPdfPath), `Inter-state PDF generated at ${interPdfPath}`);
  const interStats = fs.statSync(interPdfPath);
  assert(interStats.size > 5000, `PDF size is valid (${interStats.size} bytes)`);

  // -----------------------------------------------------------
  // TEST 5: SQL Database Persistence & Idempotency
  // -----------------------------------------------------------
  console.log("\n--- 5. Testing Database Persistence & Idempotency ---");
  // Find or insert a test paid order in database
  const [testOrders] = await pool.query(
    "SELECT id, order_number, invoice_number, status FROM subscription_orders WHERE status = 'paid' LIMIT 1"
  );

  if (testOrders.length > 0) {
    const testOrderId = testOrders[0].id;
    console.log(`Using existing paid order ID #${testOrderId} (${testOrders[0].order_number})`);

    const inv1 = await issueInvoice(testOrderId);
    assert(Boolean(inv1 && inv1.invoice_number), `Generated/retrieved invoice #${inv1.invoice_number}`);

    // Verify subscription_invoices has it
    const [invRows] = await pool.query(
      "SELECT invoice_number FROM subscription_invoices WHERE order_id = ?",
      [testOrderId]
    );
    assert(invRows.length === 1, "Exactly 1 invoice record in subscription_invoices");
    assert(invRows[0].invoice_number === inv1.invoice_number, "Invoice number matches in subscription_invoices");

    // Verify subscription_orders has it permanently persisted
    const [orderRows] = await pool.query(
      "SELECT invoice_number FROM subscription_orders WHERE id = ?",
      [testOrderId]
    );
    assert(orderRows[0].invoice_number === inv1.invoice_number, "Invoice number matches in subscription_orders table");

    // Test Idempotency: Calling issueInvoice again must NOT create a new number or throw duplicate error
    const inv2 = await issueInvoice(testOrderId);
    assert(inv2.invoice_number === inv1.invoice_number, "Subsequent issueInvoice reuses identical invoice number");

    const [invCount] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM subscription_invoices WHERE order_id = ?",
      [testOrderId]
    );
    assert(invCount[0].cnt === 1, "Idempotency preserved: No duplicate records created");
  } else {
    console.log("No paid subscription orders in local database to run live DB issueInvoice; skipping live DB test.");
  }

  console.log("\n======================================================");
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("======================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
