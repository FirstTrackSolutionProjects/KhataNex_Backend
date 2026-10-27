const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { relativeUploadPath } = require("../utils/upload");
const ApiError = require("../utils/ApiError");
const emailService = require("../services/emailService");
const {
  encryptSecret,
  decryptSecret,
  generateTOTPSecret,
  formatManualKey,
  getTOTPUri,
  generateQRCode,
  verifyTOTPCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} = require("../utils/twoFactorCrypto");

const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, employee_role_type: user.employee_role_type },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

const parseJsonField = (val) => {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
};

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  secondary_phone: u.secondary_phone,

  business_name: u.business_name,
  business_type: u.business_type,
  gstin: u.gstin,
  pan: u.pan,
  website: u.website,
  logo_path: u.logo_path,
  signature_path: u.signature_path,

  address: u.address,
  address_line1: u.address_line1,
  address_line2: u.address_line2,
  city: u.city,
  state: u.state,
  pincode: u.pincode,
  country: u.country,

  currency: u.currency,
  tax_type: u.tax_type,
  tcs_enabled: u.tcs_enabled,
  tds_enabled: u.tds_enabled,
  payment_terms: u.payment_terms,
  watermark_enabled:
    u.watermark_enabled !== undefined && u.watermark_enabled !== null
      ? Boolean(u.watermark_enabled === 1 || u.watermark_enabled === true || u.watermark_enabled === "1")
      : true,

  role: u.role,
  employee_role_type: u.employee_role_type,
  employee_title: u.employee_title,
  employee_code: u.employee_code,
  profile_photo_path: u.profile_photo_path,
  assigned_modules: parseJsonField(u.assigned_modules),
  permissions: parseJsonField(u.permissions),
  created_by_admin: u.created_by_admin,
  status: u.status,
  two_factor_enabled: Boolean(u.two_factor_enabled),
  created_at: u.created_at,
});

// POST /api/auth/register
// Everyone who self-registers becomes a plain 'user'. Only name/email/password
// have any real requirement (email+password because a login literally can't
// work without them) — everything else is optional, matching the signup form.
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone, business_name, address } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "email and password are required to create a login.");
  }

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length) throw new ApiError(409, "An account with this email already exists.");

  const hashed = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    `INSERT INTO users (name, email, phone, business_name, address, password, role)
     VALUES (?, ?, ?, ?, ?, ?, 'user')`,
    [name || null, email, phone || null, business_name || null, address || null, hashed]
  );

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  const user = rows[0];
  const token = signToken(user);

  res.status(201).json({ success: true, token, user: publicUser(user) });
});

// POST /api/auth/login
// Used by ALL roles (user, employee, superadmin) — the response's `role`
// tells the frontend which dashboard to send them to.
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, "email and password are required.");

  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
  const user = rows[0];
  if (!user) throw new ApiError(401, "Invalid email or password.");

  if (user.status !== "active") {
    throw new ApiError(403, "Your account has been deactivated. Contact the super admin.");
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) throw new ApiError(401, "Invalid email or password.");

  // If Two-Step Verification is active, require authenticator verification before issuing full session
  if (user.two_factor_enabled) {
    const mfaToken = jwt.sign(
      {
        userId: user.id,
        purpose: "2fa_pending",
        token_version: user.token_version !== undefined ? user.token_version : 1,
      },
      process.env.JWT_SECRET,
      { expiresIn: "5m" }
    );
    return res.json({
      success: true,
      mfa_required: true,
      mfa_token: mfaToken,
      message: "Two-step verification required. Please enter the code from your authenticator app.",
    });
  }

  await pool.query(
    "UPDATE users SET last_login_at = NOW(), last_active_at = NOW() WHERE id = ?",
    [user.id]
  );

  user.last_login_at = new Date();
  user.last_active_at = new Date();

  const token = signToken(user);
  res.json({ success: true, token, user: publicUser(user) });
});

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
  res.json({ success: true, user: publicUser(rows[0]) });
});

