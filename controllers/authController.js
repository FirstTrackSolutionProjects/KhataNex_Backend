const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { relativeUploadPath } = require("../utils/upload");

const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, employee_role_type: user.employee_role_type },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,

  business_name: u.business_name,
  business_type: u.business_type,
  gstin: u.gstin,
  pan: u.pan,
  website: u.website,
  logo_path: u.logo_path,

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

  role: u.role,
  employee_role_type: u.employee_role_type,
  status: u.status,
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
} = req.body;
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
   payment_terms = COALESCE(?, payment_terms)
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

module.exports = {
  register,
  login,
  getMe,
  updateMe,
  uploadProfileLogo,
};
