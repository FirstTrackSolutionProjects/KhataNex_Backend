const path = require("path");
const fs = require("fs");
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
      return { delivered: true };
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
}

module.exports = new EmailService();