// PATCH /api/auth/me
// Lets the logged-in user (any role) update their own profile — used by the
// Profile page. Nothing is required; only fields sent are changed.
const updateMe = asyncHandler(async (req, res) => {
  const {
    name,
    phone,
    business_name,
    business_type,
    gstin,
    pan,
    website,
    address,
    address_line1,
    address_line2,
    city,
    state,
    pincode,
    country,
    currency,
    tax_type,
    tcs_enabled,
    tds_enabled,
    payment_terms,
    watermark_enabled,
    remove_watermark,
    show_watermark,
  } = req.body;

  let effectiveWatermark = null;
  if (watermark_enabled !== undefined && watermark_enabled !== null) {
    effectiveWatermark = watermark_enabled ? 1 : 0;
  } else if (remove_watermark !== undefined && remove_watermark !== null) {
    effectiveWatermark = remove_watermark ? 0 : 1;
  } else if (show_watermark !== undefined && show_watermark !== null) {
    effectiveWatermark = show_watermark ? 1 : 0;
  }

  await pool.query(
    `UPDATE users SET
   name = COALESCE(?, name),
   phone = COALESCE(?, phone),
   business_name = COALESCE(?, business_name),
   business_type = COALESCE(?, business_type),
   gstin = COALESCE(?, gstin),
   pan = COALESCE(?, pan),
   website = COALESCE(?, website),
   address = COALESCE(?, address),
   address_line1 = COALESCE(?, address_line1),
   address_line2 = COALESCE(?, address_line2),
   city = COALESCE(?, city),
   state = COALESCE(?, state),
   pincode = COALESCE(?, pincode),
   country = COALESCE(?, country),
   currency = COALESCE(?, currency),
   tax_type = COALESCE(?, tax_type),
   tcs_enabled = COALESCE(?, tcs_enabled),
   tds_enabled = COALESCE(?, tds_enabled),
   payment_terms = COALESCE(?, payment_terms),
   watermark_enabled = COALESCE(?, watermark_enabled)
 WHERE id = ?`,
    [
      name ?? null,
      phone ?? null,
      business_name ?? null,
      business_type ?? null,
      gstin ?? null,
      pan ?? null,
      website ?? null,
      address ?? null,
      address_line1 ?? null,
      address_line2 ?? null,
      city ?? null,
      state ?? null,
      pincode ?? null,
      country ?? null,
      currency ?? null,
      tax_type ?? null,
      tcs_enabled ?? null,
      tds_enabled ?? null,
      payment_terms ?? null,
      effectiveWatermark,
      req.user.id,
    ],
  );
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
  res.json({ success: true, user: publicUser(rows[0]) });
});
const uploadProfileLogo = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No logo file uploaded.");
  }

  const logoPath = relativeUploadPath(req.file.path);

  await pool.query(
    "UPDATE users SET logo_path = ? WHERE id = ?",
    [logoPath, req.user.id]
  );

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ?",
    [req.user.id]
  );

  res.json({
    success: true,
    message: "Profile logo uploaded.",
    user: publicUser(rows[0]),
  });
});
const uploadProfileSignature = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No signature file uploaded.");
  }

  const signaturePath = relativeUploadPath(req.file.path);

  await pool.query(
    "UPDATE users SET signature_path = ? WHERE id = ?",
    [signaturePath, req.user.id]
  );

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ?",
    [req.user.id]
  );

  res.json({
    success: true,
    message: "Authorized signature uploaded.",
    user: publicUser(rows[0]),
  });
});

const deleteProfileSignature = asyncHandler(async (req, res) => {
  await pool.query(
    "UPDATE users SET signature_path = NULL WHERE id = ?",
    [req.user.id]
  );

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ?",
    [req.user.id]
  );

  res.json({
    success: true,
    message: "Authorized signature removed.",
    user: publicUser(rows[0]),
  });
});


const mfaTokenAttempts = new Map();
const cleanupMfaAttempts = () => {
  const now = Date.now();
  for (const [token, data] of mfaTokenAttempts.entries()) {
    if (data.expiresAt < now) mfaTokenAttempts.delete(token);
  }
};

// Rate limiter for 2FA actions per IP
const ip2faAttempts = new Map();
const is2faRateLimited = (ip, max = 15, windowMs = 60000) => {
  if (!ip) return false;
  const now = Date.now();
  const attempts = (ip2faAttempts.get(ip) || []).filter((t) => now - t < windowMs);
  if (attempts.length >= max) return true;
  attempts.push(now);
  ip2faAttempts.set(ip, attempts);
  return false;
};

