const router = require("express").Router();
const { addCollection, listCollections, getSummary } = require("../controllers/collectionController");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", addCollection);
router.get("/", listCollections);
router.get("/summary", getSummary);

module.exports = router;
