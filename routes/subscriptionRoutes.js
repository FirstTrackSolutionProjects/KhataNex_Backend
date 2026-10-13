const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { authenticate } = require("../middleware/auth");
const {
  listPlans,
  previewPrice,
  createOrder,
  verifyOrderPayment,
  getOrder,
  getMySubscription,
  downloadInvoice,
  resendInvoice,
} = require("../controllers/subscriptionController");

// Rate limiters for financial endpoints
const priceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many price requests. Please wait a moment." },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many order creation attempts. Please wait a moment." },
});

const invoiceResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many invoice resend requests. Please check your inbox or try later." },
});

// Middleware for optional JWT authentication (e.g. for /plans to compute intro offer if user is logged in)
const optionalAuthenticate = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT id, name, email, role, employee_role_type, permissions, status FROM users WHERE id = ?",
      [decoded.id]
    );
    if (rows[0] && rows[0].status === "active") {
      req.user = rows[0];
    }
  } catch (_) {
    // Ignore invalid token on optional endpoints
  }
  next();
};

// Endpoints
router.get("/plans", optionalAuthenticate, listPlans);
router.post("/price", authenticate, priceLimiter, previewPrice);
router.post("/orders", authenticate, orderLimiter, createOrder);
router.post("/orders/:id/verify", authenticate, verifyOrderPayment);
router.get("/orders/:id", authenticate, getOrder);
router.get("/me", authenticate, getMySubscription);
router.get("/orders/:id/invoice", authenticate, downloadInvoice);
router.post("/orders/:id/invoice/resend", authenticate, invoiceResendLimiter, resendInvoice);

module.exports = router;

