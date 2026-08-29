const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

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
  address: u.address,
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
  const { name, phone, business_name, address } = req.body;
  await pool.query(
    `UPDATE users SET
       name = COALESCE(?, name),
       phone = COALESCE(?, phone),
       business_name = COALESCE(?, business_name),
       address = COALESCE(?, address)
     WHERE id = ?`,
    [name ?? null, phone ?? null, business_name ?? null, address ?? null, req.user.id]
  );
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
  res.json({ success: true, user: publicUser(rows[0]) });
});

module.exports = { register, login, getMe, updateMe };
