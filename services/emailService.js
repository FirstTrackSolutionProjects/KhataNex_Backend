const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../config/db");
const { sendMail } = require("../utils/mailer");

/**
 * KhataNex Durable Email Service
 * Backed by MySQL `email_outbox` queue with exponential backoff and retry handling.
 * Guarantees document creation and payment fulfillment are never rolled back on email failure.
 */
class EmailService {
  constructor() {
    this.isProcessing = false;
    this.intervalId = null;
  }

  /**
   * Initializes background queue processing interval (runs every 60 seconds)
   */
  startQueueWorker(intervalMs = 60000) {
    if (this.intervalId) return;
    // Immediate startup sweep
    this.processQueue().catch((err) => console.error("[EmailQueue] Initial sweep error:", err.message));
    this.intervalId = setInterval(() => {
      this.processQueue().catch((err) => console.error("[EmailQueue] Interval sweep error:", err.message));
    }, intervalMs);
    // Allow process to exit cleanly if worker is running
    if (this.intervalId.unref) this.intervalId.unref();
  }

  stopQueueWorker() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Enqueues an email into the durable database outbox and triggers an asynchronous dispatch.
   */
  async enqueue({
    to,
    subject,
    text = "",
    html = "",
    attachmentPath = null,
    attachmentName = null,
    category = "other",
    referenceType = null,
    referenceId = null,
    maxAttempts = 5,
  }) {
    if (!to || !String(to).trim()) {
      return { success: false, error: "Recipient email address is missing." };
    }

    const cleanTo = String(to).trim();

    // Check for exact pending duplicate in outbox to enforce idempotency
    if (referenceType && referenceId) {
      const [existing] = await pool.query(
        `SELECT id, status FROM email_outbox 
         WHERE reference_type = ? AND reference_id = ? AND recipient_email = ? 
           AND status IN ('pending', 'sending', 'sent')
         ORDER BY id DESC LIMIT 1`,
        [referenceType, String(referenceId), cleanTo]
      );
      if (existing.length > 0) {
        return {
          success: true,
          outboxId: existing[0].id,
          status: existing[0].status,
          duplicateIgnored: true,
        };
      }
    }

    const [res] = await pool.query(
      `INSERT INTO email_outbox 
         (recipient_email, subject, body_text, body_html, attachment_path, attachment_name,
          category, reference_type, reference_id, status, attempts, max_attempts, next_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NOW())`,
      [
        cleanTo,
        subject,
        text,
        html,
        attachmentPath,
        attachmentName,
        category,
        referenceType,
        referenceId ? String(referenceId) : null,
        maxAttempts,
      ]
    );

    const outboxId = res.insertId;

    // Trigger immediate async delivery (non-blocking)
    setImmediate(() => {
      this.deliverItem(outboxId).catch((err) =>
        console.warn(`[EmailQueue] Immediate delivery failed for outbox item ${outboxId}:`, err.message)
      );
    });

    return { success: true, outboxId, status: "pending" };
  }

