const pool = require("../config/db");
const {
  evaluateCoupon,
  evaluatePromotions,
  priceOrder,
  getSubscriptionSettings,
} = require("../utils/subscriptionLogic");
const assert = require("assert");

async function runTests() {
  console.log("=================================================");
  console.log("STARTING SUBSCRIPTION PRODUCTION READINESS AUDIT");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // 1. COUPON CALCULATIONS & RUPEE/PAISE INTEGRITY
  console.log("--- 1. COUPON CALCULATIONS & RUPEE/PAISE INTEGRITY ---");
  await testAsync("Flat Coupon of ₹120 evaluates to exactly 12,000 paise discount (not ₹1.20)", async () => {
    await pool.query("DELETE FROM coupons WHERE code = 'TESTFLAT120'");
    const [ins] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, min_order_paise, is_active)
       VALUES ('TESTFLAT120', 'Flat 120 Off', 'flat', 12000, 0, 1)`
    );

    const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };
    const res = await evaluateCoupon("TESTFLAT120", plan, 12900, null);
    assert.strictEqual(res.discountPaise, 12000, `Expected 12000 paise discount, got ${res.discountPaise}`);

    await pool.query("DELETE FROM coupons WHERE id = ?", [ins.insertId]);
  });

  await testAsync("Percentage Coupon of 20% on ₹129 (12,900 paise) evaluates to 2,580 paise", async () => {
    await pool.query("DELETE FROM coupons WHERE code = 'TESTSAVE20'");
    const [ins] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, min_order_paise, is_active)
       VALUES ('TESTSAVE20', 'Save 20%', 'percent', 20, 0, 1)`
    );

    const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };
    const res = await evaluateCoupon("TESTSAVE20", plan, 12900, null);
    assert.strictEqual(res.discountPaise, 2580, `Expected 2580 paise, got ${res.discountPaise}`);

    await pool.query("DELETE FROM coupons WHERE id = ?", [ins.insertId]);
  });

  await testAsync("Coupon Max Cap enforces maximum discount threshold", async () => {
    await pool.query("DELETE FROM coupons WHERE code = 'TESTCAP'");
    const [ins] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, max_discount_paise, is_active)
       VALUES ('TESTCAP', 'Capped 50%', 'percent', 50, 1000, 1)`
    );

    const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };
    const res = await evaluateCoupon("TESTCAP", plan, 12900, null);
    assert.strictEqual(res.discountPaise, 1000, `Expected 1000 paise cap, got ${res.discountPaise}`);

    await pool.query("DELETE FROM coupons WHERE id = ?", [ins.insertId]);
  });

  await testAsync("Coupon Min Order requirement rejects orders below minimum", async () => {
    await pool.query("DELETE FROM coupons WHERE code = 'TESTMINORDER'");
    const [ins] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, min_order_paise, is_active)
       VALUES ('TESTMINORDER', 'Min Order', 'percent', 10, 50000, 1)`
    );

    const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };
    let threw = false;
    try {
      await evaluateCoupon("TESTMINORDER", plan, 12900, null);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("Minimum purchase"), `Unexpected message: ${err.message}`);
    }
    assert.ok(threw, "Expected error on order below minimum");

    await pool.query("DELETE FROM coupons WHERE id = ?", [ins.insertId]);
  });

  // 2. TIME-BOUNDED PROMOTIONS & NON-STACKING PRECEDENCE
  console.log("\n--- 2. TIME-BOUNDED PROMOTIONS & NON-STACKING PRECEDENCE ---");
  await testAsync("Active promotion matches plan and computes promotional discount", async () => {
    const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };

    await pool.query("DELETE FROM promotions WHERE code = 'TESTFLASH'");
    const [ins] = await pool.query(
      `INSERT INTO promotions 
         (name, code, discount_type, discount_value, starts_at, ends_at, user_eligibility, is_active)
       VALUES ('Flash Sale 30%', 'TESTFLASH', 'percent', 30, NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 2 HOUR, 'all', 1)`
    );

    const promoRes = await evaluatePromotions({ plan, basePaise: 12900, userId: null, promoCode: "TESTFLASH" });
    assert.ok(promoRes, "Expected promotion to match");
    assert.strictEqual(promoRes.discountPaise, 3870, `Expected 3870 paise discount (30% of 12900), got ${promoRes.discountPaise}`);
    assert.strictEqual(promoRes.canStackWithCoupon, false);

    await pool.query("DELETE FROM promotions WHERE id = ?", [ins.insertId]);
  });

  await testAsync("Non-stacking precedence: Higher discount wins when promo is non-stackable", async () => {
    const plan = { id: 1, code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };

    // Create promo that gives 5000 paise discount
    await pool.query("DELETE FROM promotions WHERE code = 'BIGPROMO'");
    const [pIns] = await pool.query(
      `INSERT INTO promotions 
         (name, code, discount_type, discount_value, starts_at, ends_at, user_eligibility, can_stack_with_coupon, is_active)
       VALUES ('Big Promo 5000', 'BIGPROMO', 'flat', 5000, NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 2 HOUR, 'all', 0, 1)`
    );

    // Create coupon that gives 2000 paise discount
    await pool.query("DELETE FROM coupons WHERE code = 'SMALLCPN'");
    const [cIns] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, is_active)
       VALUES ('SMALLCPN', 'Small Coupon', 'flat', 2000, 1)`
    );

    const priced = await priceOrder({
      plan,
      isIntroductoryEligible: true,
      couponCode: "SMALLCPN",
      promoCode: "BIGPROMO",
      userId: null,
    });

    assert.strictEqual(priced.promotionId, pIns.insertId, "Expected promotion to win");
    assert.strictEqual(priced.promotionDiscountPaise, 5000);
    assert.strictEqual(priced.couponDiscountPaise, 0, "Lower coupon should be suppressed when non-stackable");
    assert.strictEqual(priced.totalPaise, 12900 - 5000);

    await pool.query("DELETE FROM promotions WHERE id = ?", [pIns.insertId]);
    await pool.query("DELETE FROM coupons WHERE id = ?", [cIns.insertId]);
  });

  await testAsync("Non-stacking precedence: Coupon wins when coupon gives higher discount than non-stackable promo", async () => {
    const plan = { id: 1, code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };

    // Create promo that gives 1000 paise discount
    await pool.query("DELETE FROM promotions WHERE code = 'SMALLPROMO'");
    const [pIns] = await pool.query(
      `INSERT INTO promotions 
         (name, code, discount_type, discount_value, starts_at, ends_at, user_eligibility, can_stack_with_coupon, is_active)
       VALUES ('Small Promo 1000', 'SMALLPROMO', 'flat', 1000, NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 2 HOUR, 'all', 0, 1)`
    );

    // Create coupon that gives 4000 paise discount
    await pool.query("DELETE FROM coupons WHERE code = 'BIGCPN'");
    const [cIns] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, is_active)
       VALUES ('BIGCPN', 'Big Coupon', 'flat', 4000, 1)`
    );

    const priced = await priceOrder({
      plan,
      isIntroductoryEligible: true,
      couponCode: "BIGCPN",
      promoCode: "SMALLPROMO",
      userId: null,
    });

    assert.strictEqual(priced.promotionId, null, "Lower promo should be discarded");
    assert.strictEqual(priced.promotionDiscountPaise, 0);
    assert.strictEqual(priced.couponDiscountPaise, 4000, "Higher coupon must win");
    assert.strictEqual(priced.totalPaise, 12900 - 4000);

    await pool.query("DELETE FROM promotions WHERE id = ?", [pIns.insertId]);
    await pool.query("DELETE FROM coupons WHERE id = ?", [cIns.insertId]);
  });

  // 3. TAX RECONCILIATION TO THE EXACT PAISA
  console.log("\n--- 3. TAX RECONCILIATION TO THE EXACT PAISA ---");
  await testAsync("Taxable amount + tax amount strictly equals total order amount (Tax Inclusive)", async () => {
    const [plans] = await pool.query("SELECT * FROM subscription_plans WHERE code = 'yearly'");
    const plan = plans[0] || { id: 3, code: "yearly", price_paise: 289900, introductory_price_paise: 129900 };

    const priced = await priceOrder({
      plan,
      isIntroductoryEligible: true,
      userId: null,
    });

    assert.strictEqual(priced.totalPaise, plan.introductory_price_paise || 129900);
    assert.strictEqual(
      priced.taxablePaise + priced.taxPaise,
      priced.totalPaise,
      `Tax reconciliation mismatch: ${priced.taxablePaise} + ${priced.taxPaise} != ${priced.totalPaise}`
    );
  });

  // 4. SOFT-DELETE & AUDIT PRESERVATION
  console.log("\n--- 4. SOFT-DELETE & AUDIT PRESERVATION ---");
  await testAsync("Soft-deleted coupon cannot be redeemed or evaluated", async () => {
    await pool.query("DELETE FROM coupons WHERE code = 'TESTDELCPN'");
    const [ins] = await pool.query(
      `INSERT INTO coupons (code, name, discount_type, discount_value, is_active, deleted_at)
       VALUES ('TESTDELCPN', 'Deleted Coupon', 'percent', 25, 0, NOW())`
    );

    const [rows] = await pool.query("SELECT * FROM coupons WHERE code = 'TESTDELCPN' AND deleted_at IS NULL");
    assert.strictEqual(rows.length, 0, "Soft-deleted coupon must not appear in active queries");

    let threw = false;
    try {
      const plan = { code: "monthly", price_paise: 24900, introductory_price_paise: 12900 };
      await evaluateCoupon("TESTDELCPN", plan, 12900, null);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("invalid, inactive, or expired"));
    }
    assert.ok(threw, "Expected error trying to evaluate soft-deleted coupon");

    await pool.query("DELETE FROM coupons WHERE id = ?", [ins.insertId]);
  });

  // 5. SUPERADMIN USER LOOKUP & SUBSCRIPTION COLUMN
  console.log("\n--- 5. SUPERADMIN USER LOOKUP & SUBSCRIPTION COLUMN ---");
  await testAsync("Multi-field user lookup queries execute cleanly with subscription join", async () => {
    const [anyUser] = await pool.query("SELECT id, name, email FROM users WHERE role = 'user' LIMIT 1");
    if (anyUser.length > 0) {
      const u = anyUser[0];
      const [resSearch] = await pool.query(
        `SELECT u.id, u.name, u.email, s.ends_at, p.name AS plan_name
         FROM users u
         LEFT JOIN (
           SELECT s1.user_id, s1.plan_id, s1.ends_at
           FROM subscriptions s1
           JOIN (
             SELECT user_id, MAX(ends_at) AS max_end
             FROM subscriptions
             GROUP BY user_id
           ) s2 ON s1.user_id = s2.user_id AND s1.ends_at = s2.max_end
         ) s ON s.user_id = u.id
         LEFT JOIN subscription_plans p ON s.plan_id = p.id
         WHERE u.id = ?`,
        [u.id]
      );
      assert.strictEqual(resSearch.length, 1);
      assert.strictEqual(resSearch[0].id, u.id);
    }
  });

  // 6. SUBSCRIPTION ALERTS
  await testAsync("Subscription alerts queries execute cleanly without syntax errors", async () => {
    const [expiringToday] = await pool.query(
      `SELECT u.id, u.name, s.ends_at
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.ends_at > NOW() AND DATE(s.ends_at) = CURDATE()`
    );
    assert.ok(Array.isArray(expiringToday));

    const [expiringSoon] = await pool.query(
      `SELECT u.id, u.name, s.ends_at, DATEDIFF(s.ends_at, NOW()) AS days_left
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.ends_at > NOW() AND DATE(s.ends_at) > CURDATE() AND s.ends_at <= NOW() + INTERVAL 7 DAY`
    );
    assert.ok(Array.isArray(expiringSoon));
  });

  // 7. DYNAMIC SUBSCRIPTION ENFORCEMENT
  console.log("\n--- 6. DYNAMIC SUBSCRIPTION ENFORCEMENT ---");
  await testAsync("getSubscriptionSettings retrieves settings from database with caching", async () => {
    const settings = await getSubscriptionSettings();
    assert.ok(settings, "Expected subscription_settings row");
    assert.ok(["on", "off"].includes(settings.subscription_enforcement));
    assert.ok(typeof settings.tax_percent === "number");
  });

  console.log("\n=================================================");
  console.log(`AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("FATAL ERROR IN TEST RUNNER:", err);
  process.exit(1);
});

