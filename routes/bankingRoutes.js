const router = require("express").Router();

const {
  createBanking,
  listBanking,
  getBanking,
  updateBanking,
  deleteBanking,
} = require("../controllers/bankingController");

const { authenticate, authorize } = require("../middleware/auth");

// Every banking route is super-admin-only.
router.use(authenticate, authorize("superadmin"));

router.post("/", createBanking);
router.get("/", listBanking);
router.get("/:id", getBanking);
router.patch("/:id", updateBanking);
router.delete("/:id", deleteBanking);

module.exports = router;
