const generateHtmlBody = (data) => {
    const { name, email, phone, subject, message } = data;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Notification - New Contact Form Submission</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f0fdf4; color: #000000;">

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f0fdf4; padding: 20px 0;">
        <tr>
            <td align="center">
                
                <!-- Main Container -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 600px; width: 100%;">
                    
                    <!-- Header -->
                    <tr>
                        <td align="center" style="background-color: #000000; padding: 25px 20px; border-bottom: 5px solid #22c55e;">
                            <h1 style="color: #ffffff; margin: 0 0 0 0; font-size: 24px; letter-spacing: 1px;">
                                Khata<span style="color: #22c55e;">Nex</span>
                            </h1>
                            <p style="color: #bbf7d0; margin: 6px 0 0 0; font-size: 13px; letter-spacing: 0.5px;">Smart Business Management</p>
                        </td>
                    </tr>

                    <!-- Body Content -->
                    <tr>
                        <td style="padding: 40px 30px; background-color: #ffffff;">
                            <h2 style="margin-top: 0; color: #000000; font-size: 22px; border-bottom: 2px solid #dcfce7; padding-bottom: 10px;">New Inquiry Received</h2>
                            
                            <p style="font-size: 16px; line-height: 1.6; color: #333333; margin-bottom: 25px;">
                                Hello Team,<br><br>
                                A new user has submitted the <strong>Contact Us</strong> form on the KhataNex website. Please review their details below and follow up accordingly.
                            </p>

                            <!-- Submission Details Box -->
                            <table width="100%" cellpadding="12" cellspacing="0" border="0" style="background-color: #ffffff; border: 2px solid #16a34a; border-radius: 6px; margin-bottom: 25px;">
                                <tr>
                                    <td width="30%" style="font-size: 15px; font-weight: bold; color: #ffffff; background-color: #000000; border-bottom: 1px solid #166534;">Full Name:</td>
                                    <td width="70%" style="font-size: 15px; color: #000000; border-bottom: 1px solid #dcfce7;"><strong>${name}</strong></td>
                                </tr>
                                <tr>
                                    <td style="font-size: 15px; font-weight: bold; color: #ffffff; background-color: #000000; border-bottom: 1px solid #166534;">Email:</td>
                                    <td style="font-size: 15px; color: #555555; border-bottom: 1px solid #dcfce7;">
                                        <a href="mailto:${email}" style="color: #16a34a; text-decoration: underline; font-weight: bold;">${email}</a>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="font-size: 15px; font-weight: bold; color: #ffffff; background-color: #000000; border-bottom: 1px solid #166534;">Phone:</td>
                                    <td style="font-size: 15px; color: #555555; border-bottom: 1px solid #dcfce7;">
                                        <a href="tel:${phone}" style="color: #16a34a; text-decoration: none; font-weight: bold;">${phone}</a>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="font-size: 15px; font-weight: bold; color: #ffffff; background-color: #000000; border-bottom: 1px solid #166534;">Subject:</td>
                                    <td style="font-size: 15px; color: #000000; border-bottom: 1px solid #dcfce7; font-weight: bold;">${subject}</td>
                                </tr>
                                <tr>
                                    <td style="font-size: 15px; font-weight: bold; color: #ffffff; background-color: #000000; padding-top: 15px;" valign="top">Message:</td>
                                    <td style="font-size: 15px; color: #333333; line-height: 1.5; padding-top: 15px; background-color: #f0fdf4;">
                                        <em>"${message}"</em>
                                    </td>
                                </tr>
                            </table>

                            <!-- Action Button -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">

                            </table>

                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td align="center" style="background-color: #f0fdf4; padding: 20px; border-top: 2px solid #bbf7d0;">
                            <p style="color: #16a34a; font-size: 13px; margin: 0 0 4px 0; font-weight: bold;">KhataNex</p>
                            <p style="color: #6b7280; font-size: 12px; margin: 0;">
                                This is an automated notification from the KhataNex website.<br>
                                Please do not reply directly to this system email.
                            </p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`
}


const contactUsEmailTemplate = (data) => {
    const htmlBody = generateHtmlBody(data);
    const subject = `KhataNex - New Contact Form Submission`;
    return {
        html: htmlBody,
        subject
    }
}

module.exports = contactUsEmailTemplate;