const router = require("express").Router();

const {
  register,
  login,
  getMe,
  updateMe,
  uploadProfileLogo,
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

router.get("/me", authenticate, getMe);

router.patch("/me", authenticate, updateMe);

module.exports = router;
