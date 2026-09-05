const { transporter } = require("../../utils/mailer.js")

/**
 * Sends an email via Nodemailer.
 * @param {string} to - Recipient email address
 * @param {{ subject: string, html: string }} template - Email template
 * @param {import("nodemailer").Attachment[]} [attachments=[]] - Optional file attachments
 */
const sendEmail = async (to, template, attachments = []) => {
    await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: to,
        subject: template.subject,
        html: template.html,
        attachments,
    });
}

module.exports = sendEmail;