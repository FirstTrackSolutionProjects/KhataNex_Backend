const pool = require("../config/db");

/**
 * Standard operation permissions map per module
 */
const MODULE_OPERATIONS = {
  users: ["view", "create", "edit"],
  invoices: ["view", "create", "edit", "delete", "download"],
  quotations: ["view", "create", "edit", "delete", "download"],
  money_receipts: ["view", "create", "edit", "delete", "download"],
  receipts: ["view", "create", "edit", "delete", "download"],
  customers: ["view", "create", "edit", "delete"],
  khata: ["view", "create", "edit", "delete"],
  payments: ["view", "create", "edit", "delete"],
  inventory: ["view", "create", "edit", "delete"],
  purchases: ["view", "create", "edit", "delete"],
  vehicles: ["view", "create", "edit", "delete"],
  banking: ["view", "create", "edit", "delete"],
  reports: ["view", "export"],
  dashboard: ["view", "export"],
  billing: ["view"],
  help_centre: ["view", "reply", "claim", "resolve"],
};

/**
 * Flattened list of all valid granular permission identifiers
 */
const ALL_GRANULAR_PERMISSIONS = [];
for (const [mod, ops] of Object.entries(MODULE_OPERATIONS)) {
  for (const op of ops) {
    ALL_GRANULAR_PERMISSIONS.push(`${mod}:${op}`);
  }
}

// Support legacy and administrative permission strings as well
const LEGACY_PERMISSIONS = [
  "support_chat",
  "view_basic_user",
  "create_invoice",
  "create_quotation",
  "create_receipt",
  "view_khata",
  "view_payments",
  "manage_payments",
  "manage_inventory",
  "manage_vehicles",
  "create_employee",
  "edit_employee",
  "manage_employee_permissions",
  "all",
  "manage_all",
];

const ALL_ALLOWED_PERMISSIONS = [
  ...new Set([...ALL_GRANULAR_PERMISSIONS, ...LEGACY_PERMISSIONS]),
];

/**
 * Normalizes and validates permission lists sent from client
 */
function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) return [];

  let value = permissions;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (_) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(value)) {
    if (typeof value === "object") {
      // Map dictionary format e.g. { invoices: ["view", "create"] }
      const flat = [];
      for (const [mod, ops] of Object.entries(value)) {
        if (Array.isArray(ops)) {
          ops.forEach((op) => flat.push(`${mod}:${op}`));
        }
      }
      value = flat;
    } else {
      value = [];
    }
  }

  const unique = [...new Set(value.map((p) => String(p).trim()).filter(Boolean))];
  return unique;
}

/**
 * Extracts business/tenant context from authenticated request
 */
function getTenantContext(req) {
  const user = (req && req.user) ? req.user : (req || {});
  const isEmployee = user.role === "employee";
  const isSuperadmin = user.role === "superadmin";

  // If employee has created_by_admin set, the business belongs to that admin/owner
  const businessOwnerId = isEmployee && user.created_by_admin
    ? Number(user.created_by_admin)
    : Number(user.id);

  const actorId = Number(user.id);
  const actorRole = user.role || "user";
  const actorName = user.name || "Staff Member";
  const actorEmail = user.email || "";

  return {
    isEmployee,
    isSuperadmin,
    businessOwnerId,
    actorId,
    actorRole,
    actorName,
    actorEmail,
  };
}

/**
 * Evaluates whether a user has permission to perform an operation on a module
 */