  /**
   * Delivers a single outbox entry by ID
   */
  async deliverItem(outboxId) {
    const [rows] = await pool.query(
      "SELECT * FROM email_outbox WHERE id = ? AND status IN ('pending', 'failed')",
      [outboxId]
    );
    const item = rows[0];
    if (!item) return { delivered: false, reason: "Item not found or already sent/sending" };

    // Acquire lock
    const [lockRes] = await pool.query(
      "UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status IN ('pending', 'failed')",
      [outboxId]
    );
    if (lockRes.affectedRows === 0) return { delivered: false, reason: "Locked by another worker" };

    // Prepare attachments
    const attachments = [];
    if (item.attachment_path) {
      if (fs.existsSync(item.attachment_path)) {
        attachments.push({
          filename: item.attachment_name || path.basename(item.attachment_path),
          path: item.attachment_path,
        });
      } else {
        console.warn(`[EmailQueue] Attachment path does not exist for outbox item ${outboxId}: ${item.attachment_path}`);
      }
    }

    const maskedEmail = item.recipient_email ? item.recipient_email.replace(/(.{2})(.*)(?=@)/, (_, a, b) => a + "*".repeat(b.length)) : "unknown";
    const result = await sendMail({
      to: item.recipient_email,
      subject: item.subject,
      text: item.body_text,
      html: item.body_html,
      attachments,
    });

    if (result.sent) {
      await pool.query(
        "UPDATE email_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = ?",
        [outboxId]
      );
      await this.syncReferenceStatus(item, "sent");
      console.log(`[EmailQueue] Outbox item ${outboxId} (${item.category}/${item.reference_type}) delivered to ${maskedEmail} (Message-ID: ${result.messageId || 'ok'})`);
      return { delivered: true, messageId: result.messageId };
    } else {
      const nextAttempt = item.attempts + 1;
      const isPermanent = nextAttempt >= item.max_attempts;
      const delayMinutes = Math.min(60, Math.pow(2, nextAttempt) * 2); // 2m, 4m, 8m, 16m, 32m, max 60m

      await pool.query(
        `UPDATE email_outbox 
         SET status = 'failed', 
             attempts = ?, 
             last_error = ?, 
             next_retry_at = ${isPermanent ? "NULL" : "DATE_ADD(NOW(), INTERVAL ? MINUTE)"}
         WHERE id = ?`,
        isPermanent
          ? [nextAttempt, result.error || "Delivery failed", outboxId]
          : [nextAttempt, result.error || "Delivery failed", delayMinutes, outboxId]
      );

      await this.syncReferenceStatus(item, "failed", result.error);
      console.warn(`[EmailQueue] Outbox item ${outboxId} delivery failed for ${maskedEmail} (Attempt ${nextAttempt}/${item.max_attempts}): ${result.error}`);
      return { delivered: false, error: result.error };
    }
  }

  /**
   * Syncs delivery status back to the source entity (subscription invoice, customer invoice, etc.)
   */
  async syncReferenceStatus(item, status, errorMessage = null) {
    if (!item.reference_type || !item.reference_id) return;
    try {
      const isNumericId = /^\d+$/.test(String(item.reference_id).trim());
      if (item.reference_type === "subscription_invoice") {
        if (isNumericId) {
          await pool.query(
            `UPDATE subscription_invoices 
             SET email_status = ?, email_error = ?, emailed_at = ${status === "sent" ? "NOW()" : "emailed_at"}
             WHERE id = ? OR invoice_number = ?`,
            [status, errorMessage || null, Number(item.reference_id), String(item.reference_id)]
          );
        } else {
          await pool.query(
            `UPDATE subscription_invoices 
             SET email_status = ?, email_error = ?, emailed_at = ${status === "sent" ? "NOW()" : "emailed_at"}
             WHERE invoice_number = ?`,
            [status, errorMessage || null, String(item.reference_id)]
          );
        }
      } else if (item.reference_type === "invoice") {
        if (isNumericId) {
          await pool.query(
            "UPDATE invoices SET email_status = ? WHERE id = ? OR invoice_number = ?",
            [status, Number(item.reference_id), String(item.reference_id)]
          );
        } else {
          await pool.query(
            "UPDATE invoices SET email_status = ? WHERE invoice_number = ?",
            [status, String(item.reference_id)]
          );
        }
      }
    } catch (syncErr) {
      console.warn(`[EmailQueue] Failed to sync reference status for ${item.reference_type}:${item.reference_id}:`, syncErr.message);
    }
  }

  /**
   * Sweeps the outbox for pending or retryable items
   */
  async processQueue(batchSize = 10) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      const [items] = await pool.query(
        `SELECT id FROM email_outbox
         WHERE status IN ('pending', 'failed')
           AND attempts < max_attempts
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         ORDER BY id ASC
         LIMIT ?`,
        [batchSize]
      );

