/**
 * scripts/test_forgot_password_lifecycle.js
 *
 * Comprehensive End-to-End Test Suite for KhataNex Forgot & Reset Password Flow:
 * - Test A: User Registration & Initial Login Verification
 * - Test B: Reset Request API, Generic Response, Zoho Email Delivery, URL Formatting & Token Hashing
 * - Test C: Password Reset Execution, Credential Rotation, Session Revocation & Single-use Token Consumption
 * - Test D: Security Invariants (Expired token, invalid token, missing token, reused token, password mismatch,
 *           rate limiting, anti-enumeration, soft-delete isolation & email reuse isolation)
 * - Test E: Real Zoho Mail Delivery Verification
 */

require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const pool = require("../config/db");
const mailer = require("../utils/mailer");
const emailService = require("../services/emailService");

const PORT = process.env.PORT || 5001;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTestSuite() {
  console.log("================================================================================");
  console.log("🧪 KHATANEX END-TO-END FORGOT & RESET PASSWORD COMPREHENSIVE TEST SUITE");
  console.log(`Backend Target : ${BASE_URL}`);
  console.log(`Frontend Target: ${process.env.FRONTEND_URL || "http://localhost:5173"}`);
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
  const testEmail = `pwd_reset_${ts}@khatanex.test`;
  const initialPassword = "InitialPassword123!";
  const newPassword = "NewSecurePassword456!";

  let testUser = null;
  let testToken = null;
  let extractedResetToken = null;
  let resetRecordId = null;

  let softDeletedUserId = null;
  let reusedEmail = `reuse_pwd_${ts}@khatanex.test`;
  let newActiveUserId = null;

  try {
    // =========================================================================
    // TEST A: REGISTER DUMMY USER AND CONFIRM LOGIN
    // =========================================================================
    console.log("--- TEST A: Registration & Initial Login ---");

    await test("A.1 Register test user and confirm active status", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Password Reset Tester",
          email: testEmail,
          password: initialPassword,
          business_name: "Reset Testing Enterprises",
        },
      });

      if (res.status !== 201 || !res.data?.user?.id || !res.data?.token) {
        throw new Error(`Registration failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      testUser = res.data.user;
      testToken = res.data.token;
    });

    await test("A.2 Confirm initial login works with initial password", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: initialPassword,
        },
      });

      if (res.status !== 200 || !res.data?.token || res.data?.user?.id !== testUser.id) {
        throw new Error(`Login failed with initial password: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    // =========================================================================
    // TEST B: REQUEST PASSWORD RESET & VERIFY EMAIL / TOKEN SECURITY
    // =========================================================================
    console.log("\n--- TEST B: Request Password Reset & Token Verification ---");

    await test("B.1 Request password reset and verify generic response", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: testEmail },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (res.data.message !== "If an eligible account exists for this email, you will receive password reset instructions.") {
        throw new Error(`Generic message mismatch: "${res.data.message}"`);
      }
    });

    await test("B.2 Verify reset email queued in email_outbox with valid local reset link", async () => {
      // Allow async setImmediate queue dispatch to record
      await sleep(500);

      const [outboxRows] = await pool.query(
        "SELECT * FROM email_outbox WHERE recipient_email = ? AND (category = 'system' OR reference_type = 'password_reset') ORDER BY id DESC LIMIT 1",
        [testEmail]
      );

      if (!outboxRows.length) {
        throw new Error(`No outbox record found for recipient: ${testEmail}`);
      }

      const outboxItem = outboxRows[0];
      if (outboxItem.subject !== "Reset Your KhataNex Password") {
        throw new Error(`Outbox subject mismatch: "${outboxItem.subject}"`);
      }

      // Extract the reset link from the HTML/Text body
      const urlMatch = outboxItem.body_html.match(/href="([^"]*\/reset-password\?token=[a-f0-9]+)"/i);
      if (!urlMatch || !urlMatch[1]) {
        throw new Error(`Could not find reset URL in outbox HTML body:\n${outboxItem.body_html}`);
      }

      const resetUrl = urlMatch[1];
      const parsedUrl = new URL(resetUrl);
      const expectedOrigin = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

      if (parsedUrl.origin !== expectedOrigin) {
        throw new Error(`Reset link origin mismatch: expected ${expectedOrigin}, got ${parsedUrl.origin}`);
      }
      if (parsedUrl.pathname !== "/reset-password") {
        throw new Error(`Reset link path mismatch: expected /reset-password, got ${parsedUrl.pathname}`);
      }

      extractedResetToken = parsedUrl.searchParams.get("token");
      if (!extractedResetToken || extractedResetToken.length !== 64) {
        throw new Error(`Invalid token format in link: "${extractedResetToken}" (expected 64 hex chars)`);
      }
    });

    await test("B.3 Verify reset token is stored ONLY as a hash in password_resets", async () => {
      const computedHash = crypto.createHash("sha256").update(extractedResetToken).digest("hex");

      const [rows] = await pool.query(
        "SELECT id, user_id, token_hash, expires_at, consumed_at FROM password_resets WHERE user_id = ? ORDER BY id DESC LIMIT 1",
        [testUser.id]
      );

      if (!rows.length) {
        throw new Error("No password_resets row found for user");
      }

      const record = rows[0];
      resetRecordId = record.id;

      if (record.token_hash !== computedHash) {
        throw new Error(`Token hash mismatch: expected ${computedHash}, got ${record.token_hash}`);
      }

      if (record.consumed_at !== null) {
        throw new Error("Newly created token was prematurely marked consumed");
      }

      const now = new Date();
      const expiresAt = new Date(record.expires_at);
      if (expiresAt <= now) {
        throw new Error(`Expiry timestamp is in the past: ${record.expires_at}`);
      }

      // Verify plaintext token is nowhere in the table
      const [plaintextCheck] = await pool.query(
        "SELECT id FROM password_resets WHERE token_hash LIKE ? OR ip_address LIKE ?",
        [`%${extractedResetToken}%`, `%${extractedResetToken}%`]
      );
      if (plaintextCheck.length > 0) {
        throw new Error("CRITICAL SECURITY FLAW: Plaintext token was found in database columns!");
      }
    });

    await test("B.4 Verify token validity endpoint confirms active token without consuming it", async () => {
      const res = await request({
        method: "GET",
        path: `/api/auth/verify-reset-token?token=${extractedResetToken}`,
      });

      if (res.status !== 200 || !res.data?.valid) {
        throw new Error(`Token verification failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }

      // Check still unconsumed in DB
      const [rows] = await pool.query("SELECT consumed_at FROM password_resets WHERE id = ?", [resetRecordId]);
      if (rows[0].consumed_at !== null) {
        throw new Error("Verification GET route erroneously consumed the token");
      }
    });

    // =========================================================================
    // TEST C: RESET THE PASSWORD & VERIFY NEW LOGIN AND SINGLE-USE
    // =========================================================================
    console.log("\n--- TEST C: Password Reset Execution & Single-Use ---");

    await test("C.1 Submit new password with valid token", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: extractedResetToken,
          password: newPassword,
          confirmPassword: newPassword,
        },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Password reset submission failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("C.2 Verify token is now marked consumed in database", async () => {
      const [rows] = await pool.query("SELECT consumed_at FROM password_resets WHERE id = ?", [resetRecordId]);
      if (!rows[0]?.consumed_at) {
        throw new Error("Reset token was not marked consumed in database");
      }
    });

    await test("C.3 Verify old password no longer works (HTTP 401)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: initialPassword,
        },
      });

      if (res.status !== 401) {
        throw new Error(`Expected HTTP 401 with old password, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("C.4 Verify new password works and returns authenticated session", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: newPassword,
        },
      });

      if (res.status !== 200 || !res.data?.token || res.data?.user?.id !== testUser.id) {
        throw new Error(`Login with new password failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("C.5 Verify prior session JWT is invalidated by password change (HTTP 401)", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${testToken}` },
      });

      if (res.status !== 401) {
        throw new Error(`Expected old JWT to be rejected with HTTP 401, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("C.6 Verify consumed token cannot be reused (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: extractedResetToken,
          password: "AnotherPassword999!",
          confirmPassword: "AnotherPassword999!",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 on reused token, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data?.message?.includes("already been used")) {
        throw new Error(`Unexpected message on reused token: "${res.data?.message}"`);
      }
    });

    // =========================================================================
    // TEST D: SECURITY INVARIANTS & EDGE CASES
    // =========================================================================
    console.log("\n--- TEST D: Security Invariants & Edge Cases ---");

    await test("D.1 Expired token is rejected (HTTP 400)", async () => {
      // Create an expired token directly in DB
      const expiredRawToken = crypto.randomBytes(32).toString("hex");
      const expiredHash = crypto.createHash("sha256").update(expiredRawToken).digest("hex");
      await pool.query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 5 MINUTE))",
        [testUser.id, expiredHash]
      );

      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: expiredRawToken,
          password: "SomePassword123!",
          confirmPassword: "SomePassword123!",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 for expired token, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data?.message?.includes("expired")) {
        throw new Error(`Unexpected message on expired token: "${res.data?.message}"`);
      }
    });

    await test("D.2 Invalid / fabricated token is rejected (HTTP 400)", async () => {
      const fakeToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: fakeToken,
          password: "SomePassword123!",
          confirmPassword: "SomePassword123!",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 for invalid token, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("D.3 Missing token is rejected (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: "",
          password: "SomePassword123!",
          confirmPassword: "SomePassword123!",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 for missing token, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("D.4 Password confirmation mismatch is rejected (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: extractedResetToken || crypto.randomBytes(32).toString("hex"),
          password: "ValidPassword123!",
          confirmPassword: "MismatchPassword123!",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 on password mismatch, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data?.message?.includes("do not match")) {
        throw new Error(`Unexpected error message: "${res.data?.message}"`);
      }
    });

    await test("D.5 Nonexistent email returns generic response without revealing account status", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: `nonexistent_user_${ts}@khatanex.test` },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Expected HTTP 200 generic response, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (res.data.message !== "If an eligible account exists for this email, you will receive password reset instructions.") {
        throw new Error(`Message revealed status: "${res.data.message}"`);
      }
    });

    await test("D.6 Soft-deleted account cannot reset password or regain access", async () => {
      // 1. Create a user and soft-delete it
      const [delUserRes] = await pool.query(
        "INSERT INTO users (name, email, password, role, status, deleted_at, deletion_reason) VALUES (?, ?, ?, 'user', 'deleted', NOW(), 'Testing soft delete isolation')",
        ["Deleted User", `deleted_${ts}@khatanex.test`, await bcrypt.hash("OldPass123!", 10)]
      );
      softDeletedUserId = delUserRes.insertId;

      // 2. Request reset for deleted user's email
      const reqRes = await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: `deleted_${ts}@khatanex.test` },
      });

      // Must return generic message
      if (reqRes.status !== 200) {
        throw new Error(`Expected HTTP 200 generic response, got ${reqRes.status}`);
      }

      // Verify no password_resets row was created for deleted user
      const [prRows] = await pool.query("SELECT id FROM password_resets WHERE user_id = ?", [softDeletedUserId]);
      if (prRows.length > 0) {
        throw new Error("Password reset token was erroneously created for a soft-deleted account");
      }
    });

    await test("D.7 Reused email resets ONLY the current active account (NEW_USER_ID)", async () => {
      // 1. User 1 (Soft deleted)
      const [u1] = await pool.query(
        "INSERT INTO users (name, email, password, role, status, deleted_at) VALUES ('Old Soft Deleted User', ?, ?, 'user', 'deleted', NOW())",
        [reusedEmail, await bcrypt.hash("OldPass123!", 10)]
      );
      const oldU1Id = u1.insertId;

      // 2. User 2 (Active with same email)
      const [u2] = await pool.query(
        "INSERT INTO users (name, email, password, role, status) VALUES ('Active New User', ?, ?, 'user', 'active')",
        [reusedEmail, await bcrypt.hash("OldActivePass123!", 10)]
      );
      newActiveUserId = u2.insertId;

      // 3. Request reset for reused email
      const resetReq = await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: reusedEmail },
      });
      if (resetReq.status !== 200) throw new Error("Failed to request reset for reused email");

      // 4. Verify password_resets row points to newActiveUserId, NEVER oldU1Id
      const [resets] = await pool.query(
        "SELECT user_id, token_hash FROM password_resets WHERE user_id IN (?, ?) ORDER BY id DESC LIMIT 1",
        [oldU1Id, newActiveUserId]
      );
      if (!resets.length || resets[0].user_id !== newActiveUserId) {
        throw new Error(`Reset token targeted wrong account: expected user ${newActiveUserId}, got ${resets[0]?.user_id}`);
      }

      // Clean up helper fixture
      await pool.query("DELETE FROM users WHERE id IN (?, ?)", [oldU1Id, newActiveUserId]);
    });

    await test("D.8 Rate limiting: excessive reset requests from single IP are throttled (HTTP 429)", async () => {
      // Send 7 requests in rapid succession with a designated simulated client IP
      const testClientIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
      let got429 = false;
      for (let i = 0; i < 7; i++) {
        const res = await request({
          method: "POST",
          path: "/api/auth/forgot-password",
          headers: { "x-forwarded-for": testClientIp },
          body: { email: `rate_limit_test_${i}_${ts}@khatanex.test` },
        });
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }

      if (!got429) {
        throw new Error("Rate limiting failed: 7 requests from same IP were not throttled with HTTP 429");
      }
    });

    // =========================================================================
    // TEST E: REAL ZOHO MAIL SMTP CONNECTIVITY & DISPATCH VERIFICATION
    // =========================================================================
    console.log("\n--- TEST E: Zoho Mail Real Delivery Verification ---");

    await test("E.1 Verify Zoho Mail SMTP connection and info@khatanex.in credentials", async () => {
      const verifyRes = await mailer.verifyConnection();
      if (!verifyRes.ok) {
        throw new Error(`Zoho SMTP connection failed: ${verifyRes.error}`);
      }
    });

    await test("E.2 Verify real password reset email delivery dispatch via info@khatanex.in", async () => {
      // Send a test password reset email to info@khatanex.in using existing verified emailService
      const sampleToken = crypto.randomBytes(32).toString("hex");
      const sampleUrl = `http://localhost:5173/reset-password?token=${sampleToken}`;

      const enqueueRes = await emailService.sendPasswordResetEmail({
        to: "info@khatanex.in",
        userName: "KhataNex Security Verification",
        resetUrl: sampleUrl,
        expiresInMinutes: 20,
        resetId: 999999,
      });

      if (!enqueueRes.success) {
        throw new Error(`Failed to enqueue verification email: ${enqueueRes.error}`);
      }

      const outboxId = enqueueRes.outboxId;

      // Wait for background delivery (or attempt delivery if still pending)
      let finalRow = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(500);
        const [rows] = await pool.query("SELECT status, attempts, last_error FROM email_outbox WHERE id = ?", [outboxId]);
        finalRow = rows[0];
        if (finalRow && (finalRow.status === "sent" || finalRow.status === "failed")) {
          break;
        }
        if (attempt === 3 && finalRow?.status === "pending") {
          await emailService.deliverItem(outboxId).catch(() => {});
        }
      }

      if (finalRow?.status !== "sent") {
        throw new Error(`Expected outbox status 'sent', got '${finalRow?.status}': ${finalRow?.last_error}`);
      }

      // Clean up outbox test record
      await pool.query("DELETE FROM email_outbox WHERE id = ?", [outboxId]);
    });

  } catch (err) {
    console.error("💥 Unhandled Test Suite Exception:", err);
  } finally {
    // Clean up test fixtures safely
    try {
      if (testUser) {
        await pool.query("DELETE FROM password_resets WHERE user_id = ?", [testUser.id]);
        await pool.query("DELETE FROM email_outbox WHERE recipient_email = ?", [testEmail]);
        await pool.query("DELETE FROM users WHERE id = ?", [testUser.id]);
      }
      if (softDeletedUserId) {
        await pool.query("DELETE FROM users WHERE id = ?", [softDeletedUserId]);
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
