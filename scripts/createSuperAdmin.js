// Creates (or re-confirms) the ONE super admin account, using credentials
// from .env. This is the "set through backend" requirement — there is
// deliberately no public API route that can create a super admin.
//
// Usage:  npm run seed:superadmin

require("dotenv").config();
const bcrypt = require("bcrypt");
const pool = require("../config/db");

(async () => {
  const name = process.env.SUPERADMIN_NAME || "Super Admin";
  const email = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;

  if (!email || !password) {
    console.error("❌ Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in .env first.");
    process.exit(1);
  }

  try {
    const [existing] = await pool.query("SELECT id, role FROM users WHERE email = ?", [email]);

    if (existing.length) {
      if (existing[0].role !== "superadmin") {
        await pool.query("UPDATE users SET role = 'superadmin', status = 'active' WHERE id = ?", [
          existing[0].id,
        ]);
        console.log(`✅ Existing user promoted to super admin: ${email}`);
      } else {
        console.log(`ℹ️  Super admin already exists: ${email}`);
      }
    } else {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'superadmin', 'active')",
        [name, email, hashed]
      );
      console.log(`✅ Super admin created: ${email}`);
    }
  } catch (err) {
    console.error("❌ Failed to seed super admin:", err.message);
  } finally {
    process.exit(0);
  }
})();
