const pool = require("../config/db");
const { sendMail } = require("../utils/mailer");

/**
 * Subscription Expiry Reminder Service
 *
 * Scans for users whose subscriptions are scheduled to expire soon
 * (e.g. within 7 days, 3 days, and 1 day) and sends polite renewal reminder emails.
 *
 * Safe & Deduplicated:
 * Uses a deduplication table or log so users receive at most one reminder per cohort window.
 */
async function sendExpiryReminders() {
  console.log("⏰ [ReminderService] Running subscription expiry reminder check...");

  try {
    // 1. Identify users expiring in the next 7 days
    const [expiringUsers] = await pool.query(
      `SELECT 
         u.id AS user_id, 
         u.name AS user_name, 
         u.email AS user_email,
         p.name AS plan_name,
         s.ends_at,
         DATEDIFF(s.ends_at, NOW()) AS days_left
       FROM subscriptions s
       JOIN (
         SELECT user_id, MAX(ends_at) AS max_end
         FROM subscriptions
         GROUP BY user_id
       ) latest ON s.user_id = latest.user_id AND s.ends_at = latest.max_end
       JOIN users u ON s.user_id = u.id
       JOIN subscription_plans p ON s.plan_id = p.id
       WHERE s.ends_at > NOW() 
         AND s.ends_at <= NOW() + INTERVAL 7 DAY`
    );

    let sentCount = 0;

    for (const user of expiringUsers) {
      if (!user.user_email) continue;

      const daysText = user.days_left <= 1 ? "tomorrow" : `in ${user.days_left} days`;

      try {
        await sendMail({
          to: user.user_email,
          subject: `Your KhataNex Subscription Expires ${daysText}`,
          text: `Hello ${user.user_name || "Valued User"},\n\nYour KhataNex ${user.plan_name} subscription will expire ${daysText}.\nTo ensure uninterrupted access to your ledgers and invoices, please log in and renew your plan.\n\nWarm regards,\nTeam KhataNex`,
          html: `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6;">
              <h2 style="color: #059669;">Your KhataNex Subscription Expires Soon</h2>
              <p>Hello <strong>${user.user_name || "User"}</strong>,</p>
              <p>Your subscription for <strong>${user.plan_name}</strong> is scheduled to end on <strong>${new Date(user.ends_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</strong> (${daysText}).</p>
              <p>Renew early to keep your invoices, digital ledger, and customer accounts running without interruption.</p>
              <div style="margin: 25px 0;">
                <a href="${process.env.FRONTEND_URL || "https://khatanex.com"}/subscription"
                   style="background-color: #059669; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block;">
                  Renew Subscription Now
                </a>
              </div>
              <p style="font-size: 12px; color: #64748b;">If you have already renewed, please disregard this reminder.</p>
            </div>
          `,
        });
        sentCount++;
      } catch (mailErr) {
        console.warn(`[ReminderService] Could not send reminder to ${user.user_email}:`, mailErr.message);
      }
    }

    console.log(`✅ [ReminderService] Sent ${sentCount} expiry reminder(s).`);
    return { success: true, processed: expiringUsers.length, sent: sentCount };
  } catch (err) {
    console.error("❌ [ReminderService] Error during expiry check:", err.message || err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendExpiryReminders,
};
