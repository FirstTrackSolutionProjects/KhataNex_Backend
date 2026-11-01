/**
 * ============================================================================
 * KHATANEX END-TO-END TWO-FACTOR AUTHENTICATION (2FA) LIFECYCLE TEST SUITE
 * ============================================================================
 *
 * Verifies:
 * 1. Setup and activation flow (QR code, manual key, code verification)
 * 2. Rejection of invalid codes during setup
 * 3. Secret encrypted at rest with AES-256-GCM
 * 4. Recovery codes generation, secure storage (hashes only), single-use consumption
 * 5. Password-only login returns challenge token (mfa_required=true, no session token)
 * 6. Protection of protected routes against challenge tokens
 * 7. Verification of valid TOTP code issues full session JWT
 * 8. Verification of single-use recovery code login and strict reuse prevention
 * 9. Invariant: Forgot-password password reset does NOT bypass or disable 2FA
 * 10. Re-authentication requirement when disabling 2FA
 * 11. Email notifications for 2FA enable, disable, and reset
 * 12. Clean login without 2FA after disabling
 */

const http = require("http");
const crypto = require("crypto");
const { generateSync } = require("otplib");
const pool = require("../config/db");
const { decryptSecret, hashRecoveryCode } = require("../utils/twoFactorCrypto");

