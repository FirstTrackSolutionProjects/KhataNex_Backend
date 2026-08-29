const router = require("express").Router();
const { getSettings, updateSettings, uploadLogo } = require("../controllers/settingsController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadLogo: logoUploader } = require("../utils/upload");

router.get("/", authenticate, getSettings);
router.patch("/", authenticate, authorize("employee", "superadmin"), updateSettings);
router.post("/logo", authenticate, authorize("employee", "superadmin"), logoUploader.single("logo"), uploadLogo);

module.exports = router;
