const router = require("express").Router();
const { getKhata } = require("../controllers/khataController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/", getKhata);

module.exports = router;