      for (const item of items) {
        await this.deliverItem(item.id);
      }
    } catch (err) {
      console.error("[EmailQueue] Queue processing cycle error:", err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Manual retry triggered by Superadmin
   */
  async retryItem(outboxId) {
    const [res] = await pool.query(
      "UPDATE email_outbox SET status = 'pending', next_retry_at = NOW() WHERE id = ?",
      [outboxId]
    );
    if (res.affectedRows === 0) {
      return { success: false, message: "Outbox item not found." };
    }
    return this.deliverItem(outboxId);
  }

  // ==========================================================================
  // Unsubscribe & Preferences Management (Promotional / Marketing Communications)
  // ==========================================================================

  /**
   * Checks whether an email address has unsubscribed from promotional communications
   */
  async isUnsubscribed(email) {
    if (!email) return false;
    const clean = String(email).trim().toLowerCase();
    try {
      const [rows] = await pool.query(
        "SELECT id FROM email_unsubscribes WHERE LOWER(email) = ? LIMIT 1",
        [clean]
      );
      return rows.length > 0;
    } catch (err) {
      console.warn("[EmailService] Error checking unsubscribe status:", err.message);
      return false;
    }
  }

  /**
   * Opts an email address out of promotional emails
   */
  async unsubscribeEmail(email, reason = "user_requested") {
    if (!email) return { success: false, error: "Email is required." };
    const clean = String(email).trim().toLowerCase();
    try {
      await pool.query(
        `INSERT INTO email_unsubscribes (email, reason, unsubscribed_at)
         VALUES (?, ?, NOW())
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), unsubscribed_at = NOW()`,
        [clean, reason || null]
      );
      return { success: true, email: clean };
    } catch (err) {
      console.error("[EmailService] Error recording unsubscribe:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Generates a tamper-proof HMAC unsubscribe token for 1-click email links
   */
  generateUnsubscribeToken(email) {
    const clean = String(email).trim().toLowerCase();
    const secret = process.env.JWT_SECRET || "khatanex_unsubscribe_secret";
    return crypto.createHmac("sha256", secret).update(`unsub:${clean}`).digest("hex");
  }

  /**
   * Verifies an HMAC unsubscribe token
   */
  verifyUnsubscribeToken(email, token) {
    if (!email || !token) return false;
    const clean = String(email).trim().toLowerCase();
    const expected = this.generateUnsubscribeToken(clean);
    try {
      return (
        token.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(expected, "utf8"))
      );
    } catch (_) {
      return false;
    }
  }

  // ==========================================================================
  // KhataNex Dedicated Workflow Sending Methods
  // ==========================================================================

  /**
   * 1. Welcome Email: sent immediately after user registration
   */
  async sendWelcomeEmail({ to, userName, userId }) {
    const frontendUrl = process.env.FRONTEND_URL || "https://khatanex.in";
    const name = userName || "Valued User";
    const subject = "Welcome to KhataNex — Your Smart Digital Khata & Invoicing Platform";

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">Welcome to KhataNex, ${name}!</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Thank you for choosing KhataNex. Your account is active and ready to streamline your business accounting, GST invoicing, and customer collections.
      </p>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #059669; font-weight: 700;">Explore KhataNex Capabilities:</h3>
        <ul style="margin: 0; padding-left: 20px; color: #475569; font-size: 14px; line-height: 1.8;">
          <li><strong>GST Invoices &amp; Quotations:</strong> Generate professional A4 PDF invoices and send them directly to customers.</li>
          <li><strong>Digital Khata:</strong> Manage customer debit/credit transactions with instant due tracking.</li>
          <li><strong>Stock &amp; Inventory:</strong> Monitor stock levels, track purchase bills, and manage product inventory.</li>
          <li><strong>Financial Reports:</strong> Access real-time insights, daily collection summaries, and sales analytics.</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="${frontendUrl}" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 4px rgba(5, 150, 105, 0.2);">
          Open KhataNex Dashboard
        </a>
      </div>

      <p style="margin: 20px 0 0 0; font-size: 13px; color: #64748b;">
        Need any assistance? Reply directly to this email or contact us at <a href="mailto:info@khatanex.in" style="color: #059669; text-decoration: none; font-weight: 500;">info@khatanex.in</a>.
      </p>
    `;

    const text = `Welcome to KhataNex, ${name}!\n\n` +
      `Thank you for joining KhataNex. Your account is active and ready.\n\n` +
      `Key Capabilities:\n` +
      `- Professional GST Invoicing & Quotations\n` +
      `- Digital Khata & Customer Dues Tracking\n` +
      `- Stock & Inventory Management\n` +
      `- Financial Reports & Analytics\n\n` +
      `Get started now: ${frontendUrl}\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Welcome", contentHtml }),
      category: "system",
      referenceType: "user_welcome",
      referenceId: userId,
    });
  }

  /**
   * 2. Subscription Confirmation Email with Tax Invoice PDF Attachment
   */
  async sendSubscriptionConfirmationEmail({
    to,
    userName,
    planName,
    invoiceNumber,
    durationMonths = 1,
    startsAt = null,
    endsAt = null,
    totalPaise = 0,
    pdfPath = null,
    invoiceId = null,
  }) {
    const frontendUrl = process.env.FRONTEND_URL || "https://khatanex.in";
    const name = userName || "Valued Customer";
    const subject = `KhataNex Subscription Confirmed — Invoice #${invoiceNumber}`;
    const formattedAmount = "₹ " + (Number(totalPaise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    const formattedStart = formatDate(startsAt || new Date());
    const formattedEnd = formatDate(endsAt);

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">Subscription Confirmed!</h2>
      <p style="margin: 0 0 20px 0; font-size: 15px; color: #334155;">
        Dear ${name}, thank you for your payment. Your KhataNex subscription has been successfully activated.
      </p>

      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin: 20px 0; font-size: 14px;">
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b; width: 40%;">Plan</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #0f172a;">${planName}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Duration</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${durationMonths} Month(s)</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Billing Period</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${formattedStart} &ndash; ${formattedEnd}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Amount Paid</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #059669;">${formattedAmount}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #64748b;">Invoice Reference</td>
          <td style="padding: 12px 16px; font-weight: 600; color: #0f172a;">#${invoiceNumber}</td>
        </tr>
      </table>

      <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 4px; margin: 20px 0;">
        <p style="margin: 0; font-size: 13px; color: #065f46;">
          <strong>Tax Invoice Attached:</strong> Your official tax invoice <strong>#${invoiceNumber}.pdf</strong> is attached to this email for your accounting and GST input tax credit records.
        </p>
      </div>

      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="${frontendUrl}/subscription" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
          View Subscription Details
        </a>
      </div>
    `;

    const text = `Subscription Confirmed — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `Your subscription payment has been confirmed!\n\n` +
      `Plan: ${planName}\n` +
      `Duration: ${durationMonths} Month(s)\n` +
      `Billing Period: ${formattedStart} to ${formattedEnd}\n` +
      `Amount Paid: ${formattedAmount}\n` +
      `Invoice Number: #${invoiceNumber}\n\n` +
      `Your official tax invoice PDF is attached to this email.\n\n` +
      `Manage subscription: ${frontendUrl}/subscription\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Payment Confirmed", contentHtml }),
      attachmentPath: pdfPath,
      attachmentName: `${invoiceNumber}.pdf`,
      category: "subscription_invoice",
      referenceType: "subscription_invoice",
      referenceId: invoiceId || invoiceNumber,
    });
  }

  /**
   * 3. Subscription Expiry Reminder Email with Deduplicated Cohort Keys
   */
  async sendExpiryReminderEmail({ to, userName, planName, daysLeft, endsAt, subId, userId }) {
    const frontendUrl = process.env.FRONTEND_URL || "https://khatanex.in";
    const name = userName || "Valued Customer";
    const daysText = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
    const subject = `Your KhataNex Subscription Expires ${daysLeft <= 1 ? "Tomorrow" : "in " + daysLeft + " Days"}`;
    const formattedEnd = formatDate(endsAt);
    const cohort = daysLeft <= 1 ? "1d" : (daysLeft <= 3 ? "3d" : "7d");
    const expiryDateStr = endsAt ? new Date(endsAt).toISOString().split("T")[0] : "exp";
    const referenceId = `remind_${subId || userId}_${cohort}_${expiryDateStr}`;

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">Subscription Expiring Soon</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name}, your KhataNex <strong>${planName}</strong> plan is scheduled to expire on <strong>${formattedEnd}</strong> (${daysText}).
      </p>

      <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 4px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #92400e;">
          To avoid any interruption to your daily invoicing, inventory management, and digital ledger records, please renew your subscription before ${formattedEnd}.
        </p>
      </div>

      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="${frontendUrl}/subscription" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
          Renew Subscription Now
        </a>
      </div>

      <p style="margin: 20px 0 0 0; font-size: 12px; color: #64748b; text-align: center;">
        If you have already renewed, please disregard this reminder.
      </p>
    `;

    const text = `Subscription Renewal Reminder — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `Your KhataNex ${planName} subscription will expire on ${formattedEnd} (${daysText}).\n` +
      `Renew early to ensure uninterrupted access to your digital ledger and invoices.\n\n` +
      `Renew now: ${frontendUrl}/subscription\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Renewal Reminder", contentHtml }),
      category: "subscription_reminder",
      referenceType: "subscription_reminder",
      referenceId,
    });
  }

  /**
   * 4. Payment Failure Notification Email
   */
  async sendPaymentFailureEmail({
    to,
    userName,
    orderNumber,
    amountPaise = 0,
    reason = "Transaction declined by bank or payment gateway",
    retryUrl = null,
    orderId = null,
  }) {
    const frontendUrl = process.env.FRONTEND_URL || "https://khatanex.in";
    const name = userName || "Valued Customer";
    const subject = `Payment Unsuccessful for KhataNex Order #${orderNumber || orderId}`;
    const formattedAmount = "₹ " + (Number(amountPaise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    const targetUrl = retryUrl || `${frontendUrl}/subscription`;

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #dc2626;">Payment Unsuccessful</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Dear ${name}, we were unable to process your payment for KhataNex order <strong>#${orderNumber || orderId}</strong>.
      </p>

      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #fef2f2; border: 1px solid #fee2e2; border-radius: 8px; margin: 20px 0; font-size: 14px;">
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #fee2e2; color: #991b1b; width: 40%;">Order Number</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #fee2e2; font-weight: 600; color: #0f172a;">#${orderNumber || orderId}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #fee2e2; color: #991b1b;">Amount</td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #fee2e2; font-weight: 700; color: #0f172a;">${formattedAmount}</td>
        </tr>
        <tr>
          <td style="padding: 12px 16px; color: #991b1b;">Failure Details</td>
          <td style="padding: 12px 16px; color: #b91c1c;">${reason}</td>
        </tr>
      </table>

      <p style="margin: 0 0 20px 0; font-size: 14px; color: #475569;">
        <strong>Safety Note:</strong> If any amount was deducted from your account, it will be automatically refunded by your bank within 3 to 5 business days. Your business data remains completely safe.
      </p>

      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="${targetUrl}" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
          Retry Payment Securely
        </a>
      </div>

      <p style="margin: 20px 0 0 0; font-size: 13px; color: #64748b;">
        If you have questions or require help, please contact us at <a href="mailto:info@khatanex.in" style="color: #059669; text-decoration: none;">info@khatanex.in</a>.
      </p>
    `;

    const text = `Payment Unsuccessful — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `We were unable to process your payment for order #${orderNumber || orderId} (${formattedAmount}).\n` +
      `Reason: ${reason}\n\n` +
      `Retry payment securely: ${targetUrl}\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Payment Failed", contentHtml }),
      category: "system",
      referenceType: "payment_failure",
      referenceId: orderId ? String(orderId) : null,
    });
  }

  /**
   * 5. Promotional & Coupon Email with Unsubscribe Compliance
   */
  async sendPromotionalEmail({
    to,
    userName,
    subject = "Special Offer on KhataNex",
    title = "Exclusive Offer for You",
    message = "Upgrade your business operations with KhataNex subscription savings.",
    couponCode = null,
    discountText = null,
    validUntil = null,
    ctaLink = null,
    userId = null,
    referenceId = null,
  }) {
    if (!to) return { success: false, error: "Recipient email is required." };

    const unsubscribed = await this.isUnsubscribed(to);
    if (unsubscribed) {
      return { success: true, skipped: true, reason: "Recipient has unsubscribed from promotional emails." };
    }

    const frontendUrl = process.env.FRONTEND_URL || "https://khatanex.in";
    const backendUrl = process.env.BASE_URL || "http://localhost:5000";
    const token = this.generateUnsubscribeToken(to);
    const unsubscribeUrl = `${backendUrl}/api/subscriptions/unsubscribe?email=${encodeURIComponent(to)}&token=${token}`;
    const name = userName || "Valued User";
    const targetLink = ctaLink || `${frontendUrl}/subscription`;

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">${title}</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name},<br/><br/>
        ${message}
      </p>

      ${couponCode ? `
        <div style="background-color: #f0fdf4; border: 2px dashed #10b981; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <p style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #065f46; font-weight: 600;">Use Coupon Code</p>
          <div style="display: inline-block; background-color: #ffffff; border: 1px solid #86efac; padding: 8px 24px; border-radius: 6px; font-size: 22px; font-weight: 800; color: #047857; letter-spacing: 2px;">
            ${couponCode}
          </div>
          ${discountText ? `<p style="margin: 10px 0 0 0; font-size: 15px; font-weight: 700; color: #065f46;">${discountText}</p>` : ''}
          ${validUntil ? `<p style="margin: 6px 0 0 0; font-size: 12px; color: #64748b;">Valid until: ${formatDate(validUntil)}</p>` : ''}
        </div>
      ` : ''}

      <div style="text-align: center; margin: 28px 0 16px 0;">
        <a href="${targetLink}" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
          Claim Your Offer
        </a>
      </div>
    `;

    const text = `${title}\n\n` +
      `Hello ${name},\n\n` +
      `${message}\n\n` +
      (couponCode ? `Coupon Code: ${couponCode}\n${discountText ? `Benefit: ${discountText}\n` : ''}${validUntil ? `Valid until: ${formatDate(validUntil)}\n` : ''}\n` : '') +
      `Claim your offer: ${targetLink}\n\n` +
      `To unsubscribe from promotional emails: ${unsubscribeUrl}\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Special Offer", contentHtml, unsubscribeUrl }),
      category: "other",
      referenceType: "promotion",
      referenceId: referenceId ? String(referenceId) : (couponCode || null),
    });
  }

  /**
   * 6. Password Reset Email: contains secure, single-use, expiring reset link
   */
  async sendPasswordResetEmail({
    to,
    userName,
    resetUrl,
    expiresInMinutes = 20,
    resetId = null,
  }) {
    if (!to || !resetUrl) {
      return { success: false, error: "Recipient email and reset URL are required." };
    }

    const name = userName || "Valued User";
    const subject = "Reset Your KhataNex Password";

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">Password Reset Request</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name},
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        We received a request to reset the password for your KhataNex account. Click the button below to set a new password:
      </p>

      <div style="text-align: center; margin: 28px 0 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 13px 32px; border-radius: 8px; box-shadow: 0 2px 4px rgba(5, 150, 105, 0.25);">
          Reset Password
        </a>
      </div>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 24px 0; font-size: 13px; color: #475569; line-height: 1.6;">
        <p style="margin: 0 0 8px 0;"><strong>Security Notice:</strong></p>
        <ul style="margin: 0; padding-left: 20px;">
          <li>This link is single-use and will expire in <strong>${expiresInMinutes} minutes</strong>.</li>
          <li>If you did not request a password reset, you can safely ignore this email. Your current password remains completely secure.</li>
          <li>Never share this reset link with anyone. KhataNex staff will never ask for your password or reset link.</li>
        </ul>
      </div>

      <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b; word-break: break-all;">
        If the button above does not work, copy and paste this link into your browser:<br/>
        <a href="${resetUrl}" style="color: #059669; text-decoration: underline;">${resetUrl}</a>
      </p>
    `;

    const text = `Reset Your KhataNex Password\n\n` +
      `Hello ${name},\n\n` +
      `We received a request to reset your KhataNex password.\n\n` +
      `Click the following link to choose a new password:\n` +
      `${resetUrl}\n\n` +
      `This link will expire in ${expiresInMinutes} minutes and can only be used once.\n\n` +
      `If you did not request this, you can safely ignore this email. Your account remains secure.\n\n` +
      `Dedicated Support: info@khatanex.in\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Security", contentHtml }),
      category: "system",
      referenceType: "password_reset",
      referenceId: resetId ? String(resetId) : null,
    });
  }

  /**
   * 7. Two-Step Verification Enabled Email
   */
  async send2FAEnabledEmail({ to, userName }) {
    if (!to) return { success: false, error: "Recipient email is required." };
    const name = userName || "Valued User";
    const subject = "Two-Step Verification Enabled — KhataNex";

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">Two-Step Verification Activated</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name},
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Two-Step Verification (2FA) has been successfully enabled on your KhataNex account.
      </p>
      <div style="background-color: #ecfdf5; border-left: 4px solid #10b981; padding: 14px 16px; border-radius: 4px; margin: 20px 0; font-size: 14px; color: #065f46;">
        <p style="margin: 0 0 6px 0; font-weight: 600;">Your account is now more secure.</p>
        <p style="margin: 0; font-size: 13px;">
          From now on, you will be prompted for a 6-digit code from your authenticator app whenever you sign in.
        </p>
      </div>
      <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b;">
        If you did NOT perform this action, please contact KhataNex Support immediately at info@khatanex.in to secure your account.
      </p>
    `;

    const text = `Two-Step Verification Enabled — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `Two-Step Verification (2FA) has been successfully activated on your KhataNex account.\n\n` +
      `Whenever you sign in, you will be required to provide a 6-digit code from your authenticator app.\n\n` +
      `If you did not perform this action, contact support immediately at info@khatanex.in.\n\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Security", contentHtml }),
      category: "system",
      referenceType: "two_factor_enabled",
      referenceId: null,
    });
  }

  /**
   * 8. Two-Step Verification Disabled Email
   */
  async send2FADisabledEmail({ to, userName }) {
    if (!to) return { success: false, error: "Recipient email is required." };
    const name = userName || "Valued User";
    const subject = "Security Alert: Two-Step Verification Disabled — KhataNex";

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #dc2626;">Two-Step Verification Disabled</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name},
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Two-Step Verification (2FA) was recently disabled on your KhataNex account.
      </p>
      <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 14px 16px; border-radius: 4px; margin: 20px 0; font-size: 14px; color: #991b1b;">
        <p style="margin: 0 0 6px 0; font-weight: 600;">Warning: Reduced Account Security</p>
        <p style="margin: 0; font-size: 13px;">
          Your account is no longer protected by an authenticator app. Anyone with your password can now log in.
        </p>
      </div>
      <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b;">
        If you did not authorize this change, please sign in and change your password immediately, or contact us at info@khatanex.in.
      </p>
    `;

    const text = `Security Alert: Two-Step Verification Disabled — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `Two-Step Verification (2FA) was recently disabled on your KhataNex account.\n\n` +
      `If you did not authorize this change, please change your password immediately or contact info@khatanex.in.\n\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Security Alert", contentHtml }),
      category: "system",
      referenceType: "two_factor_disabled",
      referenceId: null,
    });
  }

  /**
   * 9. Two-Step Verification Recovery Codes Regenerated Email
   */
  async send2FARecoveryCodesRegeneratedEmail({ to, userName }) {
    if (!to) return { success: false, error: "Recipient email is required." };
    const name = userName || "Valued User";
    const subject = "Two-Step Verification Recovery Codes Regenerated — KhataNex";

    const contentHtml = `
      <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0f172a;">New Backup Recovery Codes Generated</h2>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        Hello ${name},
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">
        A new set of single-use backup recovery codes has been generated for your KhataNex account. All previously issued recovery codes are now invalid.
      </p>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; margin: 20px 0; font-size: 13px; color: #475569;">
        Make sure you have saved your new recovery codes in a secure location. Each code can be used only once to sign in if you lose access to your authenticator app.
      </div>
      <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b;">
        If you did not request new recovery codes, please contact info@khatanex.in immediately.
      </p>
    `;

    const text = `Two-Step Verification Recovery Codes Regenerated — KhataNex\n\n` +
      `Hello ${name},\n\n` +
      `A new set of backup recovery codes has been generated for your KhataNex account. All previous recovery codes are now invalid.\n\n` +
      `If you did not perform this action, contact support immediately at info@khatanex.in.\n\n` +
      `Team KhataNex`;

    return this.enqueue({
      to,
      subject,
      text,
      html: wrapBrandTemplate({ title: subject, badge: "Security", contentHtml }),
      category: "system",
      referenceType: "two_factor_codes_reset",
      referenceId: null,
    });
  }
}

// Helper formatting functions
function formatDate(date) {
  if (!date) return "N/A";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return String(date);
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch (_) {
    return String(date);
  }
}

function wrapBrandTemplate({ title, badge, contentHtml, unsubscribeUrl = null }) {
  const currentYear = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || "KhataNex"}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <!-- Header -->
          <tr>
            <td style="background-color: #0f172a; padding: 24px 32px; border-bottom: 3px solid #10b981;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">Khata<span style="color: #10b981;">Nex</span></span>
                    <span style="display: block; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-top: 2px;">Smart Digital Khata &amp; Invoicing</span>
                  </td>
                  ${badge ? `<td align="right"><span style="display: inline-block; background-color: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #10b981; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600;">${badge}</span></td>` : ''}
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              ${contentHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 24px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center;">
              <p style="margin: 0 0 6px 0; font-weight: 600; color: #475569;">KhataNex Technologies Private Limited</p>
              <p style="margin: 0 0 8px 0;">Official Communications: <a href="mailto:info@khatanex.in" style="color: #059669; text-decoration: none; font-weight: 500;">info@khatanex.in</a></p>
              ${unsubscribeUrl ? `
                <p style="margin: 12px 0 0 0; font-size: 11px; color: #94a3b8; border-top: 1px dashed #cbd5e1; padding-top: 12px;">
                  You received this email because you are a registered user of KhataNex.<br/>
                  If you prefer not to receive promotional updates,
                  <a href="${unsubscribeUrl}" style="color: #059669; text-decoration: underline;">unsubscribe here</a>.
                </p>
              ` : `
                <p style="margin: 6px 0 0 0; font-size: 11px; color: #94a3b8;">
                  This is an automated transactional message regarding your KhataNex account.
                </p>
              `}
              <p style="margin: 10px 0 0 0; font-size: 11px; color: #cbd5e1;">&copy; ${currentYear} KhataNex. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

module.exports = new EmailService();

