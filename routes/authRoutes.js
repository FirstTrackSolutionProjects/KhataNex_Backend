const router = require("express").Router();

const {
  register,
  login,
  getMe,
  updateMe,
  uploadProfileLogo,
  uploadProfileSignature,
  deleteProfileSignature,
} = require("../controllers/authController");

const { authenticate } = require("../middleware/auth");
const { uploadLogo: logoUploader } = require("../utils/upload");

router.post("/register", register);

router.post("/login", login);

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