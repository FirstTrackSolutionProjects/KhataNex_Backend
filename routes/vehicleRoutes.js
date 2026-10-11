const router = require("express").Router();
const {
  createTrip,
  updateTrip,
  deleteTrip,
  startTrip,
  markReached,
  listTrips,
  getTrip,
  getAvailableInvoices,
} = require("../controllers/vehicleController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadVehicleTripFiles, uploadUnloadingPhoto } = require("../utils/upload");

router.use(authenticate, authorize("user", "employee", "superadmin"));

router.get("/invoices", getAvailableInvoices);
router.post("/", uploadVehicleTripFiles, createTrip);
router.get("/", listTrips);
router.get("/:id", getTrip);
router.put("/:id", uploadVehicleTripFiles, updateTrip);
router.patch("/:id", uploadVehicleTripFiles, updateTrip);
router.post("/:id", uploadVehicleTripFiles, updateTrip);
router.post("/:id/update", uploadVehicleTripFiles, updateTrip);
router.delete("/:id", deleteTrip);
router.patch("/:id/start-trip", startTrip);
router.patch("/:id/reached", uploadVehicleTripFiles, markReached);
router.post("/:id/reached", uploadVehicleTripFiles, markReached);

module.exports = router;
