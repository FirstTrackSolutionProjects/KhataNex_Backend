require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { notFound, errorHandler } = require("./middleware/errorHandler");

const authRoutes = require("./routes/authRoutes");
const contactRoutes = require("./routes/contactRoutes");
const superAdminRoutes = require("./routes/superAdminRoutes");
const customerRoutes = require("./routes/customerRoutes");
const collectionRoutes = require("./routes/collectionRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const stockRoutes = require("./routes/stockRoutes");
const expenseRoutes = require("./routes/expenseRoutes");
const reportRoutes = require("./routes/reportRoutes");
const purchaseInvoiceRoutes = require("./routes/purchaseInvoiceRoutes");
const purchaseBillRoutes = require("./routes/purchaseBillRoutes");
const documentRoutes = require("./routes/documentRoutes");
const vehicleRoutes = require("./routes/vehicleRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const khataRoutes = require("./routes/khataRoutes");
const bankingRoutes = require("./routes/bankingRoutes");
const fileRoutes = require("./routes/fileRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const paymentWebhookRoutes = require("./routes/paymentWebhookRoutes");
const billingAdminRoutes = require("./routes/billingAdminRoutes");
const helpCentreRoutes = require("./routes/helpCentreRoutes");
const superAdminDashboardRoutes = require("./routes/superAdminDashboardRoutes");
const emailService = require("./services/emailService");
const { requireActiveSubscription } = require("./middleware/requireSubscription");

const app = express();

// Start background durable email queue worker (sweeps every 60s)
emailService.startQueueWorker(60000);

//*app.use(helmet({ crossOriginResourcePolicy: false })); // allow serving /uploads images/PDFs cross-origin to the frontend

// CORS: kept intentionally open (no security hardening yet, by request).
// Once ready, restrict via FRONTEND_URL in .env, e.g.:
//   cors({ origin: process.env.FRONTEND_URL })

// * app.use(cors());
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: false,
    contentSecurityPolicy: false,
  })
);

app.use(cors({
  origin: process.env.FRONTEND_URL, // dynamically reflects the requesting origin (great for local dev)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  
}));

app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(path.join(__dirname, "uploads"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline");
      }
    },
  })
);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));


app.get("/", (req, res) => {
  res.json({ success: true, message: "FIRST TRACK KHATANEX API is running." });
});
app.get("/api/health", (req, res) => res.json({ success: true, status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/superadmin/billing", billingAdminRoutes);
app.use("/api/super-admin/billing", billingAdminRoutes);
app.use("/api/superadmin/dashboard", superAdminDashboardRoutes);
app.use("/api/super-admin/dashboard", superAdminDashboardRoutes);
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/webhooks/payment", paymentWebhookRoutes);
app.use("/api/help-centre", helpCentreRoutes);
app.use("/api/helpcentre", helpCentreRoutes);

// Protected business write routes (guarded by requireActiveSubscription when enabled)
app.use("/api/customers", requireActiveSubscription, customerRoutes);
app.use("/api/collections", requireActiveSubscription, collectionRoutes);
app.use("/api/payments", requireActiveSubscription, paymentRoutes);
app.use("/api/stock", requireActiveSubscription, stockRoutes);
app.use("/api/expenses", requireActiveSubscription, expenseRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/purchase-invoices", requireActiveSubscription, purchaseInvoiceRoutes);
app.use("/api/purchase-bills", requireActiveSubscription, purchaseBillRoutes);
app.use("/api/documents", requireActiveSubscription, documentRoutes);
app.use("/api/vehicles", requireActiveSubscription, vehicleRoutes);
app.use("/api/settings", requireActiveSubscription, settingsRoutes);
app.use("/api/khata", requireActiveSubscription, khataRoutes);
app.use("/api/banking", requireActiveSubscription, bankingRoutes);
app.use("/api/files", fileRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`🚀 FIRST TRACK KHATANEX API running on port ${PORT}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use.`);
  } else {
    console.error("❌ Server listen error:", err);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});
