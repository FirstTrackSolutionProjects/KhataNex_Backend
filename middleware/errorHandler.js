const ApiError = require("../utils/ApiError");

// 404 handler — must be mounted after all routes
const notFound = (req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// Centralized error handler — must be mounted last
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // MySQL duplicate entry (e.g. email already exists)
  if (err.code === "ER_DUP_ENTRY") {
    statusCode = 409;
    message = "A record with this value already exists";
  }

  // MySQL foreign key violation
  if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_ROW_IS_REFERENCED_2") {
    statusCode = 400;
    message = "Invalid reference — related record does not exist";
  }

  // Multer file-upload errors (wrong field name, file too large, bad type)
  if (err.name === "MulterError") {
    statusCode = 400;
    message = `File upload error: ${err.message}`;
  }

  if (process.env.NODE_ENV !== "production") {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
  });
};

module.exports = { notFound, errorHandler };
