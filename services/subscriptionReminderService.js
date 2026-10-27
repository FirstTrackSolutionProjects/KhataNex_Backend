const pool = require("../config/db");
const emailService = require("./emailService");

/**
 * Subscription Expiry Reminder Service
 *
 * Scans for users whose subscriptions are scheduled to expire soon
 * (e.g. within 7 days, 3 days, and 1 day) and sends polite renewal reminder emails.
 *
 * Safe & Deduplicated:
 * Uses email_outbox cohort deduplication so users receive at most one reminder per window.
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
         s.id AS sub_id,
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

      try {
        const res = await emailService.sendExpiryReminderEmail({
          to: user.user_email,
          userName: user.user_name,
          planName: user.plan_name,
          daysLeft: Math.max(1, user.days_left),
          endsAt: user.ends_at,
          subId: user.sub_id,
          userId: user.user_id,
        });

        if (res.success && !res.duplicateIgnored) {
          sentCount++;
        }
      } catch (mailErr) {
        console.warn(`[ReminderService] Could not queue reminder to ${user.user_email}:`, mailErr.message);
      }
    }

    console.log(`✅ [ReminderService] Processed ${expiringUsers.length} user(s), enqueued ${sentCount} new reminder(s).`);
    return { success: true, processed: expiringUsers.length, sent: sentCount };
  } catch (err) {
    console.error("❌ [ReminderService] Error during expiry check:", err.message || err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendExpiryReminders,
};