// POST /api/auth/login/2fa
// Verifies 6-digit TOTP code or single-use recovery code against an active 2fa_pending token
const login2FA = asyncHandler(async (req, res) => {
  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (is2faRateLimited(clientIp, 15, 60000)) {
    throw new ApiError(429, "Too many verification requests. Please wait a moment.");
  }

  cleanupMfaAttempts();

  const { mfa_token, code, recovery_code } = req.body || {};
  if (!mfa_token) {
    throw new ApiError(400, "Verification session token is required.");
  }

  // Check attempt limit for this token
  const tokenRecord = mfaTokenAttempts.get(mfa_token) || { attempts: 0, expiresAt: Date.now() + 5 * 60 * 1000 };
  if (tokenRecord.attempts >= 5) {
    throw new ApiError(429, "Too many failed attempts. Verification session has been blocked. Please sign in again.");
  }

  let decoded;
  try {
    decoded = jwt.verify(mfa_token, process.env.JWT_SECRET);
  } catch (err) {
    throw new ApiError(401, "Verification session has expired. Please sign in again.");
  }

  if (decoded.purpose !== "2fa_pending" || !decoded.userId) {
    throw new ApiError(401, "Invalid verification session.");
  }

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [decoded.userId]);
  const user = rows[0];
  if (!user || user.deleted_at || user.status === "deleted") {
    throw new ApiError(403, "This account has been deleted. Access revoked.");
  }
  if (user.status !== "active") {
    throw new ApiError(403, "This account has been deactivated.");
  }
  if (!user.two_factor_enabled || !user.two_factor_secret) {
    throw new ApiError(400, "Two-step verification is not enabled for this account.");
  }
  if (decoded.token_version !== undefined && user.token_version !== undefined && decoded.token_version !== user.token_version) {
    throw new ApiError(401, "Session invalidated due to password change. Please sign in again.");
  }

  let verified = false;
  let usedRecoveryCode = false;

  if (code) {
    const cleanCode = String(code).replace(/\s+/g, "").trim();
    const decryptedSecret = decryptSecret(user.two_factor_secret);
    if (!decryptedSecret) {
      throw new ApiError(500, "Unable to decrypt two-step verification credentials.");
    }
    if (verifyTOTPCode({ token: cleanCode, secret: decryptedSecret })) {
      verified = true;
    }
  } else if (recovery_code) {
    const codeHash = hashRecoveryCode(recovery_code);
    const [matching] = await pool.query(
      "SELECT id FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND consumed_at IS NULL",
      [user.id, codeHash]
    );
    if (matching.length) {
      verified = true;
      usedRecoveryCode = true;
      // Mark recovery code as consumed atomically
      await pool.query(
        "UPDATE user_recovery_codes SET consumed_at = NOW() WHERE id = ?",
        [matching[0].id]
      );
    }
  } else {
    throw new ApiError(400, "Please provide your 6-digit authenticator code or backup recovery code.");
  }

  if (!verified) {
    tokenRecord.attempts += 1;
    mfaTokenAttempts.set(mfa_token, tokenRecord);
    const remaining = Math.max(0, 5 - tokenRecord.attempts);
    if (remaining === 0) {
      throw new ApiError(429, "Too many failed attempts. Verification session has been blocked. Please sign in again.");
    }
    throw new ApiError(400, recovery_code ? "Invalid or already used recovery code." : `Invalid verification code. ${remaining} attempt(s) remaining.`);
  }

  // Verification succeeded - clear token attempts
  mfaTokenAttempts.delete(mfa_token);

  await pool.query(
    "UPDATE users SET last_login_at = NOW(), last_active_at = NOW() WHERE id = ?",
    [user.id]
  );
  user.last_login_at = new Date();
  user.last_active_at = new Date();

  const token = signToken(user);
  res.json({
    success: true,
    token,
    user: publicUser(user),
    used_recovery_code: usedRecoveryCode,
  });
});

// GET /api/auth/2fa/status
// Returns whether 2FA is active, when enabled, and how many recovery codes remain
const get2FAStatus = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT two_factor_enabled, two_factor_enabled_at FROM users WHERE id = ?",
    [req.user.id]
  );
  const user = rows[0];
  const [codeRows] = await pool.query(
    "SELECT COUNT(*) AS remaining FROM user_recovery_codes WHERE user_id = ? AND consumed_at IS NULL",
    [req.user.id]
  );

  res.json({
    success: true,
    two_factor_enabled: Boolean(user?.two_factor_enabled),
    enabled_at: user?.two_factor_enabled_at || null,
    remaining_recovery_codes: codeRows[0]?.remaining || 0,
  });
});