function hasPermission(user, moduleName, operation = "view") {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  if (user.role === "user") return true; // regular users operate on their own business account

  if (user.role !== "employee") return false;

  // Normalize module name (e.g. receipts vs money_receipts, dashboard vs reports, purchase_bills vs purchases)
  let canonicalMod = moduleName === "receipts" ? "money_receipts" : moduleName;
  if (canonicalMod === "dashboard") canonicalMod = "reports";
  if (canonicalMod === "purchase_bills") canonicalMod = "purchases";

  // Check module assignment
  let assigned = user.assigned_modules;
  if (typeof assigned === "string") {
    try {
      assigned = JSON.parse(assigned);
    } catch (_) {
      assigned = [];
    }
  }
  if (!Array.isArray(assigned)) assigned = [];

  const isPurchasesCheck = canonicalMod === "purchases";
  const hasModule =
    assigned.includes("all") ||
    assigned.includes("manage_all") ||
    assigned.includes(canonicalMod) ||
    assigned.includes(moduleName) ||
    (canonicalMod === "reports" && assigned.includes("dashboard")) ||
    (canonicalMod === "dashboard" && assigned.includes("reports")) ||
    (isPurchasesCheck && (assigned.includes("inventory") || assigned.includes("stock")));

  if (!hasModule) return false;

  // Check granular permissions
  let permissions = user.permissions;
  if (typeof permissions === "string") {
    try {
      permissions = JSON.parse(permissions);
    } catch (_) {
      permissions = [];
    }
  }
  if (!Array.isArray(permissions)) permissions = [];

  if (permissions.includes("all") || permissions.includes("manage_all")) {
    return true;
  }

  // Check module wildcard
  if (
    permissions.includes(`${canonicalMod}:*`) ||
    permissions.includes(`${moduleName}:*`) ||
    (isPurchasesCheck && permissions.includes("inventory:*"))
  ) {
    return true;
  }

  // Check exact granular permission
  if (
    permissions.includes(`${canonicalMod}:${operation}`) ||
    permissions.includes(`${moduleName}:${operation}`) ||
    (isPurchasesCheck && permissions.includes(`inventory:${operation}`))
  ) {
    return true;
  }

  // Check legacy permission naming
  const legacyActionMap = {
    "invoices:create": "create_invoice",
    "quotations:create": "create_quotation",
    "money_receipts:create": "create_receipt",
    "receipts:create": "create_receipt",
    "khata:view": "view_khata",
    "payments:view": "view_payments",
    "payments:create": "manage_payments",
    "inventory:view": "view_inventory",
    "inventory:create": "manage_inventory",
    "inventory:edit": "manage_inventory",
    "purchases:view": "view_inventory",
    "purchases:create": "manage_inventory",
    "purchases:edit": "manage_inventory",
    "vehicles:create": "manage_vehicles",
    "vehicles:edit": "manage_vehicles",
  };

  const legacyKey = `${canonicalMod}:${operation}`;
  if (legacyActionMap[legacyKey] && permissions.includes(legacyActionMap[legacyKey])) {
    return true;
  }

  if (
    (canonicalMod === "inventory" || isPurchasesCheck) &&
    (permissions.includes("manage_inventory") || permissions.includes("inventory:*"))
  ) {
    return true;
  }

  // Safe defaults if permissions array is empty but module is explicitly assigned:
  // Allow safe non-destructive read and create operations by default, block destructive delete
  if (permissions.length === 0) {
    if (operation === "view" || operation === "download" || operation === "export") {
      return true;
    }
    if (operation === "create") {
      return true;
    }
    if (canonicalMod === "help_centre" && (operation === "claim" || operation === "reply" || operation === "resolve")) {
      return true;
    }
    // delete and edit requires explicit permission
    return false;
  }

  return false;
}

/**
 * Standard audit logger for employee and administrative operations
 */
async function logAuditEvent(reqOrEvent, maybeEvent = null) {
  try {
    let event = {};
    if (maybeEvent && typeof maybeEvent === "object") {
      const req = reqOrEvent;
      const tenant = getTenantContext(req);
      event = {
        actorId: tenant.actorId,
        actorRole: tenant.actorRole,
        ipAddress: req?.ip || req?.connection?.remoteAddress || null,
        ...maybeEvent,
      };
      if (!event.targetAccountId && tenant.businessOwnerId && tenant.businessOwnerId !== tenant.actorId) {
        event.targetAccountId = tenant.businessOwnerId;
      }
    } else {
      event = { ...(reqOrEvent || {}) };
    }

    let detailsObj = event.details;
    if (typeof detailsObj === "string") {
      try {
        detailsObj = JSON.parse(detailsObj);
      } catch (_) {
        detailsObj = { message: detailsObj };
      }
    } else if (!detailsObj || typeof detailsObj !== "object") {
      detailsObj = {};
    }

    if (event.targetAccountId) {
      detailsObj.target_account_id = event.targetAccountId;
    }

    const detailsStr = JSON.stringify(detailsObj);
    const beforeStr = event.beforeValue && typeof event.beforeValue === "object" ? JSON.stringify(event.beforeValue) : (event.beforeValue || null);
    const afterStr = event.afterValue && typeof event.afterValue === "object" ? JSON.stringify(event.afterValue) : (event.afterValue || null);

    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, before_value, after_value, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.actorId || 1,
        event.actorRole || "system",
        event.action || "UNKNOWN_ACTION",
        event.targetType || "general",
        event.targetId ? String(event.targetId) : null,
        beforeStr,
        afterStr,
        detailsStr,
        event.ipAddress || null,
      ]
    );
  } catch (err) {
    console.error("Failed to log audit event:", err.message);
  }
}

module.exports = {
  MODULE_OPERATIONS,
  ALL_ALLOWED_PERMISSIONS,
  normalizePermissions,
  getTenantContext,
  hasPermission,
  logAuditEvent,
};
