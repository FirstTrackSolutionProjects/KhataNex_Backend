const { sendMail } = require("../../utils/mailer.js");

/**
 * Sends an email via Nodemailer.
 * @param {string} to - Recipient email address
 * @param {{ subject: string, html: string }} template - Email template
 * @param {import("nodemailer").Attachment[]} [attachments=[]] - Optional file attachments
 */
const sendEmail = async (to, template, attachments = []) => {
  return sendMail({
    to,
    subject: template?.subject || "Message from KhataNex",
    html: template?.html || "",
    attachments,
  });
};

module.exports = sendEmail;