// POST /api/auth/2fa/setup
// Generates new TOTP secret, encrypts with AES-256-GCM, stores temp secret, and returns QR code + manual key
const setup2FA = asyncHandler(async (req, res) => {
  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (is2faRateLimited(clientIp, 10, 60000)) {
    throw new ApiError(429, "Too many requests. Please wait a moment.");
  }

  const [rows] = await pool.query("SELECT id, email, name FROM users WHERE id = ?", [req.user.id]);
  const user = rows[0];
  if (!user) throw new ApiError(404, "User not found.");

  const secret = generateTOTPSecret();
  const encrypted = encryptSecret(secret);
  if (!encrypted) throw new ApiError(500, "Encryption failed.");

  await pool.query(
    "UPDATE users SET two_factor_temp_secret = ?, two_factor_temp_created_at = NOW() WHERE id = ?",
    [encrypted, user.id]
  );

  const otpauthUrl = getTOTPUri({ secret, email: user.email, issuer: "KhataNex" });
  const qrCodeDataUrl = await generateQRCode(otpauthUrl);
  const formattedKey = formatManualKey(secret);

  res.json({
    success: true,
    qr_code: qrCodeDataUrl,
    manual_entry_key: secret,
    formatted_key: formattedKey,
    otpauth_url: otpauthUrl,
  });
});

