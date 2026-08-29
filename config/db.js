const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "first_track_khatanex",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
});

// Quick sanity check on boot
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log("✅ MySQL connected:", process.env.DB_NAME);
    conn.release();
  } catch (err) {
    console.error("❌ MySQL connection failed:", err.message);
  }
})();

module.exports = pool;
