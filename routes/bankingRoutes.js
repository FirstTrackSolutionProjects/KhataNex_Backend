const router = require("express").Router();

const {
  createBanking,
  listBanking,
  getBanking,
  updateBanking,
  deleteBanking,
  setDefaultBanking,
} = require("../controllers/bankingController");

const { authenticate, authorize } = require("../middleware/auth");

// Banking routes are available to authenticated users.
router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", createBanking);
router.get("/", listBanking);
router.get("/:id", getBanking);
router.put("/:id", updateBanking);
router.patch("/:id", updateBanking);
router.delete("/:id", deleteBanking);

// Default bank endpoints
router.post("/:id/default", setDefaultBanking);
router.patch("/:id/default", setDefaultBanking);
router.put("/:id/default", setDefaultBanking);

module.exports = router;
