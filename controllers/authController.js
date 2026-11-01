const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { relativeUploadPath } = require("../utils/upload");
const ApiError = require("../utils/ApiError");
const emailService = require("../services/emailService");

const signToken = (user) =>
  jwt.sign(
    {
      id: user.id,
      role: user.role,
      employee_role_type: user.employee_role_type,
      token_version: user.token_version !== undefined ? user.token_version : 1,
    },
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

// Rate limiter for forgot password requests per IP
const forgotPasswordIpAttempts = new Map();
const isForgotPasswordRateLimited = (ip, max = 5, windowMs = 15 * 60 * 1000) => {
  if (!ip) return false;
  // Loopback exemption in dev/test to allow local test suites to run
  if (process.env.NODE_ENV !== "production" && (ip === "127.0.0.1" || ip === "::1" || ip === "localhost")) {
    return false;
  }
  const now = Date.now();
  const timestamps = (forgotPasswordIpAttempts.get(ip) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= max) return true;
  timestamps.push(now);
  forgotPasswordIpAttempts.set(ip, timestamps);
  return false;
};

// Rate limiter for reset attempts per IP
const resetPasswordIpAttempts = new Map();
const isResetPasswordRateLimited = (ip, max = 10, windowMs = 15 * 60 * 1000) => {
  if (!ip) return false;
  if (process.env.NODE_ENV !== "production" && (ip === "127.0.0.1" || ip === "::1" || ip === "localhost")) {
    return false;
  }
  const now = Date.now();
  const timestamps = (resetPasswordIpAttempts.get(ip) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= max) return true;
  timestamps.push(now);
  resetPasswordIpAttempts.set(ip, timestamps);
  return false;
};

// POST /api/auth/forgot-password
// Generates cryptographically secure single-use token and sends email instructions
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

  if (isForgotPasswordRateLimited(clientIp)) {
    throw new ApiError(429, "Too many password reset requests from this IP address. Please try again after 15 minutes.");
  }

  // Always return identical generic confirmation response
  const genericResponse = {
    success: true,
    message: "If an eligible account exists for this email, you will receive password reset instructions shortly.",
  };

  if (!email || !String(email).trim() || !String(email).includes("@")) {
    return res.json(genericResponse);
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  const [users] = await pool.query(
    `SELECT id, name, email, status, deleted_at
     FROM users
     WHERE email = ? AND (deleted_at IS NULL AND status != 'deleted')
     ORDER BY id DESC
     LIMIT 1`,
    [normalizedEmail]
  );

  const user = users[0];

  // If no active user exists, or user is not active, return the exact same generic response
  if (!user || user.status !== "active") {
    return res.json(genericResponse);
  }

  // User-level rate limiting: Check recent reset requests for this user in last 15 minutes
  const [recentResets] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM password_resets WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)",
    [user.id]
  );
  if (recentResets[0]?.cnt >= 3) {
    return res.json(genericResponse);
  }

  // Invalidate any existing unconsumed reset tokens for this user
  await pool.query(
    "UPDATE password_resets SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL",
    [user.id]
  );

  // Generate cryptographic single-use token (32 bytes hex = 64 characters)
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiryMinutes = 20;
  const userAgent = (req.headers["user-agent"] || "").slice(0, 255);

  const [insertRes] = await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?)`,
    [user.id, tokenHash, expiryMinutes, clientIp || null, userAgent || null]
  );

  // Build reset link with frontend URL
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
  const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

  // Enqueue reset email
  try {
    emailService.sendPasswordResetEmail({
      to: user.email,
      userName: user.name || "Valued User",
      resetUrl,
      expiresInMinutes: expiryMinutes,
      resetId: insertRes.insertId,
    }).catch((mailErr) => {
      console.warn(`[Auth] Non-fatal password reset email queue error for user ${user.id}:`, mailErr.message);
    });
  } catch (err) {
    console.warn(`[Auth] Password reset email trigger error:`, err.message);
  }

  return res.json(genericResponse);
});

// GET /api/auth/verify-reset-token
// Validates whether a reset token is current, unconsumed and unexpired without consuming it.
const verifyResetToken = asyncHandler(async (req, res) => {
  const { token } = req.query || {};
  if (!token || !String(token).trim()) {
    return res.status(400).json({ valid: false, message: "Reset token is required." });
  }

  const tokenHash = crypto.createHash("sha256").update(String(token).trim()).digest("hex");
  const [rows] = await pool.query(
    `SELECT pr.id, pr.expires_at, pr.consumed_at, u.status, u.deleted_at
     FROM password_resets pr
     JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = ?`,
    [tokenHash]
  );

  if (!rows.length) {
    return res.status(400).json({ valid: false, message: "Invalid or expired password reset link." });
  }

  const row = rows[0];
  if (row.consumed_at) {
    return res.status(400).json({ valid: false, message: "This password reset link has already been used. Please request a new one." });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ valid: false, message: "This password reset link has expired. Please request a new one." });
  }
  if (row.deleted_at || row.status !== "active") {
    return res.status(403).json({ valid: false, message: "This account is not eligible for password reset." });
  }

  return res.json({ valid: true });
});

// POST /api/auth/reset-password
// Atomically verifies token, marks it consumed, hashes the new password,
// increments token_version to invalidate prior JWT sessions, and records password_changed_at.
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

  if (isResetPasswordRateLimited(clientIp)) {
    throw new ApiError(429, "Too many password reset attempts. Please try again later.");
  }

  if (!token || !String(token).trim()) {
    throw new ApiError(400, "Reset token is required.");
  }
  if (!password || String(password).length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters long.");
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    throw new ApiError(400, "Passwords do not match. Please verify your password.");
  }

  const tokenHash = crypto.createHash("sha256").update(String(token).trim()).digest("hex");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.consumed_at, u.status, u.deleted_at, u.token_version
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = ?
       FOR UPDATE`,
      [tokenHash]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(400, "Invalid or expired password reset link.");
    }

    const resetRecord = rows[0];

    if (resetRecord.consumed_at) {
      await conn.rollback();
      throw new ApiError(400, "This password reset link has already been used. Please request a new one.");
    }

    if (new Date(resetRecord.expires_at) < new Date()) {
      await conn.rollback();
      throw new ApiError(400, "This password reset link has expired. Please request a new one.");
    }

    if (resetRecord.deleted_at || resetRecord.status === "deleted") {
      await conn.rollback();
      throw new ApiError(403, "This account has been deleted. Password reset cannot be completed.");
    }

    if (resetRecord.status !== "active") {
      await conn.rollback();
      throw new ApiError(403, "Your account has been deactivated. Contact the super admin.");
    }

    // Atomically mark token as consumed
    await conn.query("UPDATE password_resets SET consumed_at = NOW() WHERE id = ?", [resetRecord.id]);

    // Invalidate any other outstanding reset tokens for this user
    await conn.query(
      "UPDATE password_resets SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL",
      [resetRecord.user_id]
    );

    // Hash new password using bcrypt
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update password, increment token_version, record password_changed_at
    await conn.query(
      `UPDATE users
       SET password = ?,
           password_changed_at = NOW(),
           token_version = token_version + 1,
           updated_at = NOW()
       WHERE id = ?`,
      [hashedPassword, resetRecord.user_id]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Your password has been successfully reset. You can now log in with your new password.",
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = {
  register,
  login,
  forgotPassword,
  verifyResetToken,
  resetPassword,
  getMe,
  updateMe,
  uploadProfileLogo,
  uploadProfileSignature,
  deleteProfileSignature,
};
