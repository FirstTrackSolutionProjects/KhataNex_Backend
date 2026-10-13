const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const ApiError = require("../utils/ApiError");

/**
 * Middleware: requireActiveSubscription
 *
 * Gating policy:
 * 1. Disabled by default via SUBSCRIPTION_ENFORCEMENT != "on" so existing live users
 *    are never abruptly locked out during initial deployment.
 * 2. Superadmins always bypass.
 * 3. Safe read operations (GET, HEAD, OPTIONS) are permitted so users can view their
 *    existing records even if their subscription has lapsed.
 * 4. Only mutating operations (POST, PUT, PATCH, DELETE) require an active subscription.
 * 5. Employees inherit subscription status from their business owner account.
 */
const requireActiveSubscription = async (req, res, next) => {
  // Check enforcement switch: completely inert by default
  if (process.env.SUBSCRIPTION_ENFORCEMENT !== "on") {
    return next();
  }

  // Permitted read operations (read-only mode for expired accounts)
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Ensure req.user is loaded (if not already by prior auth middleware)
  if (!req.user) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [rows] = await pool.query(
          "SELECT id, name, email, role, employee_role_type, permissions, status, created_by_admin FROM users WHERE id = ?",
          [decoded.id]
        );
        if (rows[0] && rows[0].status === "active") {
          req.user = rows[0];
        }
      } catch (_) {
        // Continue to check req.user below
      }
    }
  }

  // Not authenticated
  if (!req.user) {
    return next(new ApiError(401, "Authentication required."));
  }

  // Superadmins bypass gating
  if (req.user.role === "superadmin") {
    return next();
  }

  try {
    // Determine the billing owner account
    let ownerId = req.user.id;
    if (req.user.role === "employee" && req.user.created_by_admin) {
      ownerId = req.user.created_by_admin;
    }

    const [rows] = await pool.query(
      `SELECT id, ends_at, is_complimentary 
       FROM subscriptions 
       WHERE user_id = ? AND ends_at > NOW() 
       ORDER BY ends_at DESC LIMIT 1`,
      [ownerId]
    );

    if (!rows.length) {
      return res.status(403).json({
        success: false,
        code: "SUBSCRIPTION_REQUIRED",
        message: "An active subscription is required to perform this action. Please choose or renew your plan.",
      });
    }

    req.subscription = rows[0];
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { requireActiveSubscription };

