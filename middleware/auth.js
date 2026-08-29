const jwt = require("jsonwebtoken");
const ApiError = require("../utils/ApiError");
const pool = require("../config/db");

/**
 * authenticate — verifies the JWT sent in "Authorization: Bearer <token>",
 * then re-checks the user's CURRENT role/status in the DB (not just what
 * was in the token) so that a super admin creating/deactivating an employee
 * takes effect immediately, without waiting for token expiry.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;

    if (!token) {
      throw new ApiError(401, "Not authenticated. Please log in.");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      "SELECT id, name, email, role, employee_role_type, status FROM users WHERE id = ?",
      [decoded.id]
    );

    const user = rows[0];
    if (!user) throw new ApiError(401, "User no longer exists.");
    if (user.status !== "active") {
      throw new ApiError(403, "Your account has been deactivated. Contact the super admin.");
    }

    req.user = user; // always reflects the latest role from the DB
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return next(new ApiError(401, "Invalid or expired session. Please log in again."));
    }
    next(err);
  }
};

/**
 * authorize(...roles) — restricts a route to one or more of
 * 'user' | 'employee' | 'superadmin'. Super admin is always allowed
 * through automatically since it sits above everyone.
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, "Not authenticated."));
  if (req.user.role === "superadmin" || roles.includes(req.user.role)) {
    return next();
  }
  next(new ApiError(403, "You do not have permission to perform this action."));
};

/**
 * authorizeEmployeeRoleType(...types) — for employee-only routes that
 * should be further restricted by the employee's assigned role label
 * (e.g. only an 'accountant' employee should see profit & loss). Super
 * admin always passes. Employees whose employee_role_type isn't in the
 * allowed list are blocked.
 */
const authorizeEmployeeRoleType = (...types) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, "Not authenticated."));
  if (req.user.role === "superadmin") return next();
  if (req.user.role === "employee" && types.includes(req.user.employee_role_type)) {
    return next();
  }
  next(new ApiError(403, "Your role does not have access to this section."));
};

module.exports = { authenticate, authorize, authorizeEmployeeRoleType };
