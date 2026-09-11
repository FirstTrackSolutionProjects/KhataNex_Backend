const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// POST /api/banking
const createBanking = asyncHandler(async (req, res) => {
  const { bank_name, branch, ifsc_code } = req.body;

  const [result] = await pool.query(
    "INSERT INTO banking (bank_name, branch, ifsc_code, created_by) VALUES (?, ?, ?, ?)",
    [
      bank_name || null,
      branch || null,
      ifsc_code || null,
      req.user?.id || null,
    ]
  );

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ?",
    [result.insertId]
  );

  res.status(201).json({
    success: true,
    banking: rows[0],
  });
});

// GET /api/banking
const listBanking = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, u.name AS created_by_name
     FROM banking b
     LEFT JOIN users u ON u.id = b.created_by
     ORDER BY b.bank_name ASC, b.branch ASC`
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

  const [rows] = await pool.query(
    "SELECT * FROM banking WHERE id = ?",
    [id]
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
  const { bank_name, branch, ifsc_code } = req.body;
  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT id FROM banking WHERE id = ?",
    [id]
  );

  if (!rows.length) {
    throw new ApiError(404, "Banking record not found.");
  }

  await pool.query(
    `UPDATE banking
     SET bank_name = COALESCE(?, bank_name),
         branch = COALESCE(?, branch),
         ifsc_code = COALESCE(?, ifsc_code)
     WHERE id = ?`,
    [
      bank_name || null,
      branch || null,
      ifsc_code || null,
      id,
    ]
  );

  res.json({
    success: true,
    message: "Banking details updated.",
  });
});

// DELETE /api/banking/:id
const deleteBanking = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT id FROM banking WHERE id = ?",
    [id]
  );

  if (!rows.length) {
    throw new ApiError(404, "Banking record not found.");
  }

  await pool.query(
    "DELETE FROM banking WHERE id = ?",
    [id]
  );

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
