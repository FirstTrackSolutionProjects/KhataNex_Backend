const fs = require("fs");
const path = require("path");
const pool = require("../config/db");
const ApiError = require("./ApiError");
const { sendMail } = require("./mailer");
const { PRIVATE_INVOICE_DIR, generateSubscriptionInvoicePdf } = require("./generateSubscriptionInvoicePdf");

/**
 * Resolves full path to an invoice PDF inside the private invoices directory.
 */
const invoiceFilePath = (filename) => path.join(PRIVATE_INVOICE_DIR, filename);

/**
 * Issues an invoice for a completed subscription order.
 * Safe and idempotent: returns existing invoice if already issued.
 */
async function issueInvoice(orderId) {
  const [existing] = await pool.query(
    "SELECT * FROM subscription_invoices WHERE order_id = ?",
    [orderId]
  );
  if (existing.length > 0) {
    const inv = existing[0];
    const fullPath = invoiceFilePath(inv.pdf_filename);
    if (!fs.existsSync(fullPath)) {
      // Re-generate PDF if missing from disk
      await renderAndSavePdf(inv.id);
    }
    return inv;
  }

  // Fetch order details with user, plan, and active subscription period
  const [orders] = await pool.query(
    `SELECT 
       o.*, 
       p.name AS plan_name, 
       p.duration_months,
       u.name AS user_name, 
       u.email AS user_email, 
       u.phone AS user_phone, 
       u.business_name, 
       u.address AS user_address, 
       u.gstin AS user_gstin,
       s.starts_at, 
       s.ends_at
     FROM subscription_orders o
     JOIN subscription_plans p ON o.plan_id = p.id
     JOIN users u ON o.user_id = u.id
     LEFT JOIN subscriptions s ON s.order_id = o.id
     WHERE o.id = ?`,
    [orderId]
  );

  const order = orders[0];
  if (!order) throw new ApiError(404, "Order not found for invoice issuance.");

  const year = new Date().getFullYear();
  const invoiceNumber = `SUB-${year}-${String(order.id).padStart(5, "0")}`;
  const pdfFilename = `${invoiceNumber}.pdf`;

  const [res] = await pool.query(
    `INSERT INTO subscription_invoices (invoice_number, order_id, user_id, pdf_filename, issued_at)
     VALUES (?, ?, ?, ?, NOW())`,
    [invoiceNumber, order.id, order.user_id, pdfFilename]
  );

  const invoiceId = res.insertId;

  // Render PDF
  await renderAndSavePdf(invoiceId, order);

  // Email invoice if user has an email via durable outbox
  if (order.user_email) {
    try {
      const filePath = invoiceFilePath(pdfFilename);
      await sendInvoiceEmail(order.user_email, invoiceNumber, order.plan_name, filePath, invoiceId, order);
    } catch (mailErr) {
      console.warn(`[SubscriptionInvoice] Failed to enqueue invoice email ${invoiceNumber}:`, mailErr.message || mailErr);
    }
  } else {
    console.warn(`[SubscriptionInvoice] No recipient email found for order ${order.id} (user ID ${order.user_id}); invoice email skipped.`);
  }

  const [created] = await pool.query("SELECT * FROM subscription_invoices WHERE id = ?", [invoiceId]);
  return created[0];
}

/**
 * Internal helper to render the PDF for an existing invoice record
 */
async function renderAndSavePdf(invoiceId, cachedOrder = null) {
  const [invoices] = await pool.query("SELECT * FROM subscription_invoices WHERE id = ?", [invoiceId]);
  const invoice = invoices[0];
  if (!invoice) return null;

  let order = cachedOrder;
  if (!order) {
    const [orders] = await pool.query(
      `SELECT 
         o.*, 
         p.name AS plan_name, 
         p.duration_months,
         u.name AS user_name, 
         u.email AS user_email, 
         u.phone AS user_phone, 
         u.business_name, 
         u.address AS user_address, 
         u.gstin AS user_gstin,
         s.starts_at, 
         s.ends_at
       FROM subscription_orders o
       JOIN subscription_plans p ON o.plan_id = p.id
       JOIN users u ON o.user_id = u.id
       LEFT JOIN subscriptions s ON s.order_id = o.id
       WHERE o.id = ?`,
      [invoice.order_id]
    );
    order = orders[0];
  }

  // Get company settings
  const [companies] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  const company = companies[0] || {};

  return generateSubscriptionInvoicePdf({ invoice, order, company });
}

/**
 * Sends invoice email via durable outbox email service
 */
async function sendInvoiceEmail(toEmail, invoiceNumber, planName, attachmentPath, invoiceId = null, order = {}) {
  const emailService = require("../services/emailService");
  const masked = String(toEmail || "").replace(/(.{2})(.*)(?=@)/, (_, a, b) => a + "*".repeat(b.length));
  console.log(`[SubscriptionInvoice] Triggering subscription invoice email for #${invoiceNumber} to: ${masked}`);

  return emailService.sendSubscriptionConfirmationEmail({
    to: toEmail,
    userName: order.user_name || order.business_name || "Valued Customer",
    planName: planName || order.plan_name || "KhataNex Subscription Plan",
    invoiceNumber,
    durationMonths: order.duration_months || 1,
    startsAt: order.starts_at || null,
    endsAt: order.ends_at || null,
    totalPaise: order.total_paise || 0,
    pdfPath: attachmentPath,
    invoiceId: invoiceId || invoiceNumber,
  });
}

module.exports = {
  invoiceFilePath,
  issueInvoice,
  renderAndSavePdf,
  sendInvoiceEmail,
};

