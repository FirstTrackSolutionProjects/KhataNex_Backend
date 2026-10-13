const express = require("express");
const router = express.Router();
const { handlePaymentWebhook } = require("../controllers/paymentWebhookController");

// Razorpay payment webhook endpoint
router.post("/razorpay", handlePaymentWebhook);
router.post("/payments", handlePaymentWebhook); // Provider-agnostic alias

module.exports = router;