// POST /api/auth/2fa/verify-setup
// Verifies code against temporary secret, activates 2FA, generates and returns 10 recovery codes
const verify2FASetup = asyncHandler(async (req, res) => {
  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (is2faRateLimited(clientIp, 10, 60000)) {
    throw new ApiError(429, "Too many verification attempts. Please wait a moment.");
  }

  const { code } = req.body || {};
  if (!code || !String(code).trim()) {
    throw new ApiError(400, "Please provide the 6-digit verification code from your authenticator app.");
  }

  const [rows] = await pool.query(
    "SELECT id, email, name, two_factor_temp_secret, two_factor_temp_created_at FROM users WHERE id = ?",
    [req.user.id]
  );
  const user = rows[0];
  if (!user || !user.two_factor_temp_secret) {
    throw new ApiError(400, "Two-step verification setup has not been initiated. Please start setup again.");
  }

  // Check setup expiry (15 minutes)
  if (user.two_factor_temp_created_at) {
    const elapsedMs = Date.now() - new Date(user.two_factor_temp_created_at).getTime();
    if (elapsedMs > 15 * 60 * 1000) {
      throw new ApiError(400, "Two-step verification setup has expired. Please generate a new QR code.");
    }
  }

  const decryptedSecret = decryptSecret(user.two_factor_temp_secret);
  if (!decryptedSecret) {
    throw new ApiError(500, "Failed to decrypt temporary setup credentials.");
  }

  const isValid = verifyTOTPCode({ token: code, secret: decryptedSecret });
  if (!isValid) {
    throw new ApiError(400, "Invalid verification code. Please check your authenticator app and try again.");
  }

  // Generate 10 single-use recovery codes
  const recoveryCodes = generateRecoveryCodes(10);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Delete any existing recovery codes for this user
    await conn.query("DELETE FROM user_recovery_codes WHERE user_id = ?", [user.id]);

    // 2. Insert new recovery codes (hashes only)
    for (const item of recoveryCodes) {
      await conn.query(
        "INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)",
        [user.id, item.hash]
      );
    }

    // 3. Activate 2FA on user record
    await conn.query(
      `UPDATE users SET
         two_factor_enabled = 1,
         two_factor_secret = two_factor_temp_secret,
         two_factor_temp_secret = NULL,
         two_factor_temp_created_at = NULL,
         two_factor_enabled_at = NOW(),
         updated_at = NOW()
       WHERE id = ?`,
      [user.id]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Send security confirmation email asynchronously
  try {
    emailService.send2FAEnabledEmail({
      to: user.email,
      userName: user.name,
    }).catch((mailErr) => {
      console.warn("[Auth] Failed to enqueue 2FA enabled email:", mailErr.message);
    });
  } catch (_) {}

  res.json({
    success: true,
    message: "Two-step verification successfully activated.",
    recovery_codes: recoveryCodes.map((c) => c.raw),
  });
});

// POST /api/auth/2fa/disable
// Requires password re-authentication + (TOTP code OR recovery code) to safely turn off 2FA
const disable2FA = asyncHandler(async (req, res) => {
  const { password, code, recovery_code } = req.body || {};
  if (!password) {
    throw new ApiError(400, "Your current password is required to disable two-step verification.");
  }
  if (!code && !recovery_code) {
    throw new ApiError(400, "Please provide an authenticator code or recovery code to confirm this action.");
  }

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
  const user = rows[0];
  if (!user || !user.two_factor_enabled) {
    throw new ApiError(400, "Two-step verification is not currently active on this account.");
  }

  // 1. Re-authenticate password
  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
    throw new ApiError(401, "Incorrect password. Two-step verification cannot be disabled.");
  }

  // 2. Verify second factor
  let verified = false;
  if (code) {
    const decryptedSecret = decryptSecret(user.two_factor_secret);
    if (decryptedSecret && verifyTOTPCode({ token: code, secret: decryptedSecret })) {
      verified = true;
    }
  } else if (recovery_code) {
    const codeHash = hashRecoveryCode(recovery_code);
    const [matching] = await pool.query(
      "SELECT id FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND consumed_at IS NULL",
      [user.id, codeHash]
    );
    if (matching.length) {
      verified = true;
      await pool.query("UPDATE user_recovery_codes SET consumed_at = NOW() WHERE id = ?", [matching[0].id]);
    }
  }

  if (!verified) {
    throw new ApiError(400, "Invalid authenticator code or recovery code.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE users SET
         two_factor_enabled = 0,
         two_factor_secret = NULL,
         two_factor_temp_secret = NULL,
         two_factor_temp_created_at = NULL,
         two_factor_enabled_at = NULL,
         updated_at = NOW()
       WHERE id = ?`,
      [user.id]
    );

    await conn.query("DELETE FROM user_recovery_codes WHERE user_id = ?", [user.id]);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Send security alert email asynchronously
  try {
    emailService.send2FADisabledEmail({
      to: user.email,
      userName: user.name,
    }).catch((mailErr) => {
      console.warn("[Auth] Failed to enqueue 2FA disabled email:", mailErr.message);
    });
  } catch (_) {}

  res.json({
    success: true,
    message: "Two-step verification has been disabled.",
  });
});

// POST /api/auth/2fa/recovery-codes/regenerate
// Re-authenticates password + TOTP code, generates 10 new recovery codes, invalidating prior ones
const regenerate2FARecoveryCodes = asyncHandler(async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) {
    throw new ApiError(400, "Your current password is required to regenerate recovery codes.");
  }
  if (!code) {
    throw new ApiError(400, "Your current authenticator code is required to regenerate recovery codes.");
  }

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
  const user = rows[0];
  if (!user || !user.two_factor_enabled || !user.two_factor_secret) {
    throw new ApiError(400, "Two-step verification is not enabled.");
  }

  // 1. Password check
  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
    throw new ApiError(401, "Incorrect password.");
  }

  // 2. TOTP code check
  const decryptedSecret = decryptSecret(user.two_factor_secret);
  if (!decryptedSecret || !verifyTOTPCode({ token: code, secret: decryptedSecret })) {
    throw new ApiError(400, "Invalid authenticator code.");
  }

  const newCodes = generateRecoveryCodes(10);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query("DELETE FROM user_recovery_codes WHERE user_id = ?", [user.id]);

    for (const item of newCodes) {
      await conn.query(
        "INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)",
        [user.id, item.hash]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Send notification email asynchronously
  try {
    emailService.send2FARecoveryCodesRegeneratedEmail({
      to: user.email,
      userName: user.name,
    }).catch((mailErr) => {
      console.warn("[Auth] Failed to enqueue recovery codes regenerated email:", mailErr.message);
    });
  } catch (_) {}

  res.json({
    success: true,
    message: "New backup recovery codes generated.",
    recovery_codes: newCodes.map((c) => c.raw),
  });
});


module.exports = {
  register,
  login,
  login2FA,
  getMe,
  updateMe,
  uploadProfileLogo,
  uploadProfileSignature,
  deleteProfileSignature,
  get2FAStatus,
  setup2FA,
  verify2FASetup,
  disable2FA,
  regenerate2FARecoveryCodes,
};

