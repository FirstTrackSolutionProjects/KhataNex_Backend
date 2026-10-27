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
      "SELECT id, name, email, role, employee_role_type, permissions, assigned_modules, status, created_by_admin, password_changed_at, token_version FROM users WHERE id = ?",
      [decoded.id]
    );

    const user = rows[0];
    if (!user) throw new ApiError(401, "User no longer exists.");
    if (user.status !== "active") {
      throw new ApiError(403, "Your account has been deactivated. Contact the super admin.");
    }

    // Invalidate sessions issued prior to credential/password change
    if (decoded.token_version !== undefined && user.token_version !== undefined && decoded.token_version !== user.token_version) {
      throw new ApiError(401, "Session expired due to password change. Please log in again.");
    }
    if (user.password_changed_at && decoded.iat) {
      const pwdChangedMs = new Date(user.password_changed_at).getTime();
      const tokenIatMs = decoded.iat * 1000;
      if (tokenIatMs < pwdChangedMs - 2000) {
        throw new ApiError(401, "Session expired due to password change. Please log in again.");
      }
    }

    if (typeof user.assigned_modules === "string") {
      try {
        user.assigned_modules = JSON.parse(user.assigned_modules);
      } catch (_) {
        user.assigned_modules = [];
      }
    }
    if (!Array.isArray(user.assigned_modules)) {
      user.assigned_modules = [];
    }

    // Throttle activity updates to once per minute to prevent unnecessary database writes
    const nowTime = new Date();
    const lastActive = user.last_active_at ? new Date(user.last_active_at) : null;
    if (!lastActive || (nowTime - lastActive) > 60000) {
      pool.query("UPDATE users SET last_active_at = NOW() WHERE id = ?", [user.id]).catch(() => {});
      user.last_active_at = nowTime;
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

/**
 * authorizePermission(...permissions) — allows super admin automatically,
 * otherwise requires an employee to have at least one of the requested
 * permissions in the users.permissions JSON field.
 */
const authorizePermission = (...requiredPermissions) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, "Not authenticated."));
  if (req.user.role === "superadmin") return next();

  if (req.user.role !== "employee") {
    return next(new ApiError(403, "Only authorized employees can perform this action."));
  }

  let granted = req.user.permissions;
  if (typeof granted === "string") {
    try {
      granted = JSON.parse(granted);
    } catch (err) {
      granted = [];
    }
  }

  if (!Array.isArray(granted)) granted = [];

  const allowed = requiredPermissions.some((permission) => granted.includes(permission));
  if (allowed) return next();

  next(new ApiError(403, "You do not have the required permission for this action."));
};

/**
 * authorizeModule(...modules) — restricts access to employees assigned to specific modules.
 * Superadmin always passes automatically. Regular users pass for their own business operations.
 * Employees must have at least one of the specified modules in their assigned_modules array (or 'all').
 */
const authorizeModule = (...requiredModules) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, "Not authenticated."));
  if (req.user.role === "superadmin") return next();
  if (req.user.role === "user") return next();

  if (req.user.role === "employee") {
    const assigned = Array.isArray(req.user.assigned_modules) ? req.user.assigned_modules : [];
    if (assigned.includes("all") || assigned.includes("manage_all")) {
      return next();
    }
    // Inherited Purchases access: Inventory access grants Purchases access
    const isPurchases = requiredModules.includes("purchases") || requiredModules.includes("purchase_bills");
    if (isPurchases && (assigned.includes("inventory") || assigned.includes("stock"))) {
      return next();
    }
    const hasModule = requiredModules.some((mod) => assigned.includes(mod));
    if (hasModule) return next();
    return next(new ApiError(403, `Access denied: you are not assigned to the [${requiredModules.join(", ")}] module.`));
  }

  next(new ApiError(403, "You do not have permission to access this resource."));
};

/**
 * requirePermission(moduleName, operation) — restricts access based on granular employee permissions.
 * Superadmin and regular users pass automatically.
 * Employees are checked via hasPermission(req.user, moduleName, operation).
 */
const { hasPermission } = require("../utils/tenantContext");

const requirePermission = (moduleName, operation = "view") => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, "Not authenticated."));
  if (req.user.role === "superadmin" || req.user.role === "user") return next();

  if (hasPermission(req.user, moduleName, operation)) {
    return next();
  }

  return next(new ApiError(403, `Access denied: you do not have permission to ${operation} ${moduleName}.`));
};


module.exports = {
  authenticate,
  authorize,
  authorizeEmployeeRoleType,
  authorizePermission,
  authorizeModule,
  requirePermission,
};
