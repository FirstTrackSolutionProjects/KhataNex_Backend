const router = require("express").Router();
const { createTrip, startTrip, markReached, listTrips, getTrip } = require("../controllers/vehicleController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadVehicleTripFiles, uploadUnloadingPhoto } = require("../utils/upload");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.post("/", uploadVehicleTripFiles, createTrip);
router.get("/", listTrips);
router.get("/:id", getTrip);
router.patch("/:id/start-trip", startTrip);
router.patch("/:id/reached", uploadUnloadingPhoto.single("unloading_photo"), markReached);

module.exports = router;
