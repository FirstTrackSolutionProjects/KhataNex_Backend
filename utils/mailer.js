const nodemailer = require("nodemailer");

let transporter = null;

// Lazily build the transporter so a missing/incomplete SMTP config doesn't
// crash the whole server on boot — it just makes email sending fail
// gracefully at send time, with a clear error.
const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
};

/**
 * sendMail — sends an email, optionally with file attachments.
 * Returns { sent: true } on success, or { sent: false, error } on failure —
 * never throws, so callers (like invoice creation) can continue even if
 * the email leg fails, and just record that it failed.
 */
const sendMail = async ({ to, subject, text, html, attachments = [] }) => {
  const t = getTransporter();
  if (!t) {
    return { sent: false, error: "SMTP is not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS in .env." };
  }
  if (!to) {
    return { sent: false, error: "Recipient email address is missing." };
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
      attachments,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
};

module.exports = { sendMail };
