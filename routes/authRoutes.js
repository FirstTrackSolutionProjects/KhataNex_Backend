const router = require("express").Router();

const {
  register,
  login,
  login2FA,
  getMe,
  updateMe,
  uploadProfileLogo,
  uploadProfileSignature,
  deleteProfileSignature,
  get2FAStatus,
  setup2FA,
  verify2FASetup,
  disable2FA,
  regenerate2FARecoveryCodes,
} = require("../controllers/authController");

const { authenticate } = require("../middleware/auth");
const { uploadLogo: logoUploader } = require("../utils/upload");

router.post("/register", register);
router.post("/login", login);
router.post("/login/2fa", login2FA);

// Two-Step Verification (2FA) authenticated routes
router.get("/2fa/status", authenticate, get2FAStatus);
router.post("/2fa/setup", authenticate, setup2FA);
router.post("/2fa/verify-setup", authenticate, verify2FASetup);
router.post("/2fa/disable", authenticate, disable2FA);
router.post("/2fa/recovery-codes/regenerate", authenticate, regenerate2FARecoveryCodes);

router.post(
  "/me/logo",
  authenticate,
  logoUploader.single("logo"),
  uploadProfileLogo
);

router.post(
  "/me/signature",
  authenticate,
  logoUploader.single("signature"),
  uploadProfileSignature
);

router.delete(
  "/me/signature",
  authenticate,
  deleteProfileSignature
);

router.get("/me", authenticate, getMe);

router.patch("/me", authenticate, updateMe);

module.exports = router;