const API_BASE = "http://127.0.0.1:5001";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request({ method = "GET", path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (bodyStr) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => (rawData += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(rawData);
          } catch (_) {
            parsed = rawData;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: parsed,
          });
        });
      }
    );

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runSuite() {
  console.log("================================================================================");
  console.log("🧪 KHATANEX END-TO-END TWO-FACTOR AUTHENTICATION (2FA) TEST SUITE");
  console.log("Backend Target:", API_BASE);
  console.log("================================================================================\n");

  const ts = Date.now();
  const testEmail = `2fa_user_${ts}@khatanex.test`;
  const initialPassword = "StrongPassword123!";
  const newPassword = "BrandNewPassword999!";

  let testUser = null;
  let testToken = null;
  let setupSecret = null;
  let issuedRecoveryCodes = [];

  const results = [];
  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, pass: true });
      console.log(`  ✅ PASS: ${name}`);
    } catch (err) {
      results.push({ name, pass: false, error: err.message });
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Reason: ${err.message}\n`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: User Registration & Initial Login (Pre-2FA)
    // -------------------------------------------------------------------------
    console.log("--- TEST 1: User Registration & Pre-2FA Status ---");

    await test("1.1 Register disposable user and confirm active status", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/register",
        body: {
          name: "Two-Factor Verification Tester",
          email: testEmail,
          password: initialPassword,
          business_name: "2FA Testing Inc.",
        },
      });

      if (res.status !== 201 || !res.data?.token || !res.data?.user?.id) {
        throw new Error(`Registration failed: ${res.status}: ${JSON.stringify(res.data)}`);
      }
      testUser = res.data.user;
      testToken = res.data.token;

      if (testUser.two_factor_enabled !== false) {
        throw new Error("two_factor_enabled should be false by default.");
      }
    });

    await test("1.2 Check initial 2FA status endpoint returns false", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/2fa/status",
        headers: { Authorization: `Bearer ${testToken}` },
      });

      if (res.status !== 200 || res.data?.two_factor_enabled !== false) {
        throw new Error(`Expected two_factor_enabled=false, got: ${JSON.stringify(res.data)}`);
      }
      if (res.data.remaining_recovery_codes !== 0) {
        throw new Error(`Expected 0 recovery codes, got: ${res.data.remaining_recovery_codes}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 2: Setup Flow (Initiation, QR code, Encryption, Verification)
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 2: Setup Flow & Code Verification ---");

    await test("2.1 Initiate setup: returns QR code and manual entry key", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/setup",
        headers: { Authorization: `Bearer ${testToken}` },
      });

      if (res.status !== 200 || !res.data?.qr_code || !res.data?.manual_entry_key) {
        throw new Error(`Setup failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (!res.data.qr_code.startsWith("data:image/png;base64,")) {
        throw new Error("qr_code is not a valid PNG data URL.");
      }
      setupSecret = res.data.manual_entry_key;

      // Verify secret is encrypted in database, not stored plaintext
      const [rows] = await pool.query(
        "SELECT two_factor_temp_secret FROM users WHERE id = ?",
        [testUser.id]
      );
      const tempSecretInDb = rows[0]?.two_factor_temp_secret;
      if (!tempSecretInDb || !tempSecretInDb.includes(":")) {
        throw new Error("Temporary secret is not properly AES-256-GCM encrypted in DB.");
      }
      if (tempSecretInDb === setupSecret) {
        throw new Error("CRITICAL: Secret is stored in plaintext in the database!");
      }

      const decrypted = decryptSecret(tempSecretInDb);
      if (decrypted !== setupSecret) {
        throw new Error("Decrypted temporary secret does not match setup secret.");
      }
    });

    await test("2.2 Reject invalid 6-digit verification code (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/verify-setup",
        headers: { Authorization: `Bearer ${testToken}` },
        body: { code: "000000" },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 on invalid code, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("2.3 Submit valid TOTP code: activates 2FA and returns 10 recovery codes", async () => {
      const validCode = generateSync({ secret: setupSecret });
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/verify-setup",
        headers: { Authorization: `Bearer ${testToken}` },
        body: { code: validCode },
      });

      if (res.status !== 200 || !res.data?.success || !Array.isArray(res.data?.recovery_codes)) {
        throw new Error(`Activation failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (res.data.recovery_codes.length !== 10) {
        throw new Error(`Expected 10 recovery codes, got ${res.data.recovery_codes.length}`);
      }
      issuedRecoveryCodes = res.data.recovery_codes;

      // Verify database state
      const [rows] = await pool.query(
        "SELECT two_factor_enabled, two_factor_secret, two_factor_temp_secret, two_factor_enabled_at FROM users WHERE id = ?",
        [testUser.id]
      );
      const u = rows[0];
      if (u.two_factor_enabled !== 1) throw new Error("two_factor_enabled is not 1 in DB.");
      if (!u.two_factor_secret || u.two_factor_secret.includes(setupSecret)) {
        throw new Error("two_factor_secret not securely encrypted in DB.");
      }
      if (u.two_factor_temp_secret !== null) throw new Error("two_factor_temp_secret was not cleared.");
      if (!u.two_factor_enabled_at) throw new Error("two_factor_enabled_at timestamp is null.");

      // Verify recovery codes are stored ONLY as hashes
      const [codeRows] = await pool.query(
        "SELECT code_hash FROM user_recovery_codes WHERE user_id = ?",
        [testUser.id]
      );
      if (codeRows.length !== 10) throw new Error(`Expected 10 DB rows in user_recovery_codes, got ${codeRows.length}`);
      for (const row of codeRows) {
        if (issuedRecoveryCodes.includes(row.code_hash)) {
          throw new Error("CRITICAL: Recovery code stored in plaintext!");
        }
      }

      // Verify confirmation email was queued
      await sleep(400);
      const [emailRows] = await pool.query(
        "SELECT * FROM email_outbox WHERE recipient_email = ? AND reference_type = 'two_factor_enabled' ORDER BY id DESC LIMIT 1",
        [testEmail]
      );
      if (!emailRows.length) {
        throw new Error("No 2FA enabled notification email was queued in outbox.");
      }
    });

    await test("2.4 Confirm 2FA status endpoint returns active and 10 recovery codes remaining", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/2fa/status",
        headers: { Authorization: `Bearer ${testToken}` },
      });

      if (res.status !== 200 || res.data?.two_factor_enabled !== true || res.data?.remaining_recovery_codes !== 10) {
        throw new Error(`Unexpected status response: ${JSON.stringify(res.data)}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 3: Login Protection with Two-Factor Challenge
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 3: Subsequent Login MFA Challenge & Session Issuance ---");

    let activeMfaToken = null;

    await test("3.1 Password-only login returns challenge token (mfa_required=true, no session token)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: initialPassword,
        },
      });

      if (res.status !== 200 || !res.data?.mfa_required || !res.data?.mfa_token) {
        throw new Error(`Expected MFA challenge, got: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (res.data.token) {
        throw new Error("CRITICAL: Full session token was returned before 2FA verification!");
      }
      activeMfaToken = res.data.mfa_token;
    });

    await test("3.2 Attempting to access protected API (/api/auth/me) with mfa_token is rejected (HTTP 401)", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${activeMfaToken}` },
      });

      if (res.status !== 401) {
        throw new Error(`Expected HTTP 401 on mfa_token usage, got HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("3.3 Submitting invalid code to /api/auth/login/2fa is rejected (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login/2fa",
        body: {
          mfa_token: activeMfaToken,
          code: "112233",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("3.4 Submitting valid TOTP code to /api/auth/login/2fa grants full session JWT", async () => {
      const validCode = generateSync({ secret: setupSecret });
      const res = await request({
        method: "POST",
        path: "/api/auth/login/2fa",
        body: {
          mfa_token: activeMfaToken,
          code: validCode,
        },
      });

      if (res.status !== 200 || !res.data?.token || !res.data?.user?.id) {
        throw new Error(`2FA login failed: HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      }
      if (res.data.user.two_factor_enabled !== true) {
        throw new Error("User object should reflect two_factor_enabled=true.");
      }

      // Verify token can now access /api/auth/me
      const meRes = await request({
        method: "GET",
        path: "/api/auth/me",
        headers: { Authorization: `Bearer ${res.data.token}` },
      });
      if (meRes.status !== 200 || meRes.data?.user?.id !== testUser.id) {
        throw new Error("Full session token failed to authenticate to /api/auth/me.");
      }
      testToken = res.data.token;
    });

    // -------------------------------------------------------------------------
    // TEST 4: Single-Use Recovery Code Login
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 4: Single-Use Recovery Code Login ---");

    let secondMfaToken = null;
    const testRecoveryCode = issuedRecoveryCodes[0];

    await test("4.1 Log in with primary password to acquire fresh MFA challenge token", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: initialPassword,
        },
      });

      if (res.status !== 200 || !res.data?.mfa_token) {
        throw new Error(`MFA challenge failed: ${JSON.stringify(res.data)}`);
      }
      secondMfaToken = res.data.mfa_token;
    });

    await test("4.2 Complete login using single-use backup recovery code", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login/2fa",
        body: {
          mfa_token: secondMfaToken,
          recovery_code: testRecoveryCode,
        },
      });

      if (res.status !== 200 || !res.data?.token || res.data?.used_recovery_code !== true) {
        throw new Error(`Recovery code login failed: ${res.status}: ${JSON.stringify(res.data)}`);
      }
      testToken = res.data.token;

      // Verify recovery code was marked consumed in DB
      const expectedHash = hashRecoveryCode(testRecoveryCode);
      const [rows] = await pool.query(
        "SELECT consumed_at FROM user_recovery_codes WHERE user_id = ? AND code_hash = ?",
        [testUser.id, expectedHash]
      );
      if (!rows[0]?.consumed_at) {
        throw new Error("Recovery code was not marked consumed in database.");
      }
    });

    await test("4.3 Attempting to reuse consumed recovery code is strictly rejected (HTTP 400)", async () => {
      // Get another challenge token
      const chalRes = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: initialPassword,
        },
      });
      const thirdMfaToken = chalRes.data.mfa_token;

      const res = await request({
        method: "POST",
        path: "/api/auth/login/2fa",
        body: {
          mfa_token: thirdMfaToken,
          recovery_code: testRecoveryCode,
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 on reused recovery code, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("4.4 Confirm remaining recovery codes count decremented to 9", async () => {
      const res = await request({
        method: "GET",
        path: "/api/auth/2fa/status",
        headers: { Authorization: `Bearer ${testToken}` },
      });

      if (res.status !== 200 || res.data?.remaining_recovery_codes !== 9) {
        throw new Error(`Expected 9 remaining recovery codes, got: ${res.data?.remaining_recovery_codes}`);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 5: Security Invariant: Forgot Password Does NOT Bypass 2FA
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 5: Security Invariant: Forgot Password Does NOT Bypass 2FA ---");

    await test("5.1 Request password reset, retrieve token from outbox, and reset password", async () => {
      // 1. Request reset
      await request({
        method: "POST",
        path: "/api/auth/forgot-password",
        body: { email: testEmail },
      });

      await sleep(400);

      const [outboxRows] = await pool.query(
        "SELECT body_html FROM email_outbox WHERE recipient_email = ? AND reference_type = 'password_reset' ORDER BY id DESC LIMIT 1",
        [testEmail]
      );
      const urlMatch = outboxRows[0]?.body_html?.match(/token=([a-f0-9]+)/i);
      if (!urlMatch || !urlMatch[1]) {
        throw new Error("Could not extract reset token from outbox.");
      }
      const rawResetToken = urlMatch[1];

      // 2. Perform reset
      const resetRes = await request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: {
          token: rawResetToken,
          password: newPassword,
          confirmPassword: newPassword,
        },
      });

      if (resetRes.status !== 200 || !resetRes.data?.success) {
        throw new Error(`Password reset failed: ${JSON.stringify(resetRes.data)}`);
      }
    });

    await test("5.2 Login with NEW password still requires 2FA challenge (No 2FA Bypass)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: newPassword,
        },
      });

      if (res.status !== 200 || !res.data?.mfa_required || !res.data?.mfa_token) {
        throw new Error(`SECURITY VULNERABILITY: Password reset bypassed 2FA! Response: ${JSON.stringify(res.data)}`);
      }

      // Complete 2FA login with authenticator
      const validCode = generateSync({ secret: setupSecret });
      const verifyRes = await request({
        method: "POST",
        path: "/api/auth/login/2fa",
        body: {
          mfa_token: res.data.mfa_token,
          code: validCode,
        },
      });

      if (verifyRes.status !== 200 || !verifyRes.data?.token) {
        throw new Error(`Login after password reset failed: ${JSON.stringify(verifyRes.data)}`);
      }
      testToken = verifyRes.data.token;
    });

    // -------------------------------------------------------------------------
    // TEST 6: Disable Flow with Re-Authentication & Normal Login
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 6: Disable 2FA with Re-Authentication & Normal Login ---");

    await test("6.1 Reject disabling 2FA when incorrect password is provided (HTTP 401)", async () => {
      const validCode = generateSync({ secret: setupSecret });
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/disable",
        headers: { Authorization: `Bearer ${testToken}` },
        body: {
          password: "WrongPassword999!",
          code: validCode,
        },
      });

      if (res.status !== 401) {
        throw new Error(`Expected HTTP 401 on wrong password, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("6.2 Reject disabling 2FA when password is correct but code is invalid (HTTP 400)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/disable",
        headers: { Authorization: `Bearer ${testToken}` },
        body: {
          password: newPassword,
          code: "000000",
        },
      });

      if (res.status !== 400) {
        throw new Error(`Expected HTTP 400 on wrong code, got ${res.status}: ${JSON.stringify(res.data)}`);
      }
    });

    await test("6.3 Disable 2FA with valid password and valid TOTP code", async () => {
      const validCode = generateSync({ secret: setupSecret });
      const res = await request({
        method: "POST",
        path: "/api/auth/2fa/disable",
        headers: { Authorization: `Bearer ${testToken}` },
        body: {
          password: newPassword,
          code: validCode,
        },
      });

      if (res.status !== 200 || !res.data?.success) {
        throw new Error(`Disable failed: ${JSON.stringify(res.data)}`);
      }

      // Verify DB columns cleared
      const [rows] = await pool.query(
        "SELECT two_factor_enabled, two_factor_secret, two_factor_enabled_at FROM users WHERE id = ?",
        [testUser.id]
      );
      if (rows[0].two_factor_enabled !== 0 || rows[0].two_factor_secret !== null) {
        throw new Error("2FA columns not cleared in DB.");
      }

      // Verify recovery codes deleted
      const [codes] = await pool.query("SELECT COUNT(*) AS cnt FROM user_recovery_codes WHERE user_id = ?", [testUser.id]);
      if (codes[0].cnt !== 0) {
        throw new Error("Recovery codes were not wiped on disable.");
      }

      // Verify security alert email queued
      await sleep(400);
      const [emailRows] = await pool.query(
        "SELECT * FROM email_outbox WHERE recipient_email = ? AND reference_type = 'two_factor_disabled' ORDER BY id DESC LIMIT 1",
        [testEmail]
      );
      if (!emailRows.length) {
        throw new Error("No 2FA disabled security email was queued in outbox.");
      }
    });

    await test("6.4 Verify normal login after disabling 2FA (issues immediate session token)", async () => {
      const res = await request({
        method: "POST",
        path: "/api/auth/login",
        body: {
          email: testEmail,
          password: newPassword,
        },
      });

      if (res.status !== 200 || !res.data?.token || res.data?.mfa_required) {
        throw new Error(`Expected direct session token without MFA challenge: ${JSON.stringify(res.data)}`);
      }
      if (res.data.user.two_factor_enabled !== false) {
        throw new Error("User object should report two_factor_enabled=false.");
      }
    });

  } catch (err) {
    console.error("💥 Unhandled Test Suite Exception:", err);
  } finally {
    // Clean up test fixtures
    try {
      if (testUser) {
        await pool.query("DELETE FROM user_recovery_codes WHERE user_id = ?", [testUser.id]);
        await pool.query("DELETE FROM password_resets WHERE user_id = ?", [testUser.id]);
        await pool.query("DELETE FROM email_outbox WHERE recipient_email = ?", [testEmail]);
        await pool.query("DELETE FROM users WHERE id = ?", [testUser.id]);
        console.log("\n🧹 Test fixtures cleaned up successfully.");
      }
    } catch (cleanupErr) {
      console.warn("⚠️ Fixture cleanup warning:", cleanupErr.message);
    }
  }

  const passedCount = results.filter((r) => r.pass).length;
  const totalCount = results.length;
  console.log("\n================================================================================");
  console.log("📊 2FA TEST EXECUTION SUMMARY");
  console.log("================================================================================");
  console.log(`Passed: ${passedCount}/${totalCount} (${Math.round((passedCount / totalCount) * 100)}%)\n`);

  results.forEach((r, idx) => {
    console.log(`  ${idx + 1}. [${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  });

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

