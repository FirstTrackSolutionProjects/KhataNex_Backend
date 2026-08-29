const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");

const ensureRow = async () => {
  const [rows] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  if (rows.length) return rows[0];
  await pool.query("INSERT INTO company_settings (id) VALUES (1)");
  const [created] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  return created[0];
};

// GET /api/settings
const getSettings = asyncHandler(async (req, res) => {
  const settings = await ensureRow();
  res.json({ success: true, settings });
});

// PATCH /api/settings  (admin/superadmin)
const updateSettings = asyncHandler(async (req, res) => {
  await ensureRow();
  const { company_name, address, gstin } = req.body;
  await pool.query(
    `UPDATE company_settings SET
       company_name = COALESCE(?, company_name),
       address = COALESCE(?, address),
       gstin = COALESCE(?, gstin)
     WHERE id = 1`,
    [company_name || null, address || null, gstin || null]
  );
  const [rows] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  res.json({ success: true, settings: rows[0] });
});

// POST /api/settings/logo  (admin/superadmin, multipart field "logo")
const uploadLogo = asyncHandler(async (req, res) => {
  await ensureRow();
  if (!req.file) throw new ApiError(400, "No logo file uploaded (field name must be 'logo').");

  const logoPath = relativeUploadPath(req.file.path);
  await pool.query("UPDATE company_settings SET logo_path = ? WHERE id = 1", [logoPath]);
  res.json({ success: true, message: "Logo uploaded.", logo_path: logoPath });
});

module.exports = { getSettings, updateSettings, uploadLogo };
