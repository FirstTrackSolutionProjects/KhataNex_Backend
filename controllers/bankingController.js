const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// POST /api/banking
const createBanking = asyncHandler(async (req, res) => {
  const {
    bank_name,
    account_holder_name,
    account_number,
    account_type,
    branch,
    ifsc_code,
    is_default,
  } = req.body;

  const userId = req.user?.id;

  if (!userId) {
    throw new ApiError(401, "Authentication required.");
  }

  const [existing] = await pool.query(
    "SELECT COUNT(*) AS count FROM banking WHERE created_by = ?",
    [userId]
  );

  const shouldBeDefault =
    Boolean(is_default) || Number(existing[0].count) === 0;

  if (shouldBeDefault) {
    await pool.query(
      "UPDATE banking SET is_default = 0 WHERE created_by = ?",
      [userId]
    );
  }

  const [result] = await pool.query(
    `INSERT INTO banking
      (bank_name, account_holder_name, account_number, account_type,
       branch, ifsc_code, is_default, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bank_name || null,
      account_holder_name || null,
      account_number || null,
      account_type || null,
      branch || null,
      ifsc_code || null,
      shouldBeDefault ? 1 : 0,
      userId,
    ]
  );

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ? AND created_by = ?",
    [result.insertId, userId]
  );

  res.status(201).json({
    success: true,
    banking: rows[0],
  });
});

// GET /api/banking
const listBanking = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  const [rows] = await pool.query(
    `SELECT b.*, u.name AS created_by_name
     FROM banking b
     LEFT JOIN users u ON u.id = b.created_by
     WHERE b.created_by = ?
     ORDER BY b.is_default DESC, b.bank_name ASC, b.branch ASC`,
    [userId]
  );

  res.json({
    success: true,
    count: rows.length,
    banking: rows,
  });
});

// GET /api/banking/:id
const getBanking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ? AND created_by = ?",
    [id, userId]
  );

  if (!rows.length) {
    throw new ApiError(404, "Banking record not found.");
  }

  res.json({
    success: true,
    banking: rows[0],
  });
});

// PATCH /api/banking/:id
const updateBanking = asyncHandler(async (req, res) => {
  const {
    bank_name,
    account_holder_name,
    account_number,
    account_type,
    branch,
    ifsc_code,
    is_default,
  } = req.body;

  const { id } = req.params;
  const userId = req.user?.id;

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ? AND created_by = ?",
    [id, userId]
  );

  if (!rows.length) {
    throw new ApiError(404, "Banking record not found.");
  }

  const current = rows[0];

  if (Boolean(is_default)) {
    await pool.query(
      "UPDATE banking SET is_default = 0 WHERE created_by = ?",
      [userId]
    );
  }

  await pool.query(
    `UPDATE banking
     SET bank_name = ?,
         account_holder_name = ?,
         account_number = ?,
         account_type = ?,
         branch = ?,
         ifsc_code = ?,
         is_default = ?
     WHERE id = ? AND created_by = ?`,
    [
      bank_name !== undefined ? bank_name || null : current.bank_name,
      account_holder_name !== undefined
        ? account_holder_name || null
        : current.account_holder_name,
      account_number !== undefined
        ? account_number || null
        : current.account_number,
      account_type !== undefined
        ? account_type || null
        : current.account_type,
      branch !== undefined ? branch || null : current.branch,
      ifsc_code !== undefined ? ifsc_code || null : current.ifsc_code,
      is_default !== undefined
        ? Boolean(is_default)
          ? 1
          : 0
        : current.is_default,
      id,
      userId,
    ]
  );

  // Never leave the user without a default if this was their only/default account.
  if (!Boolean(is_default) && current.is_default) {
    const [defaults] = await pool.query(
      "SELECT id FROM banking WHERE created_by = ? AND is_default = 1 LIMIT 1",
      [userId]
    );

    if (!defaults.length) {
      await pool.query(
        "UPDATE banking SET is_default = 1 WHERE id = ? AND created_by = ?",
        [id, userId]
      );
    }
  }

  const [updated] = await pool.query(
    "SELECT * FROM banking WHERE id = ? AND created_by = ?",
    [id, userId]
  );

  res.json({
    success: true,
    message: "Banking details updated.",
    banking: updated[0],
  });
});

// DELETE /api/banking/:id
const deleteBanking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ? AND created_by = ?",
    [id, userId]
  );

  if (!rows.length) {
    throw new ApiError(404, "Banking record not found.");
  }

  const wasDefault = Boolean(rows[0].is_default);

  await pool.query(
    "DELETE FROM banking WHERE id = ? AND created_by = ?",
    [id, userId]
  );

  if (wasDefault) {
    const [next] = await pool.query(
      `SELECT id
       FROM banking
       WHERE created_by = ?
       ORDER BY id ASC
       LIMIT 1`,
      [userId]
    );

    if (next.length) {
      await pool.query(
        "UPDATE banking SET is_default = 1 WHERE id = ? AND created_by = ?",
        [next[0].id, userId]
      );
    }
  }

  res.json({
    success: true,
    message: "Banking record deleted.",
  });
});

module.exports = {
  createBanking,
  listBanking,
  getBanking,
  updateBanking,
  deleteBanking,
};
