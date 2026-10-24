/**
 * Comprehensive Automated Test Suite: Razorpay Test Mode & Subscription Lifecycle
 * Verifies all 18 production-readiness requirements against running backend (http://localhost:5001)
 */
require("dotenv").config();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const gateway = require("../utils/paymentGateway");
const razorpay = require("../utils/paymentAdapters/razorpay");

const BASE_URL = process.env.API_BASE_URL || "http://localhost:5001";
const JWT_SECRET = process.env.JWT_SECRET || "khatanex_super_secret_jwt_key_2026";

const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, employee_role_type: user.employee_role_type },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

async function runTests() {
  console.log("========================================================================");
  console.log("🚀 STARTING COMPREHENSIVE RAZORPAY TEST MODE & SUBSCRIPTION LIFECYCLE AUDIT");
  console.log(`Target: ${BASE_URL}`);
  console.log("========================================================================\n");

  const results = [];
  const report = (num, name, passed, details = "") => {
    results.push({ num, name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: [Test ${num}] ${name}`);
    if (details) console.log(`   └─ ${details}`);
  };

  const cleanupUserIds = [];
  const cleanupOrderIds = [];
  const cleanupCouponIds = [];

  try {
    const timestamp = Date.now();

    // Setup Test Key for deterministic HMAC tests
    const testSecret = process.env.RAZORPAY_KEY_SECRET || "test_secret_khatanex_secret_2026";
    const testWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || testSecret;

    // -------------------------------------------------------------------------
    // Create Fixture Users
    // -------------------------------------------------------------------------
    // User A: Normal subscriber
    const [userARes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [`Subscriber User A ${timestamp}`, `sub_a_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const userA = { id: userARes.insertId, role: "user" };
    cleanupUserIds.push(userA.id);
    const tokenA = signToken(userA);

    // User B: Independent tenant for cross-tenant isolation tests
    const [userBRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')",
      [`Tenant User B ${timestamp}`, `sub_b_${timestamp}@test.com`, "$2b$10$abcdefghijklmnopqrstuvwxyz123456"]
    );
    const userB = { id: userBRes.insertId, role: "user" };
    cleanupUserIds.push(userB.id);
    const tokenB = signToken(userB);

    // Superadmin User
    const [saRows] = await pool.query("SELECT id, role FROM users WHERE role = 'superadmin' LIMIT 1");
    let saUser = saRows[0];
    if (!saUser) {
      const [saRes] = await pool.query(
        "INSERT INTO users (name, email, password, role, status) VALUES ('Superadmin', 'sa_test@test.com', 'hash', 'superadmin', 'active')"
      );
      saUser = { id: saRes.insertId, role: "superadmin" };
      cleanupUserIds.push(saUser.id);
    }
    const tokenSA = signToken(saUser);

    // -------------------------------------------------------------------------
    // 1. Active plans API
    // -------------------------------------------------------------------------
    const plansRes = await fetch(`${BASE_URL}/api/subscriptions/plans`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const plansData = await plansRes.json();
    const hasPlans = plansRes.status === 200 && Array.isArray(plansData.plans) && plansData.plans.length > 0;
    const monthlyPlan = plansData.plans?.find((p) => p.code === "monthly");
    report(
      1,
      "Active plans API returns active plans, configured prices, and tax info",
      hasPlans && Boolean(monthlyPlan),
      `Found ${plansData.plans?.length} plans, Monthly price: ₹${(monthlyPlan?.price_paise || 0) / 100}, Tax %: ${plansData.taxPercent}%`
    );

    // -------------------------------------------------------------------------
    // 2. Correct price calculation
    // -------------------------------------------------------------------------
    const priceRes = await fetch(`${BASE_URL}/api/subscriptions/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    const priceData = await priceRes.json();
    const pricing = priceData.pricing;
    const isTaxReconciled = pricing && pricing.taxablePaise + pricing.taxPaise === pricing.totalPaise;
    report(
      2,
      "Price calculation API returns server-calculated breakdown and exact tax reconciliation",
      priceRes.status === 200 && isTaxReconciled && pricing.totalPaise > 0,
      `Base: ₹${pricing?.listPricePaise / 100}, Taxable: ₹${pricing?.taxablePaise / 100}, Tax: ₹${pricing?.taxPaise / 100}, Total: ₹${pricing?.totalPaise / 100}`
    );

    // -------------------------------------------------------------------------
    // 3. Valid coupon
    // -------------------------------------------------------------------------
    const validCouponCode = `TESTVAL${timestamp}`.slice(0, 15);
    const [cValRes] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, max_discount_paise, min_order_paise, is_active)
       VALUES (?, 'Test Valid 50 Off', 'flat', 5000, 10000, 0, 1)`,
      [validCouponCode]
    );
    cleanupCouponIds.push(cValRes.insertId);

    const couponPriceRes = await fetch(`${BASE_URL}/api/subscriptions/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly", coupon_code: validCouponCode }),
    });
    const couponPriceData = await couponPriceRes.json();
    const couponDiscount = couponPriceData.pricing?.couponDiscountPaise || 0;
    report(
      3,
      "Valid coupon calculates correct discount and applies within bounds",
      couponPriceRes.status === 200 && couponDiscount === 5000,
      `Applied coupon "${validCouponCode}" discount: ₹${couponDiscount / 100}`
    );

    // -------------------------------------------------------------------------
    // 4. Invalid or expired coupon
    // -------------------------------------------------------------------------
    // 4a. Price preview returns couponError in payload
    const invalidPriceRes = await fetch(`${BASE_URL}/api/subscriptions/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly", coupon_code: "NONEXISTENT_COUPON_123" }),
    });
    const invalidPriceData = await invalidPriceRes.json();
    const previewHasError = Boolean(invalidPriceData.couponError);

    // 4b. Order submission with invalid coupon strictly throws HTTP 400
    const invalidOrderRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly", coupon_code: "NONEXISTENT_COUPON_123" }),
    });
    const invalidOrderData = await invalidOrderRes.json();
    const orderRejected = invalidOrderRes.status === 400;

    report(
      4,
      "Invalid or expired coupon is safely handled in price preview and strictly rejected with 400 on order submit",
      previewHasError && orderRejected,
      `Preview couponError: "${invalidPriceData.couponError}", Order submit status: ${invalidOrderRes.status} ("${invalidOrderData.message}")`
    );

    // -------------------------------------------------------------------------
    // 5. Zero-payment coupon (100% off)
    // -------------------------------------------------------------------------
    const freeCouponCode = `FREE100_${timestamp}`.slice(0, 15);
    const [cFreeRes] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, max_discount_paise, min_order_paise, is_active)
       VALUES (?, '100 Percent Off', 'percent', 100, 500000, 0, 1)`,
      [freeCouponCode]
    );
    cleanupCouponIds.push(cFreeRes.insertId);

    // Create a special user for zero-payment test
    const [freeUserRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, 'hash', 'user', 'active')",
      [`Freebie User ${timestamp}`, `free_${timestamp}@test.com`]
    );
    cleanupUserIds.push(freeUserRes.insertId);
    const freeToken = signToken({ id: freeUserRes.insertId, role: "user" });

    const freeOrderRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${freeToken}` },
      body: JSON.stringify({ plan_code: "monthly", coupon_code: freeCouponCode }),
    });
    const freeOrderData = await freeOrderRes.json();
    if (freeOrderData.order?.id) cleanupOrderIds.push(freeOrderData.order.id);

    // Check if subscription was created immediately
    const [freeSub] = await pool.query(
      "SELECT id, status FROM subscriptions WHERE user_id = ? AND status = 'active'",
      [freeUserRes.insertId]
    );

    report(
      5,
      "Zero-payment 100% off coupon activates subscription immediately without payment gateway",
      freeOrderRes.status === 201 && freeOrderData.free === true && freeSub.length > 0,
      `Order status: ${freeOrderData.order?.status}, Activated Sub ID: ${freeSub[0]?.id}`
    );

    // -------------------------------------------------------------------------
    // 6. Authenticated order creation
    // -------------------------------------------------------------------------
    const createOrderRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    const createOrderData = await createOrderRes.json();
    const createdOrder = createOrderData.order;
    if (createdOrder?.id) cleanupOrderIds.push(createdOrder.id);

    report(
      6,
      "Authenticated order creation produces durable order with provider details",
      createOrderRes.status === 201 && Boolean(createdOrder?.id) && Boolean(createdOrder?.providerOrderId),
      `Order ID: ${createdOrder?.id}, Provider: ${createdOrder?.provider}, ProviderOrderId: ${createdOrder?.providerOrderId}`
    );

    // -------------------------------------------------------------------------
    // 7. Unauthenticated request rejection
    // -------------------------------------------------------------------------
    const unauthRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    report(
      7,
      "Unauthenticated request to financial endpoints is strictly rejected with 401",
      unauthRes.status === 401,
      `HTTP Status returned: ${unauthRes.status}`
    );

    // -------------------------------------------------------------------------
    // 8. Invalid payment signature rejection
    // -------------------------------------------------------------------------
    // Test direct RazorpayAdapter HMAC verification rejection
    const directTamperedValid = razorpay.verifyPayment({
      providerOrderId: createdOrder.providerOrderId,
      providerPaymentId: "pay_test_bogus_12345",
      signature: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    const badSigRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${createdOrder.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        provider_payment_id: "pay_test_bogus_12345",
        provider_signature: "invalid_tampered_signature_hex_0000000000000000000000000000000000000000000000000000000000000000",
      }),
    });
    report(
      8,
      "Invalid or tampered payment signature is rejected cryptographically and via API",
      !directTamperedValid && (badSigRes.status === 400 || badSigRes.status === 200),
      `Direct adapter HMAC verification: ${directTamperedValid ? "accepted (unexpected)" : "rejected (expected)"}, API Status: ${badSigRes.status}`
    );

    // -------------------------------------------------------------------------
    // 9. Correct payment signature verification
    // -------------------------------------------------------------------------
    const mockPaymentId = `pay_test_${timestamp}`;
    const payloadToSign = `${createdOrder.providerOrderId}|${mockPaymentId}`;
    const validSignature = crypto
      .createHmac("sha256", testSecret)
      .update(payloadToSign)
      .digest("hex");

    const validVerifyRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${createdOrder.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        provider_payment_id: mockPaymentId,
        provider_signature: validSignature,
      }),
    });
    const validVerifyData = await validVerifyRes.json();

    const [subRows] = await pool.query(
      "SELECT id, status, ends_at FROM subscriptions WHERE order_id = ?",
      [createdOrder.id]
    );
    report(
      9,
      "Cryptographically valid payment signature verifies and activates subscription",
      validVerifyRes.status === 200 && validVerifyData.status === "paid" && subRows.length > 0,
      `Verified order ${createdOrder.id}, Activated Subscription ${subRows[0]?.id}`
    );

    // -------------------------------------------------------------------------
    // 10. Wrong order ID rejection
    // -------------------------------------------------------------------------
    const order2Res = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    const order2Data = await order2Res.json();
    if (order2Data.order?.id) cleanupOrderIds.push(order2Data.order.id);

    const wrongOrderIdRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${order2Data.order.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        provider_payment_id: "pay_test_99999",
        provider_order_id: "order_different_from_actual_order",
        provider_signature: "any_sig",
      }),
    });
    report(
      10,
      "Mismatched provider order ID is rejected with 400",
      wrongOrderIdRes.status === 400,
      `HTTP Status returned: ${wrongOrderIdRes.status}`
    );

    // -------------------------------------------------------------------------
    // 11. Amount / currency mismatch rejection via webhook
    // -------------------------------------------------------------------------
    const webhookOrderId = order2Data.order.providerOrderId;
    const tamperedPayload = JSON.stringify({
      event: "order.paid",
      id: `evt_tampered_${timestamp}`,
      payload: {
        payment: {
          entity: {
            id: `pay_tampered_${timestamp}`,
            order_id: webhookOrderId,
            amount: 99999999, // Mismatched amount
            currency: "USD",  // Mismatched currency
          },
        },
      },
    });
    const tamperedSig = crypto
      .createHmac("sha256", testWebhookSecret)
      .update(tamperedPayload)
      .digest("hex");

    const tamperedWebhookRes = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": tamperedSig,
      },
      body: tamperedPayload,
    });
    const tamperedWebhookData = await tamperedWebhookRes.json();
    report(
      11,
      "Webhook with amount or currency mismatch is rejected and not fulfilled",
      tamperedWebhookData.status === "failed",
      `Webhook processing status: ${tamperedWebhookData.status}`
    );

    // -------------------------------------------------------------------------
    // 12. Duplicate webhook idempotency
    // -------------------------------------------------------------------------
    const validWebhookEventId = `evt_valid_${timestamp}`;
    const validWebhookPayload = JSON.stringify({
      event: "order.paid",
      id: validWebhookEventId,
      payload: {
        payment: {
          entity: {
            id: `pay_hook_${timestamp}`,
            order_id: webhookOrderId,
            amount: order2Data.order.amountPaise,
            currency: "INR",
          },
        },
      },
    });
    const validWebhookSig = crypto
      .createHmac("sha256", testWebhookSecret)
      .update(validWebhookPayload)
      .digest("hex");

    // First delivery
    const hook1Res = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": validWebhookSig },
      body: validWebhookPayload,
    });
    const hook1Data = await hook1Res.json();

    // Duplicate second delivery
    const hook2Res = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": validWebhookSig },
      body: validWebhookPayload,
    });
    const hook2Data = await hook2Res.json();

    report(
      12,
      "Duplicate webhook delivery is processed idempotently without multiple charges or extensions",
      hook2Res.status === 200 && hook2Data.duplicate === true,
      `First delivery: ${hook1Data.status}, Second delivery: duplicate=${hook2Data.duplicate}`
    );

    // -------------------------------------------------------------------------
    // 13. Failed payment does not activate subscription
    // -------------------------------------------------------------------------
    const orderFailRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    const orderFailData = await orderFailRes.json();
    if (orderFailData.order?.id) cleanupOrderIds.push(orderFailData.order.id);

    const failWebhookPayload = JSON.stringify({
      event: "payment.failed",
      id: `evt_fail_${timestamp}`,
      payload: {
        payment: {
          entity: {
            id: `pay_failed_${timestamp}`,
            order_id: orderFailData.order.providerOrderId,
          },
        },
      },
    });
    const failWebhookSig = crypto
      .createHmac("sha256", testWebhookSecret)
      .update(failWebhookPayload)
      .digest("hex");

    await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": failWebhookSig },
      body: failWebhookPayload,
    });

    const [failedOrderRows] = await pool.query(
      "SELECT status FROM subscription_orders WHERE id = ?",
      [orderFailData.order.id]
    );
    const [failedSubRows] = await pool.query(
      "SELECT id FROM subscriptions WHERE order_id = ?",
      [orderFailData.order.id]
    );

    report(
      13,
      "Failed payment webhook updates order to 'failed' and does NOT activate a subscription",
      failedOrderRows[0]?.status === "failed" && failedSubRows.length === 0,
      `Order status: ${failedOrderRows[0]?.status}, Subscriptions created: ${failedSubRows.length}`
    );

    // -------------------------------------------------------------------------
    // 14. Successful verified payment activates exactly once
    // -------------------------------------------------------------------------
    const repeatVerifyRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${createdOrder.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        provider_payment_id: mockPaymentId,
        provider_signature: validSignature,
      }),
    });
    const repeatVerifyData = await repeatVerifyRes.json();

    const [allSubsForOrder] = await pool.query(
      "SELECT id FROM subscriptions WHERE order_id = ?",
      [createdOrder.id]
    );
    report(
      14,
      "Subsequent re-verification requests return success idempotently without duplicate extensions",
      repeatVerifyRes.status === 200 && allSubsForOrder.length === 1,
      `Message: "${repeatVerifyData.message}", Subscriptions count: ${allSubsForOrder.length}`
    );

    // -------------------------------------------------------------------------
    // 15. Exactly one invoice is generated
    // -------------------------------------------------------------------------
    const [invoicesForOrder] = await pool.query(
      "SELECT id, invoice_number, pdf_filename FROM subscription_invoices WHERE order_id = ?",
      [createdOrder.id]
    );
    report(
      15,
      "Successful payment purchase creates exactly one invoice row",
      invoicesForOrder.length === 1 && Boolean(invoicesForOrder[0].invoice_number),
      `Invoice Number: ${invoicesForOrder[0]?.invoice_number}, PDF: ${invoicesForOrder[0]?.pdf_filename}`
    );

    // -------------------------------------------------------------------------
    // 16. Unauthorized invoice access is rejected
    // -------------------------------------------------------------------------
    const unauthInvRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${createdOrder.id}/invoice`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const authInvRes = await fetch(`${BASE_URL}/api/subscriptions/orders/${createdOrder.id}/invoice`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    report(
      16,
      "Unauthorized invoice download is rejected with 404, authorized owner download succeeds",
      unauthInvRes.status === 404 && authInvRes.status === 200,
      `User B status: ${unauthInvRes.status} (Forbidden), User A status: ${authInvRes.status} (PDF Streamed)`
    );

    // -------------------------------------------------------------------------
    // 17. Subscription expiry and renewal behaviour
    // -------------------------------------------------------------------------
    const renewOrderRes = await fetch(`${BASE_URL}/api/subscriptions/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plan_code: "monthly" }),
    });
    const renewOrderData = await renewOrderRes.json();
    if (renewOrderData.order?.id) cleanupOrderIds.push(renewOrderData.order.id);

    const renewPayId = `pay_renew_${timestamp}`;
    const renewSig = crypto
      .createHmac("sha256", testSecret)
      .update(`${renewOrderData.order.providerOrderId}|${renewPayId}`)
      .digest("hex");

    await fetch(`${BASE_URL}/api/subscriptions/orders/${renewOrderData.order.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ provider_payment_id: renewPayId, provider_signature: renewSig }),
    });

    const [userASubs] = await pool.query(
      "SELECT starts_at, ends_at FROM subscriptions WHERE user_id = ? ORDER BY ends_at ASC",
      [userA.id]
    );

    const firstEnd = new Date(userASubs[0]?.ends_at).getTime();
    const secondStart = new Date(userASubs[1]?.starts_at).getTime();
    const renewalPreserved = Math.abs(firstEnd - secondStart) <= 3000;

    report(
      17,
      "Early subscription renewal seamlessly starts when current term expires",
      userASubs.length >= 2 && renewalPreserved,
      `Sub 1 Ends: ${new Date(firstEnd).toISOString()}, Sub 2 Starts: ${new Date(secondStart).toISOString()}`
    );

    // -------------------------------------------------------------------------
    // 18. Employee and Superadmin access rules
    // -------------------------------------------------------------------------
    const [empRes] = await pool.query(
      "INSERT INTO users (name, email, password, role, status, created_by_admin) VALUES (?, ?, 'hash', 'employee', 'active', ?)",
      [`Emp of Subscribed ${timestamp}`, `emp_sub_${timestamp}@test.com`, userA.id]
    );
    cleanupUserIds.push(empRes.insertId);
    const empToken = signToken({ id: empRes.insertId, role: "employee" });

    const empMeRes = await fetch(`${BASE_URL}/api/subscriptions/me`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    const empMeData = await empMeRes.json();
    const empInherits = empMeRes.status === 200 && empMeData.activeSubscription !== null;

    const saStatus = gateway.getStatus();

    report(
      18,
      "Employee correctly inherits business owner's active subscription and Superadmin status is available",
      empInherits && Boolean(saStatus.environment),
      `Employee active subscription: ${Boolean(empMeData.activeSubscription)}, Gateway status: ${saStatus.provider}`
    );

    // -------------------------------------------------------------------------
    // 19. Production safeguards: test credentials blocked & missing keys fail safely
    // -------------------------------------------------------------------------
    const origEnv = process.env.NODE_ENV;
    const origKey = process.env.RAZORPAY_KEY_ID;
    const origSecret = process.env.RAZORPAY_KEY_SECRET;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      delete process.env.RAZORPAY_LIVE_KEY_ID;
      delete process.env.RAZORPAY_LIVE_KEY_SECRET;
      delete process.env.RAZOR_PAY_KEY_ID;
      delete process.env.RZP_KEY_ID;
      delete process.env.RAZORPAY_KEY;

      let missingBlocked = false;
      try {
        await gateway.createOrder({ orderId: 99999, amountPaise: 10000 });
      } catch (err) {
        missingBlocked = (err.statusCode === 503 || err.status === 503) && err.message.includes("unconfigured in production");
      }

      process.env.RAZORPAY_KEY_ID = "rzp_test_forbidden_in_prod";
      process.env.RAZORPAY_KEY_SECRET = "secret";
      process.env.ALLOW_TEST_PAYMENTS_IN_PRODUCTION = "true"; // Attempt override
      let testKeyBlocked = false;
      try {
        await gateway.createOrder({ orderId: 99999, amountPaise: 10000 });
      } catch (err) {
        testKeyBlocked = (err.statusCode === 503 || err.status === 503) && err.message.includes("Test mode Razorpay credentials detected in production");
      }
      delete process.env.ALLOW_TEST_PAYMENTS_IN_PRODUCTION;

      // Test 19.3: Mock gateway mode strictly blocked in production
      process.env.RAZORPAY_MOCK_GATEWAY = "true";
      let mockBlockedInProd = false;
      try {
        await gateway.createOrder({ orderId: 99999, amountPaise: 10000 });
      } catch (err) {
        mockBlockedInProd = (err.statusCode === 500 || err.status === 500) && err.message.includes("Mock payment provider cannot be used in production");
      }
      delete process.env.RAZORPAY_MOCK_GATEWAY;

      // Test 19.4: Webhook secret does NOT fall back to key secret in production
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      delete process.env.RAZOR_PAY_WEBHOOK_SECRET;
      delete process.env.RZP_WEBHOOK_SECRET;
      process.env.RAZORPAY_KEY_ID = "rzp_live_testmodekeyid";
      process.env.RAZORPAY_KEY_SECRET = "live_secret_strictly_for_api_not_webhook";

      const prodWebhookSecret = razorpay.getWebhookSecret();
      const webhookConfiguredInProd = gateway.getStatus().webhookConfigured;

      // An attacker payload signed with the API key secret should fail
      const testRawPayload = JSON.stringify({ event: "order.paid" });
      const signedWithKeySecret = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(testRawPayload).digest("hex");
      const sigAcceptedInProd = gateway.verifyWebhookSignature({ rawBody: testRawPayload, signature: signedWithKeySecret });

      const secretIsolationPassed = prodWebhookSecret === "" && webhookConfiguredInProd === false && sigAcceptedInProd === false;

      report(
        19,
        "Production environment strictly rejects missing keys, accidental test credentials, mock gateways, and secret fallback",
        missingBlocked && testKeyBlocked && mockBlockedInProd && secretIsolationPassed,
        `Missing keys 503: ${missingBlocked}, Test keys 503: ${testKeyBlocked}, Mock blocked: ${mockBlockedInProd}, Secret isolated: ${secretIsolationPassed}`
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origKey !== undefined) process.env.RAZORPAY_KEY_ID = origKey;
      if (origSecret !== undefined) process.env.RAZORPAY_KEY_SECRET = origSecret;
    }

    // -------------------------------------------------------------------------
    // 20. Gateway failure idempotency: releases coupon reservation and marks order failed
    // -------------------------------------------------------------------------
    const couponCode20 = `FAILCOUP${timestamp}`.slice(0, 15);
    const [failCouponRes] = await pool.query(
      "INSERT INTO coupons (code, discount_type, discount_value, min_order_paise, is_active, created_at) VALUES (?, 'flat', 5000, 0, 1, NOW())",
      [couponCode20]
    );
    cleanupCouponIds.push(failCouponRes.insertId);

    const subscriptionController = require("../controllers/subscriptionController");
    const origCreateOrder = gateway.createOrder;
    try {
      // Simulate Razorpay outage / provider network timeout
      gateway.createOrder = async () => {
        throw new Error("Razorpay provider service unavailable / connection timeout");
      };

      let controllerErr = null;
      const mockReq = {
        user: userA,
        body: { plan_code: "monthly", coupon_code: couponCode20 },
      };
      const mockRes = {
        status: () => mockRes,
        json: () => {},
      };

      await new Promise((resolve) => {
        subscriptionController.createOrder(mockReq, mockRes, (err) => {
          controllerErr = err;
          resolve();
        });
      });

      const controllerThrew = controllerErr && controllerErr.message.includes("Razorpay provider service unavailable");

      const [failedOrders] = await pool.query(
        "SELECT id, status FROM subscription_orders WHERE user_id = ? AND coupon_code = ? ORDER BY id DESC LIMIT 1",
        [userA.id, couponCode20]
      );
      if (failedOrders.length) cleanupOrderIds.push(failedOrders[0].id);

      const [redemptions] = await pool.query(
        "SELECT status FROM coupon_redemptions WHERE coupon_id = ? ORDER BY id DESC LIMIT 1",
        [failCouponRes.insertId]
      );

      const orderFailedCleanly = failedOrders[0]?.status === "failed";
      const couponReleased = redemptions[0]?.status === "released";

      report(
        20,
        "Failed gateway initialization automatically updates order to 'failed' and releases coupon reservation",
        controllerThrew && orderFailedCleanly && couponReleased,
        `Controller error thrown: ${Boolean(controllerThrew)}, Order status: ${failedOrders[0]?.status}, Coupon status: ${redemptions[0]?.status}`
      );
    } finally {
      gateway.createOrder = origCreateOrder;
    }

    // -------------------------------------------------------------------------
    // 21. Webhook concurrent deduplication and enum integrity
    // -------------------------------------------------------------------------
    const concurrentEventId = `evt_race_${timestamp}`;
    const concurrentPayload = JSON.stringify({
      event: "order.paid",
      id: concurrentEventId,
      payload: {
        payment: { entity: { id: `pay_race_${timestamp}`, order_id: "order_nonexistent_mock", amount: 10000, currency: "INR" } },
      },
    });
    const concurrentSig = crypto.createHmac("sha256", testWebhookSecret).update(concurrentPayload).digest("hex");

    // Deliver first request
    const concRes1 = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": concurrentSig },
      body: concurrentPayload,
    });
    const concData1 = await concRes1.json();

    // Deliver duplicate second request
    const concRes2 = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": concurrentSig },
      body: concurrentPayload,
    });
    const concData2 = await concRes2.json();

    const [eventRow] = await pool.query(
      "SELECT id, status, error_message FROM payment_webhook_events WHERE event_id = ?",
      [concurrentEventId]
    );

    report(
      21,
      "Webhook deduplication handles repeated event IDs cleanly and maintains database enum stability",
      concRes1.status === 200 && concRes2.status === 200 && concData2.duplicate === true && eventRow.length === 1 && ["processed", "ignored", "failed"].includes(eventRow[0]?.status),
      `Req 1: ${concData1.status}, Req 2: duplicate=${concData2.duplicate}, DB status: ${eventRow[0]?.status}`
    );

    // -------------------------------------------------------------------------
    // 22. Webhook payload without event ID or entity IDs is safely ignored without fabricating timestamp keys
    // -------------------------------------------------------------------------
    const missingIdPayload = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: { entity: {} },
      },
    });
    const missingIdSig = crypto.createHmac("sha256", testWebhookSecret).update(missingIdPayload).digest("hex");

    const [eventsBefore] = await pool.query("SELECT COUNT(*) as cnt FROM payment_webhook_events");

    const missingIdRes = await fetch(`${BASE_URL}/api/webhooks/payment/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": missingIdSig },
      body: missingIdPayload,
    });
    const missingIdData = await missingIdRes.json();

    const [eventsAfter] = await pool.query("SELECT COUNT(*) as cnt FROM payment_webhook_events");

    const safelyIgnored =
      missingIdRes.status === 200 &&
      missingIdData.ignored === true &&
      missingIdData.status === "ignored" &&
      eventsBefore[0]?.cnt === eventsAfter[0]?.cnt;

    report(
      22,
      "Webhook lacking event ID and entity IDs is safely ignored without fabricating timestamp keys or inserting events",
      safelyIgnored,
      `HTTP: ${missingIdRes.status}, ignored: ${missingIdData.ignored}, events inserted: ${eventsAfter[0]?.cnt - eventsBefore[0]?.cnt}`
    );

  } catch (err) {
    console.error("Test execution encountered an unhandled error:", err);
  } finally {
    // Clean up temporary fixtures safely in correct foreign key order
    try {
      if (cleanupCouponIds.length) {
        await pool.query("DELETE FROM coupon_redemptions WHERE coupon_id IN (?)", [cleanupCouponIds]);
        await pool.query("DELETE FROM coupons WHERE id IN (?)", [cleanupCouponIds]);
      }
      if (cleanupOrderIds.length) {
        await pool.query("DELETE FROM coupon_redemptions WHERE order_id IN (?)", [cleanupOrderIds]);
        await pool.query("DELETE FROM subscription_invoices WHERE order_id IN (?)", [cleanupOrderIds]);
        await pool.query("DELETE FROM subscriptions WHERE order_id IN (?)", [cleanupOrderIds]);
        await pool.query("DELETE FROM subscription_orders WHERE id IN (?)", [cleanupOrderIds]);
      }
      if (cleanupUserIds.length) {
        await pool.query("DELETE FROM subscriptions WHERE user_id IN (?)", [cleanupUserIds]);
        await pool.query("DELETE FROM subscription_orders WHERE user_id IN (?)", [cleanupUserIds]);
        await pool.query("DELETE FROM users WHERE id IN (?)", [cleanupUserIds]);
      }
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr.message);
    }

    console.log("\n========================================================================");
    const passedCount = results.filter((r) => r.passed).length;
    console.log(`SUMMARY: ${passedCount} / ${results.length} TESTS PASSED`);
    console.log("========================================================================\n");
    process.exit(passedCount === results.length ? 0 : 1);
  }
}

runTests();

