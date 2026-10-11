const router = require("express").Router();
const { getSettings, updateSettings, uploadLogo } = require("../controllers/settingsController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadLogo: logoUploader } = require("../utils/upload");

router.get("/", authenticate, getSettings);
router.patch("/", authenticate, authorize("user", "employee", "superadmin"), updateSettings);
router.put("/", authenticate, authorize("user", "employee", "superadmin"), updateSettings);
router.post("/", authenticate, authorize("user", "employee", "superadmin"), updateSettings);
router.post("/regenerate", authenticate, authorize("user", "employee", "superadmin"), updateSettings);
router.post("/logo", authenticate, authorize("user", "employee", "superadmin"), logoUploader.single("logo"), uploadLogo);

module.exports = router;
