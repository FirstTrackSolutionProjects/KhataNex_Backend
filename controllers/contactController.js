const sendEmail = require("../services/nodemailer/send_email.nodemailer.service");
const contactUsEmailTemplate = require("../templates/email/contact_us.email.template");
const sendContactUsMessageSchema = require("../schemas/contact/send_contact_us_message.contact.schema");

const sendContactUsMessage = async (req, res, next) => {
    try {
        const data = sendContactUsMessageSchema.parse(req.body);
        const template = contactUsEmailTemplate(data);
        await sendEmail(process.env.SMTP_USER, template);
        res.status(200).json({ success: true, message: "Message sent successfully" });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    sendContactUsMessage
};