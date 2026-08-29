const bcrypt = require("bcrypt");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

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
  created_at: u.created_at,
});

// GET /api/superadmin/users
// Full overview of every account (users + employees), for the super
// admin's dashboard.
const listUsers = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, business_name, address, role, employee_role_type, status, created_at
     FROM users ORDER BY created_at DESC`
  );
  res.json({ success: true, count: rows.length, users: rows });
});

// GET /api/superadmin/users/:id
const getUser = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, business_name, address, role, employee_role_type, status, created_at
     FROM users WHERE id = ?`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "User not found.");
  res.json({ success: true, user: rows[0] });
});

// POST /api/superadmin/employees
// The super admin creates an employee account directly, assigning the
// login credentials themselves (the employee never self-registers, and
// the super admin's own credentials are never shared). Nothing except a
// unique email + password is required — name/role type are optional.
const createEmployee = asyncHandler(async (req, res) => {
  const { name, email, password, phone, employee_role_type } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "email and password are required to create an employee login.");
  }

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length) throw new ApiError(409, "An account with this email already exists.");

  const hashed = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    `INSERT INTO users (name, email, phone, password, role, employee_role_type, created_by_admin)
     VALUES (?, ?, ?, ?, 'employee', ?, ?)`,
    [name || null, email, phone || null, hashed, employee_role_type || null, req.user.id]
  );

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  res.status(201).json({ success: true, employee: publicUser(rows[0]) });
});

// GET /api/superadmin/employees
const listEmployees = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, employee_role_type, status, created_at
     FROM users WHERE role = 'employee' ORDER BY created_at DESC`
  );
  res.json({ success: true, count: rows.length, employees: rows });
});

// PATCH /api/superadmin/employees/:id
// Update an employee's role-type label / phone / name. Nothing required.
const updateEmployee = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, phone, employee_role_type } = req.body;

  const [rows] = await pool.query("SELECT * FROM users WHERE id = ? AND role = 'employee'", [id]);
  if (!rows.length) throw new ApiError(404, "Employee not found.");

  await pool.query(
    `UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone),
     employee_role_type = COALESCE(?, employee_role_type) WHERE id = ?`,
    [name ?? null, phone ?? null, employee_role_type ?? null, id]
  );
  const [updated] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  res.json({ success: true, employee: publicUser(updated[0]) });
});

// PATCH /api/superadmin/users/:id/status
// Activate/deactivate any account (user or employee).
const setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["active", "inactive"].includes(status)) {
    throw new ApiError(400, "status must be 'active' or 'inactive'.");
  }
  if (Number(id) === req.user.id) throw new ApiError(400, "You cannot deactivate your own account.");

  const [result] = await pool.query("UPDATE users SET status = ? WHERE id = ?", [status, id]);
  if (!result.affectedRows) throw new ApiError(404, "User not found.");

  res.json({ success: true, message: `Account status set to ${status}.` });
});

module.exports = { listUsers, getUser, createEmployee, listEmployees, updateEmployee, setUserStatus };
