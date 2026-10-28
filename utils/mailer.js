const nodemailer = require("nodemailer");

// Lazily build the transporter so a missing/incomplete SMTP config doesn't
// crash the whole server on boot — it just makes email sending fail
// gracefully at send time, with a clear error.
const getTransporter = () => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  const port = Number(process.env.SMTP_PORT) || 465;
  const isSecure = port === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: isSecure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    ...(port === 587 ? { requireTLS: true } : {}),
    connectionTimeout: 15000,
    socketTimeout: 15000,
  });
  return transporter;
};

/**
 * sendMail — sends an email, optionally with file attachments.
 * Returns { sent: true } on success, or { sent: false, error } on failure —
 * never throws, so callers (like invoice creation) can continue even if
 * the email leg fails, and just record that it failed.
 */
const sendMail = async ({ to, subject, text, html, attachments = [], headers = {} }) => {
  const t = getTransporter();
  if (!t) {
    return { sent: false, error: "SMTP is not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS in .env." };
  }
  if (!to) {
    return { sent: false, error: "Recipient email address is missing." };
  }

  try {
    const fromAddress =
      process.env.SMTP_FROM ||
      (process.env.SMTP_USER ? `"KhataNex" <${process.env.SMTP_USER}>` : '"KhataNex" <info@khatanex.in>');

    const info = await t.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html,
      attachments,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return {
      sent: true,
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
    };
  } catch (err) {
    return { sent: false, error: err.message };
  }
};

/**
 * Verifies SMTP connectivity and credentials
 */
const verifyConnection = async () => {
  const t = getTransporter();
  if (!t) return { ok: false, error: "SMTP is unconfigured." };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

module.exports = {
  sendMail,
  verifyConnection,
  getTransporter,
  get transporter() {
    return getTransporter();
  },
};
