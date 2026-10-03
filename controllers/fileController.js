const fs = require("fs");
const path = require("path");

const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { UPLOAD_ROOT } = require("../utils/upload");

const normalizeUploadPath = (value) => {
  if (!value || typeof value !== "string") {
    throw new ApiError(400, "Invalid file path.");
  }

  let decoded = value;

  try {
    let previous;
    do {
      previous = decoded;
      decoded = decodeURIComponent(decoded);
    } while (decoded !== previous);
  } catch (err) {
    throw new ApiError(400, "Invalid file path.");
  }

  decoded = decoded.replace(/\\/g, "/");

  if (!decoded.startsWith("/uploads/")) {
    throw new ApiError(400, "Invalid file path.");
  }

  if (
    decoded.includes("\0") ||
    decoded.includes("../") ||
    decoded.includes("/..") ||
    decoded.includes("..\\")
  ) {
    throw new ApiError(400, "Invalid file path.");
  }

  return decoded;
};

const resolveOwnedFile = async (relativePath, userId) => {
  const legacyRelativePath = relativePath.replace(/#/g, "%23");

  const queries = [
    {
      sql: `
        SELECT logo_path AS file_path
        FROM users
        WHERE id = ?
          AND logo_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT signature_path AS file_path
        FROM users
        WHERE id = ?
          AND signature_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT profile_photo_path AS file_path
        FROM users
        WHERE id = ?
          AND profile_photo_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT pdf_path AS file_path
        FROM invoices
        WHERE created_by = ?
          AND pdf_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT pdf_path AS file_path
        FROM quotations
        WHERE created_by = ?
          AND pdf_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT pdf_path AS file_path
        FROM money_receipts
        WHERE created_by = ?
          AND pdf_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT invoice_file AS file_path
        FROM purchase_invoices
        WHERE created_by = ?
          AND invoice_file IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT loading_photo AS file_path
        FROM vehicle_trips
        WHERE created_by = ?
          AND loading_photo IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT unloading_photo AS file_path
        FROM vehicle_trips
        WHERE created_by = ?
          AND unloading_photo IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT waybill_pdf_path AS file_path
        FROM vehicle_trips
        WHERE created_by = ?
          AND waybill_pdf_path IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
    {
      sql: `
        SELECT waybill_uploaded_file AS file_path
        FROM vehicle_trips
        WHERE created_by = ?
          AND waybill_uploaded_file IN (?, ?)
        LIMIT 1
      `,
      params: [userId, relativePath, legacyRelativePath],
    },
  ];

  for (const query of queries) {
    const [rows] = await pool.query(query.sql, query.params);

    if (rows.length) {
      const storedPath = rows[0].file_path;
      const normalizedStoredPath = normalizeUploadPath(storedPath);

      if (normalizedStoredPath !== relativePath) {
        continue;
      }

      const relative = relativePath.replace(/^\/uploads\//, "");
      const absolutePath = path.resolve(UPLOAD_ROOT, relative);

      const uploadRootResolved = path.resolve(UPLOAD_ROOT);

      if (
        absolutePath !== uploadRootResolved &&
        !absolutePath.startsWith(uploadRootResolved + path.sep)
      ) {
        throw new ApiError(400, "Invalid file path.");
      }

      return absolutePath;
    }
  }

  throw new ApiError(404, "File not found.");
};

const getSecureFile = asyncHandler(async (req, res) => {
  const relativePath = normalizeUploadPath(req.query.path);

  let ownerId = req.user.id;

  if (req.query.user_id !== undefined) {
    if (req.user.role !== "superadmin") {
      throw new ApiError(403, "Only super admins can access selected user files.");
    }

    const requestedUserId = Number(req.query.user_id);

    if (!Number.isInteger(requestedUserId) || requestedUserId <= 0) {
      throw new ApiError(400, "Invalid user ID.");
    }

    const [userRows] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role = 'user' LIMIT 1",
      [requestedUserId]
    );

    if (!userRows.length) {
      throw new ApiError(404, "User not found.");
    }

    ownerId = requestedUserId;
  }

  const absolutePath = await resolveOwnedFile(relativePath, ownerId);

  let stat;

  try {
    stat = await fs.promises.stat(absolutePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new ApiError(404, "File not found.");
    }

    throw err;
  }

  if (!stat.isFile()) {
    throw new ApiError(404, "File not found.");
  }

  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (absolutePath.toLowerCase().endsWith(".pdf")) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
  }

  res.sendFile(absolutePath);
});

module.exports = {
  getSecureFile,
};
