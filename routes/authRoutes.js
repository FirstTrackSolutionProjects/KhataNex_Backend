const router = require("express").Router();
const { register, login, getMe, updateMe } = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");

router.post("/register", register);
router.post("/login", login);
router.get("/me", authenticate, getMe);
router.patch("/me", authenticate, updateMe);

module.exports = router;
