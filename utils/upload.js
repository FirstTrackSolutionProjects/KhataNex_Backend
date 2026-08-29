const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");

// Make sure every subfolder we use actually exists on disk.
["logos", "loading-photos", "unloading-photos", "waybills-uploaded", "waybills-generated", "purchase-invoices", "invoices"].forEach(
  (dir) => {
    const full = path.join(UPLOAD_ROOT, dir);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }
);

const storage = (subfolder) =>
  multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, subfolder)),
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    },
  });

const imageFilter = (req, file, cb) => {
  if (/^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files (jpg, png, webp) are allowed here."));
};

const documentFilter = (req, file, cb) => {
  if (/^image\/(jpe?g|png|webp)$/i.test(file.mimetype) || file.mimetype === "application/pdf") {
    return cb(null, true);
  }
  cb(new Error("Only image or PDF files are allowed here."));
};

const maxSize = (mb) => ({ fileSize: mb * 1024 * 1024 });

// Named uploaders — pick the one matching what's being uploaded.
const uploadLogo = multer({ storage: storage("logos"), fileFilter: imageFilter, limits: maxSize(5) });
const uploadLoadingPhoto = multer({ storage: storage("loading-photos"), fileFilter: imageFilter, limits: maxSize(10) });
const uploadUnloadingPhoto = multer({ storage: storage("unloading-photos"), fileFilter: imageFilter, limits: maxSize(10) });
const uploadWaybillDoc = multer({ storage: storage("waybills-uploaded"), fileFilter: documentFilter, limits: maxSize(10) });
const uploadPurchaseInvoiceDoc = multer({
  storage: storage("purchase-invoices"),
  fileFilter: documentFilter,
  limits: maxSize(10),
});

// For the vehicle-trip create route, which needs up to 2 files at once
// (loading_photo for outgoing, waybill_file for incoming) depending on
// trip_type — handled generically with .fields() and validated in the
// controller since the "which is mandatory" rule depends on trip_type.
// destination is picked per-field so each file lands in the right folder.
const vehicleTripStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === "waybill_file" ? "waybills-uploaded" : "loading-photos";
    cb(null, path.join(UPLOAD_ROOT, folder));
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const uploadVehicleTripFiles = multer({
  storage: vehicleTripStorage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "waybill_file") return documentFilter(req, file, cb);
    return imageFilter(req, file, cb);
  },
  limits: maxSize(10),
}).fields([
  { name: "loading_photo", maxCount: 1 },
  { name: "waybill_file", maxCount: 1 },
]);

const relativeUploadPath = (absPath) => {
  if (!absPath) return null;
  return "/uploads/" + path.relative(UPLOAD_ROOT, absPath).split(path.sep).join("/");
};

module.exports = {
  UPLOAD_ROOT,
  uploadLogo,
  uploadLoadingPhoto,
  uploadUnloadingPhoto,
  uploadWaybillDoc,
  uploadPurchaseInvoiceDoc,
  uploadVehicleTripFiles,
  relativeUploadPath,
};
