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
const { getSubscriptionSettings } = require("../utils/subscriptionLogic");

const requireActiveSubscription = async (req, res, next) => {
  // Check enforcement switch: active if env is "on" or DB settings is "on" (unless env is explicitly "off")
  const settings = await getSubscriptionSettings();
  const isEnforced =
    process.env.SUBSCRIPTION_ENFORCEMENT === "on" ||
    (process.env.SUBSCRIPTION_ENFORCEMENT !== "off" && settings.subscription_enforcement === "on");

  if (!isEnforced) {
    return next();
  }

  // Permitted read operations (read-only mode for unsubscribed/expired accounts)
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
    return res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  }

  // Superadmins bypass gating
  if (req.user.role === "superadmin") {
    return next();
  }

  try {
    // Determine billing owner account: employees inherit subscription entitlement from their business owner
    if (req.user.role === "employee") {
      const ownerId = req.user.created_by_admin;
      if (!ownerId) {
        return res.status(403).json({
          success: false,
          code: "NO_BUSINESS_OWNER",
          message: "Your employee account is not linked to an active business owner.",
          isEmployee: true,
        });
      }

      const [ownerRows] = await pool.query(
        "SELECT id, name, email, role, status FROM users WHERE id = ?",
        [ownerId]
      );
      if (!ownerRows.length || ownerRows[0].status !== "active") {
        return res.status(403).json({
          success: false,
          code: "OWNER_INACTIVE",
          message: "Your associated business owner account is inactive.",
          isEmployee: true,
        });
      }

      const owner = ownerRows[0];
      // If owner is a superadmin, they have automatic platform bypass
      if (owner.role === "superadmin") {
        return next();
      }

      // Check owner's active subscription
      const [rows] = await pool.query(
        `SELECT id, user_id, plan_id, order_id, starts_at, ends_at, status, is_complimentary
         FROM subscriptions
         WHERE user_id = ?
           AND status = 'active'
           AND ends_at > NOW()
         ORDER BY ends_at DESC LIMIT 1`,
        [owner.id]
      );

      if (!rows.length) {
        return res.status(403).json({
          success: false,
          code: "SUBSCRIPTION_REQUIRED",
          reason: "OWNER_SUBSCRIPTION_REQUIRED",
          message: "Your business owner's subscription has expired or is inactive. Please contact your account owner to renew.",
          isEmployee: true,
        });
      }

      req.subscription = rows[0];
      return next();
    }

    // Regular business owner / user
    const [rows] = await pool.query(
      `SELECT id, user_id, plan_id, order_id, starts_at, ends_at, status, is_complimentary 
       FROM subscriptions 
       WHERE user_id = ? 
         AND status = 'active'
         AND ends_at > NOW() 
       ORDER BY ends_at DESC LIMIT 1`,
      [req.user.id]
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

