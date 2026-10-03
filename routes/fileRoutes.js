const router = require("express").Router();

const { getSecureFile } = require("../controllers/fileController");
const { authenticate, authorize } = require("../middleware/auth");

router.get(
  "/",
  authenticate,
  authorize("user", "employee", "superadmin"),
  getSecureFile
);

module.exports = router;
