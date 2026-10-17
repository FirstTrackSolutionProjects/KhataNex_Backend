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

  // Email invoice if user has an email
  if (order.user_email) {
    try {
      const filePath = invoiceFilePath(pdfFilename);
      await sendInvoiceEmail(order.user_email, invoiceNumber, order.plan_name, filePath);
      await pool.query("UPDATE subscription_invoices SET emailed_at = NOW() WHERE id = ?", [invoiceId]);
    } catch (mailErr) {
      console.warn(`[SubscriptionInvoice] Failed to email invoice ${invoiceNumber}:`, mailErr.message || mailErr);
    }
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
 * Sends invoice email via nodemailer service
 */
async function sendInvoiceEmail(toEmail, invoiceNumber, planName, attachmentPath) {
  const attachments = fs.existsSync(attachmentPath)
    ? [{ filename: `${invoiceNumber}.pdf`, path: attachmentPath }]
    : [];

  return sendMail({
    to: toEmail,
    subject: `Your KhataNex Subscription Invoice (${invoiceNumber})`,
    text: `Hello,\n\nThank you for choosing KhataNex. Your subscription for ${planName} is now active.\nPlease find your tax invoice ${invoiceNumber} attached.\n\nWarm regards,\nTeam KhataNex`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6;">
        <h2 style="color: #059669;">KhataNex Subscription Invoice</h2>
        <p>Hello,</p>
        <p>Thank you for subscribing to <strong>KhataNex</strong>! Your payment was successful and your subscription plan (<strong>${planName}</strong>) is active.</p>
        <p>Your official tax invoice <strong>#${invoiceNumber}</strong> is attached to this email.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #64748b;">If you have any questions or require assistance, please reply to this email or contact support.</p>
      </div>
    `,
    attachments,
  });
}

module.exports = {
  invoiceFilePath,
  issueInvoice,
  renderAndSavePdf,
  sendInvoiceEmail,
};

