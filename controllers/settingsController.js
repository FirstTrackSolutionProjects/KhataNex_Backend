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
  let watermarkEnabled = 1;
  if (req.user?.id) {
    const [userRows] = await pool.query(
      "SELECT watermark_enabled FROM users WHERE id = ?",
      [req.user.id]
    );
    if (
      userRows.length &&
      userRows[0].watermark_enabled !== null &&
      userRows[0].watermark_enabled !== undefined
    ) {
      watermarkEnabled = Number(userRows[0].watermark_enabled) === 0 ? 0 : 1;
    } else if (settings.watermark_enabled !== null && settings.watermark_enabled !== undefined) {
      watermarkEnabled = Number(settings.watermark_enabled) === 0 ? 0 : 1;
    }
  } else if (settings.watermark_enabled !== null && settings.watermark_enabled !== undefined) {
    watermarkEnabled = Number(settings.watermark_enabled) === 0 ? 0 : 1;
  }

  settings.watermark_enabled = watermarkEnabled;
  settings.remove_watermark = watermarkEnabled === 0 ? 1 : 0;
  settings.show_watermark = watermarkEnabled === 1 ? 1 : 0;

  res.json({ success: true, settings });
});

// PATCH / PUT / POST /api/settings  (authenticated user/employee/superadmin)
const updateSettings = asyncHandler(async (req, res) => {
  await ensureRow();
  const {
    company_name,
    address,
    gstin,
    watermark_enabled,
    remove_watermark,
    show_watermark,
    watermark,
    enable_watermark,
  } = req.body;

  let effectiveWatermark = null;
  if (remove_watermark !== undefined && remove_watermark !== null) {
    effectiveWatermark =
      remove_watermark === 1 ||
      remove_watermark === true ||
      remove_watermark === "1" ||
      remove_watermark === "true"
        ? 0
        : 1;
  } else if (watermark_enabled !== undefined && watermark_enabled !== null) {
    effectiveWatermark =
      watermark_enabled === 1 ||
      watermark_enabled === true ||
      watermark_enabled === "1" ||
      watermark_enabled === "true"
        ? 1
        : 0;
  } else if (show_watermark !== undefined && show_watermark !== null) {
    effectiveWatermark =
      show_watermark === 1 ||
      show_watermark === true ||
      show_watermark === "1" ||
      show_watermark === "true"
        ? 1
        : 0;
  } else if (watermark !== undefined && watermark !== null) {
    effectiveWatermark =
      watermark === 1 || watermark === true || watermark === "1" || watermark === "true"
        ? 1
        : 0;
  } else if (enable_watermark !== undefined && enable_watermark !== null) {
    effectiveWatermark =
      enable_watermark === 1 ||
      enable_watermark === true ||
      enable_watermark === "1" ||
      enable_watermark === "true"
        ? 1
        : 0;
  }

  await pool.query(
    `UPDATE company_settings SET
       company_name = COALESCE(?, company_name),
       address = COALESCE(?, address),
       gstin = COALESCE(?, gstin),
       watermark_enabled = COALESCE(?, watermark_enabled)
     WHERE id = 1`,
    [
      company_name || null,
      address || null,
      gstin || null,
      effectiveWatermark,
    ]
  );

  if (effectiveWatermark !== null && req.user?.id) {
    await pool.query("UPDATE users SET watermark_enabled = ? WHERE id = ?", [effectiveWatermark, req.user.id]);
  }

  const [rows] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  const finalSettings = rows[0] || {};
  if (effectiveWatermark !== null) {
    finalSettings.watermark_enabled = effectiveWatermark;
  } else if (finalSettings.watermark_enabled === null || finalSettings.watermark_enabled === undefined) {
    finalSettings.watermark_enabled = 1;
  }
  finalSettings.remove_watermark = Number(finalSettings.watermark_enabled) === 0 ? 1 : 0;
  finalSettings.show_watermark = Number(finalSettings.watermark_enabled) === 1 ? 1 : 0;

  res.json({ success: true, settings: finalSettings });
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
