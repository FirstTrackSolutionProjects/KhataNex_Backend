const pool = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

(async () => {
  try {
    console.log("=== RUNNING AUTOMATED VERIFICATION OF NEW BACKEND CAPABILITIES ===");

    // 1. Check Migration 023 table structure
    const [cols] = await pool.query("SHOW COLUMNS FROM support_ticket_feedback");
    console.log("✅ support_ticket_feedback columns:", cols.map(c => c.Field));
    if (!cols.some(c => c.Field === "rating")) {
      throw new Error("Missing rating column in support_ticket_feedback");
    }

    // 2. Fetch superadmin user
    const [superAdmins] = await pool.query("SELECT id, name, email, role FROM users WHERE role = 'superadmin' LIMIT 1");
    if (!superAdmins.length) throw new Error("No superadmin found");
    const superAdmin = superAdmins[0];
    console.log(`✅ Using Superadmin: ${superAdmin.email} (ID ${superAdmin.id})`);

    // 3. Create a test employee with no employee_title and assigned_modules = ['invoices', 'users', 'billing']
    const testEmpEmail = `test_emp_${Date.now()}@example.com`;
    const hashed = await bcrypt.hash("password123", 10);
    const [empRes] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, assigned_modules, created_by_admin)
       VALUES (?, ?, ?, 'employee', 'staff', ?, ?)`,
      ["Test Staff", testEmpEmail, hashed, JSON.stringify(["invoices", "users", "billing"]), superAdmin.id]
    );
    const empId = empRes.insertId;
    console.log(`✅ Created test employee ID ${empId} without employee_title`);

    // 4. Fetch regular user (customer)
    const [users] = await pool.query("SELECT id, name, email FROM users WHERE role = 'user' LIMIT 1");
    if (!users.length) throw new Error("No regular customer user found");
    const testUser = users[0];

    // 5. Create a test ticket and assign to employee
    const [ticketRes] = await pool.query(
      `INSERT INTO support_tickets (ticket_number, user_id, department, category, subject, description, status, assigned_employee_id)
       VALUES (?, ?, 'general', 'Invoicing Inquiry', 'Need assistance with invoice format', 'Please help format our GST details', 'resolved', ?)`,
      [`TKT-${Date.now()}`, testUser.id, empId]
    );
    const ticketId = ticketRes.insertId;
    console.log(`✅ Created resolved support ticket ID ${ticketId} assigned to employee ${empId}`);

    // 6. Test feedback submission
    const [fbRes] = await pool.query(
      `INSERT INTO support_ticket_feedback (ticket_id, user_id, employee_id, rating, comment)
       VALUES (?, ?, ?, 5, 'Outstanding support! Very fast and helpful.')`,
      [ticketId, testUser.id, empId]
    );
    console.log(`✅ Inserted 5-star customer feedback for ticket ${ticketId}`);

    // 7. Verify Employee rating calculation in employee query
    const [empDetails] = await pool.query(
      `SELECT u.id, u.name,
              COALESCE(fb.rating_avg, 0) AS rating_avg,
              COALESCE(fb.rating_count, 0) AS rating_count,
              COALESCE(tc.tickets_handled, 0) AS tickets_handled
       FROM users u
       LEFT JOIN (
         SELECT employee_id, ROUND(AVG(rating), 1) AS rating_avg, COUNT(*) AS rating_count
         FROM support_ticket_feedback
         GROUP BY employee_id
       ) fb ON fb.employee_id = u.id
       LEFT JOIN (
         SELECT assigned_employee_id, COUNT(*) AS tickets_handled
         FROM support_tickets
         GROUP BY assigned_employee_id
       ) tc ON tc.assigned_employee_id = u.id
       WHERE u.id = ?`,
      [empId]
    );
    console.log("✅ Verified employee stats query:", empDetails[0]);
    if (Number(empDetails[0].rating_avg) !== 5 || Number(empDetails[0].rating_count) !== 1) {
      throw new Error("Rating calculation did not match expected 5.0 avg and 1 count");
    }

    // 8. Clean up test data
    await pool.query("DELETE FROM support_ticket_feedback WHERE ticket_id = ?", [ticketId]);
    await pool.query("DELETE FROM support_tickets WHERE id = ?", [ticketId]);
    await pool.query("DELETE FROM users WHERE id = ?", [empId]);
    console.log("✅ Test records cleanly removed.");

    console.log("\n🎉 ALL BACKEND VERIFICATIONS COMPLETED SUCCESSFULLY!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Verification failed:", err);
    process.exit(1);
  }
})();
