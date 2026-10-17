require("dotenv").config();
const pool = require("../config/db");
const jwt = require("jsonwebtoken");

const BASE_URL = "http://localhost:5001";
const JWT_SECRET = process.env.JWT_SECRET || "khatanex_super_secret_jwt_key_2026";

async function runTests() {
  console.log("========================================================================");
  console.log("KHATANEX E2E VERIFICATION: EMPLOYEE PERMISSIONS, REFRESH & TENANT BOUNDARY");
  console.log("========================================================================\n");

  const results = [];
  const report = (name, passed, details = "") => {
    results.push({ name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: ${name}`);
    if (details) console.log(`   └─ ${details}`);
  };

  try {
    // 1. Find or verify Superadmin
    const [superAdmins] = await pool.query("SELECT id, email FROM users WHERE role = 'superadmin' LIMIT 1");
    if (!superAdmins.length) throw new Error("No superadmin found in DB");
    const saId = superAdmins[0].id;
    const saToken = jwt.sign({ id: saId, role: "superadmin" }, JWT_SECRET);

    report("Superadmin exists and JWT generated", true, `SA ID: ${saId}, Email: ${superAdmins[0].email}`);

    // Test Superadmin access to /api/superadmin/users
    const saUsersRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${saToken}` }
    });
    const saUsersData = await saUsersRes.json();
    report(
      "Superadmin GET /api/superadmin/users succeeds",
      saUsersRes.status === 200 && Array.isArray(saUsersData.users),
      `Status: ${saUsersRes.status}, Returned ${saUsersData.users?.length} users`
    );

    // 2. Create a test employee with LIMITED modules (NO users module)
    const empEmail = `test_emp_${Date.now()}@test.com`;
    const empPassword = "Password@123";
    const createEmpRes = await fetch(`${BASE_URL}/api/superadmin/employees`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Staff Without Users Mod",
        email: empEmail,
        password: empPassword,
        employee_role_type: "staff",
        assigned_modules: ["invoices", "inventory", "khata"],
        permissions: ["invoices:view", "inventory:view", "khata:view"],
      }),
    });
    const createEmpData = await createEmpRes.json();
    const testEmpId = createEmpData.employee?.id;

    report(
      "Superadmin creates employee with limited modules (invoices, inventory, khata)",
      createEmpRes.status === 201 && testEmpId,
      `Employee ID: ${testEmpId}, Email: ${empEmail}`
    );

    // 3. Test Employee Login: Check if assigned_modules and permissions are returned
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: empEmail, password: empPassword }),
    });
    const loginData = await loginRes.json();
    const empToken = loginData.token;

    const hasModulesInLogin = Array.isArray(loginData.user?.assigned_modules) &&
      loginData.user.assigned_modules.includes("invoices") &&
      !loginData.user.assigned_modules.includes("users");
    const hasPermissionsInLogin = Array.isArray(loginData.user?.permissions) &&
      loginData.user.permissions.includes("invoices:view");

    report(
      "POST /api/auth/login returns assigned_modules and permissions in user object",
      loginRes.status === 200 && hasModulesInLogin && hasPermissionsInLogin,
      `assigned_modules: ${JSON.stringify(loginData.user?.assigned_modules)}, permissions: ${JSON.stringify(loginData.user?.permissions)}`
    );

    // 4. Test GET /api/auth/me for live profile hydration
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    const meData = await meRes.json();
    const hasModulesInMe = Array.isArray(meData.user?.assigned_modules) &&
      meData.user.assigned_modules.includes("invoices");

    report(
      "GET /api/auth/me returns updated assigned_modules and permissions",
      meRes.status === 200 && hasModulesInMe,
      `assigned_modules in /me: ${JSON.stringify(meData.user?.assigned_modules)}`
    );

    // 5. Test Unauthorized Direct API Access to 'users' module
    // Employee does NOT have 'users' module assigned:
    const unauthUsersRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    report(
      "GET /api/superadmin/users blocked with 403 for employee without 'users' module",
      unauthUsersRes.status === 403,
      `Status: ${unauthUsersRes.status} (Expected 403)`
    );

    const unauthSingleUserRes = await fetch(`${BASE_URL}/api/superadmin/users/11`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    report(
      "GET /api/superadmin/users/11 blocked with 403 for employee without 'users' module",
      unauthSingleUserRes.status === 403,
      `Status: ${unauthSingleUserRes.status} (Expected 403)`
    );

    const unauthUserDataRes = await fetch(`${BASE_URL}/api/superadmin/users/11/data?type=customers`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    report(
      "GET /api/superadmin/users/11/data blocked with 403 for employee without 'users' module",
      unauthUserDataRes.status === 403,
      `Status: ${unauthUserDataRes.status} (Expected 403)`
    );

    // 6. Test Granting Permissions dynamically (Superadmin updates employee)
    const grantRes = await fetch(`${BASE_URL}/api/superadmin/employees/${testEmpId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${saToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assigned_modules: ["invoices", "inventory", "khata", "users"],
        permissions: ["invoices:view", "inventory:view", "khata:view", "users:view"],
      }),
    });
    const grantData = await grantRes.json();
    report(
      "Superadmin grants 'users' module to employee via PATCH /api/superadmin/employees/:id",
      grantRes.status === 200,
      `Assigned modules now: ${JSON.stringify(grantData.employee?.assigned_modules)}`
    );

    // 7. Verify Employee GET /api/auth/me immediately reflects newly granted permissions
    const refreshedMeRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    const refreshedMeData = await refreshedMeRes.json();
    const hasUsersNow = Array.isArray(refreshedMeData.user?.assigned_modules) &&
      refreshedMeData.user.assigned_modules.includes("users");
    report(
      "Employee /api/auth/me immediately reflects new 'users' module without re-authenticating",
      refreshedMeRes.status === 200 && hasUsersNow,
      `Live assigned_modules: ${JSON.stringify(refreshedMeData.user?.assigned_modules)}`
    );

    // 8. Now that employee has 'users' module, GET /api/superadmin/users succeeds
    const nowAuthUsersRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    report(
      "Employee can now access GET /api/superadmin/users after permissions granted",
      nowAuthUsersRes.status === 200,
      `Status: ${nowAuthUsersRes.status} (Expected 200)`
    );

    // 9. Test Revoking Permissions dynamically
    const revokeRes = await fetch(`${BASE_URL}/api/superadmin/employees/${testEmpId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${saToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assigned_modules: ["invoices"],
        permissions: ["invoices:view"],
      }),
    });
    report("Superadmin revokes 'users' module from employee", revokeRes.status === 200);

    // Verify revoked employee is immediately blocked from /api/superadmin/users
    const postRevokeUsersRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${empToken}` },
    });
    report(
      "Employee is immediately blocked with 403 from /api/superadmin/users after revoking",
      postRevokeUsersRes.status === 403,
      `Status: ${postRevokeUsersRes.status} (Expected 403)`
    );

    // 10. TENANT ISOLATION VERIFICATION
    // Create a Tenant Employee whose created_by_admin is a Business Owner (User #11)
    const tenantEmpEmail = `tenant_emp_${Date.now()}@test.com`;
    const hashedPass = "$2b$10$VO34fx8B37Ssgar22KbYp.DUmvyirKGWkNkHggz.Ob.A34PH9Chsq";
    const [tEmpResult] = await pool.query(
      `INSERT INTO users (name, email, password, role, employee_role_type, created_by_admin, assigned_modules, permissions, status)
       VALUES (?, ?, ?, 'employee', 'staff', 11, ?, ?, 'active')`,
      [
        "Tenant 11 Staff",
        tenantEmpEmail,
        hashedPass,
        JSON.stringify(["users", "customers", "invoices"]),
        JSON.stringify(["users:view", "customers:view", "invoices:view"]),
      ]
    );
    const tenantEmpId = tEmpResult.insertId;
    const tenantEmpToken = jwt.sign({ id: tenantEmpId, role: "employee" }, JWT_SECRET);

    report(
      "Created Tenant Employee linked to Business Owner #11 (created_by_admin = 11)",
      Boolean(tenantEmpId),
      `Tenant Employee ID: ${tenantEmpId}, Owner ID: 11`
    );

    // When Tenant Employee calls /api/superadmin/users, it MUST ONLY return Account #11, NEVER other tenants!
    const tenantListUsersRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${tenantEmpToken}` },
    });
    const tenantListUsersData = await tenantListUsersRes.json();
    const onlySeesOwnTenant = tenantListUsersData.users?.length === 1 && tenantListUsersData.users[0].id === 11;

    report(
      "Tenant employee calling GET /api/superadmin/users is strictly isolated to Account #11 (never leaks other tenants)",
      tenantListUsersRes.status === 200 && onlySeesOwnTenant,
      `Returned count: ${tenantListUsersData.users?.length}, Accounts visible: ${JSON.stringify(tenantListUsersData.users?.map(u => ({ id: u.id, name: u.name })))}`
    );

    // Tenant employee calling GET /api/superadmin/users/11 succeeds
    const tenantOwnUserRes = await fetch(`${BASE_URL}/api/superadmin/users/11`, {
      headers: { Authorization: `Bearer ${tenantEmpToken}` },
    });
    report(
      "Tenant employee can view their own business owner account #11",
      tenantOwnUserRes.status === 200,
      `Status: ${tenantOwnUserRes.status}`
    );

    // Tenant employee calling GET /api/superadmin/users/82 (Another Tenant) MUST BE BLOCKED WITH 403
    const crossTenantRes = await fetch(`${BASE_URL}/api/superadmin/users/82`, {
      headers: { Authorization: `Bearer ${tenantEmpToken}` },
    });
    report(
      "Tenant employee accessing another tenant (#82) is BLOCKED with 403 (Cross-tenant security enforced)",
      crossTenantRes.status === 403,
      `Status: ${crossTenantRes.status} (Expected 403)`
    );

    // Tenant employee calling /api/superadmin/users/82/customers MUST BE BLOCKED WITH 403
    const crossTenantCustRes = await fetch(`${BASE_URL}/api/superadmin/users/82/customers`, {
      headers: { Authorization: `Bearer ${tenantEmpToken}` },
    });
    report(
      "Tenant employee accessing another tenant's customers (#82/customers) is BLOCKED with 403",
      crossTenantCustRes.status === 403,
      `Status: ${crossTenantCustRes.status} (Expected 403)`
    );

    // 11. REGULAR USER VERIFICATION
    const user11Token = jwt.sign({ id: 11, role: "user" }, JWT_SECRET);
    const regUserSaRes = await fetch(`${BASE_URL}/api/superadmin/users`, {
      headers: { Authorization: `Bearer ${user11Token}` },
    });
    report(
      "Regular user (Business Owner) cannot access platform /api/superadmin/users (blocked with 403)",
      regUserSaRes.status === 403,
      `Status: ${regUserSaRes.status} (Expected 403)`
    );

    const regUserEmpRes = await fetch(`${BASE_URL}/api/superadmin/employees`, {
      headers: { Authorization: `Bearer ${user11Token}` },
    });
    report(
      "Regular user cannot access platform /api/superadmin/employees (blocked with 403)",
      regUserEmpRes.status === 403,
      `Status: ${regUserEmpRes.status} (Expected 403)`
    );

    // Clean up test records
    await pool.query("DELETE FROM users WHERE id IN (?, ?)", [testEmpId, tenantEmpId]);
    report("Test employee accounts cleaned up cleanly", true);

    console.log("\n========================================================================");
    const passedCount = results.filter((r) => r.passed).length;
    console.log(`SUMMARY: ${passedCount} / ${results.length} TESTS PASSED`);
    console.log("========================================================================");

    process.exit(passedCount === results.length ? 0 : 1);
  } catch (err) {
    console.error("Test execution failed:", err);
    process.exit(1);
  }
}

runTests();
