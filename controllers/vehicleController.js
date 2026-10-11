const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");

const extractUploadedFile = (req, aliases) => {
  if (!req) return null;
  const list = [];
  if (Array.isArray(req.files)) {
    list.push(...req.files);
  } else if (req.files && typeof req.files === "object") {
    for (const key of Object.keys(req.files)) {
      if (Array.isArray(req.files[key])) list.push(...req.files[key]);
      else if (req.files[key]) list.push(req.files[key]);
    }
  }
  if (req.file) list.push(req.file);

  for (const alias of aliases) {
    const target = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = list.find((f) => {
      const fn = String(f.fieldname || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return fn === target;
    });
    if (match && Number(match.size) > 0) return match;
  }
  return null;
};

const isValidPathString = (val) => {
  if (typeof val !== "string") return false;
  const s = val.trim();
  if (!s || s === "null" || s === "undefined" || s === "[object Object]") return false;
  return true;
};

const enrichTrip = (trip) => {
  if (!trip) return null;
  const ewayFile = trip.eway_bill_file || trip.waybill_uploaded_file || null;
  const waybillUploaded = trip.waybill_uploaded_file || trip.eway_bill_file || null;
  return {
    ...trip,
    eway_bill: ewayFile,
    eway_bill_file: ewayFile,
    ewayBill: ewayFile,
    ewayBillFile: ewayFile,
    waybill_file: waybillUploaded,
    waybill_uploaded_file: waybillUploaded,
    waybillFile: waybillUploaded,
    loading_photo: trip.loading_photo || null,
    loadingPhoto: trip.loading_photo || null,
    unloading_photo: trip.unloading_photo || null,
    unloadingPhoto: trip.unloading_photo || null,
    vehicle_photo: trip.vehicle_photo || null,
    vehiclePhoto: trip.vehicle_photo || null,
    trip_photo: trip.trip_photo || null,
    tripPhoto: trip.trip_photo || null,
    eway_bill_number: trip.eway_bill_number || trip.waybill_number || null,
    ewayBillNumber: trip.eway_bill_number || trip.waybill_number || null,
    waybill_number: trip.waybill_number || trip.eway_bill_number || null,
    waybillNumber: trip.waybill_number || trip.eway_bill_number || null,
  };
};

// POST /api/vehicles
// multipart/form-data. Supports outgoing and incoming trips.
// Supports uploaded e-way bill file, vehicle photo, trip photo, loading and unloading photos.
const createTrip = asyncHandler(async (req, res) => {
  const {
    trip_type,
    vehicle_number,
    driver_name,
    driver_phone,
    from_location,
    to_location,
    goods_description,
    invoice_id,
    eway_bill_number,
    waybill_number,
    trip_datetime,
    departure_time,
    reach_time,
  } = req.body;

  const finalTripType = ["outgoing", "incoming"].includes(trip_type) ? trip_type : "outgoing";
  const finalInvoiceId = finalTripType === "incoming" ? null : (invoice_id ? Number(invoice_id) : null);

  const loadingPhotoFile = extractUploadedFile(req, [
    "loading_photo",
    "loadingPhoto",
    "loading_image",
    "loadingImage",
    "loadingPhotoFile",
    "loading",
    "photo",
  ]);
  const unloadingPhotoFile = extractUploadedFile(req, [
    "unloading_photo",
    "unloadingPhoto",
    "unloading_image",
    "unloadingImage",
    "unloadingPhotoFile",
    "unloading",
  ]);
  const ewayBillFile = extractUploadedFile(req, [
    "eway_bill_file",
    "eway_bill",
    "ewayBillFile",
    "ewayBill",
    "ewaybill_file",
    "ewaybill",
    "waybill_file",
    "waybill",
    "wayBill",
    "wayBillFile",
    "file",
    "document",
  ]);
  const vehiclePhotoFile = extractUploadedFile(req, [
    "vehicle_photo",
    "vehiclePhoto",
    "vehicle_image",
    "vehicleImage",
    "vehiclePhotoFile",
    "vehicle",
  ]);
  const tripPhotoFile = extractUploadedFile(req, [
    "trip_photo",
    "tripPhoto",
    "trip_image",
    "tripImage",
    "tripPhotoFile",
    "trip",
  ]);

  const loadingPhotoPath = loadingPhotoFile
    ? relativeUploadPath(loadingPhotoFile.path)
    : (isValidPathString(req.body.loading_photo || req.body.loadingPhoto)
      ? String(req.body.loading_photo || req.body.loadingPhoto).trim()
      : null);
  const unloadingPhotoPath = unloadingPhotoFile
    ? relativeUploadPath(unloadingPhotoFile.path)
    : (isValidPathString(req.body.unloading_photo || req.body.unloadingPhoto)
      ? String(req.body.unloading_photo || req.body.unloadingPhoto).trim()
      : null);
  const ewayBillFilePath = ewayBillFile
    ? relativeUploadPath(ewayBillFile.path)
    : (isValidPathString(req.body.eway_bill_file || req.body.eway_bill || req.body.waybill_file || req.body.waybill_uploaded_file)
      ? String(req.body.eway_bill_file || req.body.eway_bill || req.body.waybill_file || req.body.waybill_uploaded_file).trim()
      : null);
  const vehiclePhotoPath = vehiclePhotoFile
    ? relativeUploadPath(vehiclePhotoFile.path)
    : (isValidPathString(req.body.vehicle_photo || req.body.vehiclePhoto)
      ? String(req.body.vehicle_photo || req.body.vehiclePhoto).trim()
      : null);
  const tripPhotoPath = tripPhotoFile
    ? relativeUploadPath(tripPhotoFile.path)
    : (isValidPathString(req.body.trip_photo || req.body.tripPhoto)
      ? String(req.body.trip_photo || req.body.tripPhoto).trim()
      : null);

  const finalEwayBillNumber = eway_bill_number || waybill_number || req.body.ewayBillNumber || req.body.waybillNumber || null;

  const [result] = await pool.query(
    `INSERT INTO vehicle_trips
       (trip_type, vehicle_number, driver_name, driver_phone, from_location, to_location,
        goods_description, loading_photo, unloading_photo, waybill_uploaded_file,
        eway_bill_number, eway_bill_file, vehicle_photo, trip_photo,
        trip_datetime, departure_time, reach_time, invoice_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      finalTripType,
      vehicle_number || null,
      driver_name || null,
      driver_phone || null,
      from_location || null,
      to_location || null,
      goods_description || null,
      loadingPhotoPath,
      unloadingPhotoPath,
      ewayBillFilePath,
      finalEwayBillNumber,
      ewayBillFilePath,
      vehiclePhotoPath,
      tripPhotoPath,
      trip_datetime || null,
      departure_time || null,
      reach_time || null,
      finalInvoiceId,
      req.user.id,
    ]
  );
  const tripId = result.insertId;

  // Set waybill_number if provided (no synthetic KhataNex waybill generator)
  if (finalEwayBillNumber || waybill_number) {
    await pool.query(
      "UPDATE vehicle_trips SET waybill_number = COALESCE(waybill_number, ?) WHERE id = ? AND created_by = ?",
      [finalEwayBillNumber || waybill_number, tripId, req.user.id]
    );
  }

  const [finalRows] = await pool.query(
    `SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name
     FROM vehicle_trips v
     LEFT JOIN invoices i ON i.id = v.invoice_id
     WHERE v.id = ? AND v.created_by = ?`,
    [tripId, req.user.id]
  );
  res.status(201).json({ success: true, trip: enrichTrip(finalRows[0]) });
});

// PUT /api/vehicles/:id or PATCH /api/vehicles/:id
const updateTrip = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.query(
    "SELECT * FROM vehicle_trips WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );
  if (!existing.length) throw new ApiError(404, "Trip not found.");

  const current = existing[0];
  const {
    trip_type,
    vehicle_number,
    driver_name,
    driver_phone,
    from_location,
    to_location,
    goods_description,
    invoice_id,
    eway_bill_number,
    waybill_number,
    trip_datetime,
    departure_time,
    reach_time,
    status,
  } = req.body;

  const loadingPhotoFile = extractUploadedFile(req, [
    "loading_photo",
    "loadingPhoto",
    "loading_image",
    "loadingImage",
    "loadingPhotoFile",
    "loading",
    "photo",
  ]);
  const unloadingPhotoFile = extractUploadedFile(req, [
    "unloading_photo",
    "unloadingPhoto",
    "unloading_image",
    "unloadingImage",
    "unloadingPhotoFile",
    "unloading",
  ]);
  const ewayBillFile = extractUploadedFile(req, [
    "eway_bill_file",
    "eway_bill",
    "ewayBillFile",
    "ewayBill",
    "ewaybill_file",
    "ewaybill",
    "waybill_file",
    "waybill",
    "wayBill",
    "wayBillFile",
    "file",
    "document",
  ]);
  const vehiclePhotoFile = extractUploadedFile(req, [
    "vehicle_photo",
    "vehiclePhoto",
    "vehicle_image",
    "vehicleImage",
    "vehiclePhotoFile",
    "vehicle",
  ]);
  const tripPhotoFile = extractUploadedFile(req, [
    "trip_photo",
    "tripPhoto",
    "trip_image",
    "tripImage",
    "tripPhotoFile",
    "trip",
  ]);

  const resolveField = (newFile, bodyVal, currentVal) => {
    if (newFile) return relativeUploadPath(newFile.path);
    if (bodyVal !== undefined) {
      if (isValidPathString(bodyVal)) return String(bodyVal).trim();
      if (bodyVal === "" || bodyVal === null || bodyVal === "null") return null;
    }
    return currentVal;
  };

  const loadingPhotoPath = resolveField(
    loadingPhotoFile,
    req.body.loading_photo || req.body.loadingPhoto,
    current.loading_photo
  );
  const unloadingPhotoPath = resolveField(
    unloadingPhotoFile,
    req.body.unloading_photo || req.body.unloadingPhoto,
    current.unloading_photo
  );
  const ewayBillFilePath = resolveField(
    ewayBillFile,
    req.body.eway_bill_file || req.body.eway_bill || req.body.waybill_file || req.body.waybill_uploaded_file,
    current.eway_bill_file || current.waybill_uploaded_file
  );
  const waybillUploadedPath = ewayBillFilePath;
  const vehiclePhotoPath = resolveField(
    vehiclePhotoFile,
    req.body.vehicle_photo || req.body.vehiclePhoto,
    current.vehicle_photo
  );
  const tripPhotoPath = resolveField(
    tripPhotoFile,
    req.body.trip_photo || req.body.tripPhoto,
    current.trip_photo
  );

  const targetTripType = trip_type !== undefined ? trip_type : current.trip_type;
  const targetInvoiceId =
    targetTripType === "incoming"
      ? null
      : invoice_id !== undefined
      ? (invoice_id ? Number(invoice_id) : null)
      : current.invoice_id;

  const targetEwayNumber = eway_bill_number !== undefined
    ? (eway_bill_number || null)
    : (waybill_number !== undefined ? (waybill_number || null) : current.eway_bill_number);
  const targetWaybillNumber = waybill_number !== undefined
    ? (waybill_number || null)
    : (eway_bill_number !== undefined ? (eway_bill_number || null) : current.waybill_number);

  await pool.query(
    `UPDATE vehicle_trips
     SET trip_type = COALESCE(?, trip_type),
         vehicle_number = COALESCE(?, vehicle_number),
         driver_name = COALESCE(?, driver_name),
         driver_phone = COALESCE(?, driver_phone),
         from_location = COALESCE(?, from_location),
         to_location = COALESCE(?, to_location),
         goods_description = COALESCE(?, goods_description),
         invoice_id = ?,
         eway_bill_number = ?,
         waybill_number = ?,
         trip_datetime = COALESCE(?, trip_datetime),
         departure_time = COALESCE(?, departure_time),
         reach_time = COALESCE(?, reach_time),
         status = COALESCE(?, status),
         loading_photo = ?,
         unloading_photo = ?,
         waybill_uploaded_file = ?,
         eway_bill_file = ?,
         vehicle_photo = ?,
         trip_photo = ?
     WHERE id = ? AND created_by = ?`,
    [
      trip_type !== undefined ? trip_type : null,
      vehicle_number !== undefined ? vehicle_number : null,
      driver_name !== undefined ? driver_name : null,
      driver_phone !== undefined ? driver_phone : null,
      from_location !== undefined ? from_location : null,
      to_location !== undefined ? to_location : null,
      goods_description !== undefined ? goods_description : null,
      targetInvoiceId,
      targetEwayNumber,
      targetWaybillNumber,
      trip_datetime || null,
      departure_time || null,
      reach_time || null,
      status || null,
      loadingPhotoPath,
      unloadingPhotoPath,
      waybillUploadedPath,
      ewayBillFilePath,
      vehiclePhotoPath,
      tripPhotoPath,
      id,
      req.user.id,
    ]
  );

  const [updated] = await pool.query(
    `SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name
     FROM vehicle_trips v
     LEFT JOIN invoices i ON i.id = v.invoice_id
     WHERE v.id = ? AND v.created_by = ?`,
    [id, req.user.id]
  );
  res.json({ success: true, message: "Vehicle trip updated successfully.", trip: enrichTrip(updated[0]) });
});

// DELETE /api/vehicles/:id
const deleteTrip = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.query(
    "SELECT * FROM vehicle_trips WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );
  if (!existing.length) throw new ApiError(404, "Trip not found.");

  await pool.query(
    "DELETE FROM vehicle_trips WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  res.json({ success: true, message: "Vehicle trip deleted successfully." });
});

// PATCH /api/vehicles/:id/start-trip
const startTrip = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query("SELECT * FROM vehicle_trips WHERE id = ? AND created_by = ?", [id, req.user.id]);
  if (!rows.length) throw new ApiError(404, "Trip not found.");

  await pool.query(
    "UPDATE vehicle_trips SET journey_start_time = NOW(), departure_time = COALESCE(departure_time, NOW()), status = 'in_transit' WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );
  const [updated] = await pool.query(
    `SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name
     FROM vehicle_trips v
     LEFT JOIN invoices i ON i.id = v.invoice_id
     WHERE v.id = ? AND v.created_by = ?`,
    [id, req.user.id]
  );
  res.json({ success: true, trip: enrichTrip(updated[0]) });
});

// PATCH /api/vehicles/:id/reached
const markReached = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query("SELECT * FROM vehicle_trips WHERE id = ? AND created_by = ?", [id, req.user.id]);
  if (!rows.length) throw new ApiError(404, "Trip not found.");

  const unloadingPhotoFile = extractUploadedFile(req, [
    "unloading_photo",
    "unloadingPhoto",
    "unloading_image",
    "unloadingImage",
    "unloadingPhotoFile",
    "unloading",
    "photo",
    "file",
  ]) || req.file;

  const unloadingPhotoPath = unloadingPhotoFile
    ? relativeUploadPath(unloadingPhotoFile.path)
    : (isValidPathString(req.body.unloading_photo || req.body.unloadingPhoto)
      ? String(req.body.unloading_photo || req.body.unloadingPhoto).trim()
      : null);

  await pool.query(
    "UPDATE vehicle_trips SET journey_end_time = NOW(), reach_time = COALESCE(reach_time, NOW()), status = 'completed', unloading_photo = COALESCE(?, unloading_photo) WHERE id = ? AND created_by = ?",
    [unloadingPhotoPath, id, req.user.id]
  );
  const [updated] = await pool.query(
    `SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name
     FROM vehicle_trips v
     LEFT JOIN invoices i ON i.id = v.invoice_id
     WHERE v.id = ? AND v.created_by = ?`,
    [id, req.user.id]
  );
  res.json({ success: true, trip: enrichTrip(updated[0]) });
});

// GET /api/vehicles?trip_type=&status=&vehicle_number=
const listTrips = asyncHandler(async (req, res) => {
  const { trip_type, status, vehicle_number } = req.query;
  let sql = `
    SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name, u.name AS added_by
    FROM vehicle_trips v
    LEFT JOIN invoices i ON i.id = v.invoice_id
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.created_by = ?
  `;
  const params = [req.user.id];
  if (trip_type) {
    sql += " AND v.trip_type = ?";
    params.push(trip_type);
  }
  if (status) {
    sql += " AND v.status = ?";
    params.push(status);
  }
  if (vehicle_number) {
    sql += " AND v.vehicle_number LIKE ?";
    params.push(`%${vehicle_number}%`);
  }
  sql += " ORDER BY v.created_at DESC";

  const [rows] = await pool.query(sql, params);
  const enriched = rows.map(enrichTrip);
  res.json({
    success: true,
    count: enriched.length,
    vehicles: enriched,
    trips: enriched,
    data: enriched,
  });
});

// GET /api/vehicles/invoices
const getAvailableInvoices = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, invoice_number, total_amount, invoice_date, to_name, to_phone, created_at
     FROM invoices
     WHERE created_by = ?
     ORDER BY invoice_date DESC, id DESC`,
    [req.user.id]
  );
  res.json({
    success: true,
    count: rows.length,
    invoices: rows,
    data: rows,
  });
});

// GET /api/vehicles/:id
const getTrip = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT v.*, i.invoice_number, i.total_amount AS invoice_total, i.invoice_date, i.to_name AS invoice_customer_name
     FROM vehicle_trips v
     LEFT JOIN invoices i ON i.id = v.invoice_id
     WHERE v.id = ? AND v.created_by = ?`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) throw new ApiError(404, "Trip not found.");
  res.json({ success: true, trip: enrichTrip(rows[0]) });
});

module.exports = {
  createTrip,
  updateTrip,
  deleteTrip,
  startTrip,
  markReached,
  listTrips,
  getTrip,
  getAvailableInvoices,
};
