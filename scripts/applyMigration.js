const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Explicit list of all known canonical migrations covering 001 through 016
const MIGRATION_HISTORY = [
  "migration_001_schema.sql",
  "migration_002_new_features.sql",
  "migration_003_roles_and_optional_fields.sql",
  "migration_004_banking.sql",
  "migration_005_customer_details.sql",
  "migration_006_banking_extended.sql",
  "migration_006_user_profile_settings.sql",
  "migration_007_document_system.sql",
  "migration_008_separate_quotations.sql",
  "migration_009_expand_quotation_payment_terms.sql",
  "migration_010_owner_console.sql",
  "migration_011_inventory_products_purchase_bills.sql",
  "migration_012_inventory_products_purchase_bills_mysql_compat.sql",
  "migration_013_stock_purchase_bill_link.sql",
  "migration_014_customer_dues_and_payments.sql",
  "migration_015_khata_debits_and_payment_links.sql",
  "migration_016_system_updates.sql",
  "migration_017_khata_receipts_trips_updates.sql",
  "migration_018_subscription_billing.sql",
  "migration_019_user_audit_and_soft_delete.sql",
];

// Schema verification predicates for existing environments
const MIGRATION_SCHEMA_CHECKS = {
  "migration_001_schema.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'collections'",
      [db]
    );
    return r.length > 0;
  },
  "migration_002_new_features.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'email'",
      [db]
    );
    return r.length > 0;
  },
  "migration_003_roles_and_optional_fields.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'users' AND COLUMN_NAME = 'business_name'",
      [db]
    );
    return r.length > 0;
  },
  "migration_004_banking.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'banking'",
      [db]
    );
    return r.length > 0;
  },
  "migration_005_customer_details.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'title'",
      [db]
    );
    return r.length > 0;
  },
  "migration_006_banking_extended.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'banking' AND COLUMN_NAME = 'account_holder_name'",
      [db]
    );
    return r.length > 0;
  },
  "migration_006_user_profile_settings.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'users' AND COLUMN_NAME = 'business_type'",
      [db]
    );
    return r.length > 0;
  },
  "migration_007_document_system.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'document_status'",
      [db]
    );
    return r.length > 0;
  },
  "migration_008_separate_quotations.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'quotations'",
      [db]
    );
    return r.length > 0;
  },
  "migration_009_expand_quotation_payment_terms.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'quotations' AND COLUMN_NAME = 'payment_terms'",
      [db]
    );
    return r.length > 0 && r[0].DATA_TYPE === "text";
  },
  "migration_010_owner_console.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'users' AND COLUMN_NAME = 'employee_title'",
      [db]
    );
    return r.length > 0;
  },
  "migration_011_inventory_products_purchase_bills.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'purchase_bills'",
      [db]
    );
    return r.length > 0;
  },
  "migration_012_inventory_products_purchase_bills_mysql_compat.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'stock' AND COLUMN_NAME = 'unit'",
      [db]
    );
    return r.length > 0;
  },
  "migration_013_stock_purchase_bill_link.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'stock' AND COLUMN_NAME = 'purchase_bill_id'",
      [db]
    );
    return r.length > 0;
  },
  "migration_014_customer_dues_and_payments.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'customer_dues'",
      [db]
    );
    return r.length > 0;
  },
  "migration_015_khata_debits_and_payment_links.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'khata_entries'",
      [db]
    );
    return r.length > 0;
  },
  "migration_016_system_updates.sql": async (conn, db) => {
    const required = [
      ["users", "watermark_enabled"],
      ["company_settings", "watermark_enabled"],
      ["stock", "item_type"],
      ["vehicle_trips", "invoice_id"],
      ["khata_entries", "payment_mode"],
      ["payments", "payment_category"],
    ];

    const conditions = required
      .map(() => "(TABLE_NAME = ? AND COLUMN_NAME = ?)")
      .join(" OR ");

    const params = [db];
    for (const [table, column] of required) {
      params.push(table, column);
    }

    const [columns] = await conn.query(
      "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND (" +
      conditions + ")",
      params
    );

    if (columns.length !== required.length) return false;

    const [paymentCategory] = await conn.query(
      "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS " +
      "WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) " +
      "AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'payment_category'",
      [db]
    );

    return paymentCategory.length === 1 &&
      paymentCategory[0].COLUMN_DEFAULT === "money_received";
  },
  "migration_017_khata_receipts_trips_updates.sql": async (conn, db) => {
    const required = [
      ["khata_entries", "items"],
      ["khata_entries", "entry_time"],
      ["customer_dues", "items"],
      ["customer_dues", "due_time"],
      ["customer_dues", "payment_mode"],
      ["money_receipts", "transfer_type"],
      ["money_receipts", "receipt_time"],
      ["vehicle_trips", "trip_datetime"],
      ["vehicle_trips", "departure_time"],
      ["vehicle_trips", "reach_time"],
      ["vehicle_trips", "eway_bill_number"],
      ["vehicle_trips", "eway_bill_file"],
      ["vehicle_trips", "vehicle_photo"],
      ["vehicle_trips", "trip_photo"],
    ];

    const conditions = required
      .map(() => "(TABLE_NAME = ? AND COLUMN_NAME = ?)")
      .join(" OR ");

    const params = [db];
    for (const [table, column] of required) {
      params.push(table, column);
    }

    const [columns] = await conn.query(
      "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND (" +
      conditions + ")",
      params
    );

    return columns.length === required.length;
  },
  "migration_018_subscription_billing.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'subscription_plans'",
      [db]
    );
    return r.length > 0;
  },
  "migration_019_user_audit_and_soft_delete.sql": async (conn, db) => {
    const [r] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE (TABLE_SCHEMA = ? OR TABLE_SCHEMA = DATABASE()) AND TABLE_NAME = 'user_audit_logs'",
      [db]
    );
    return r.length > 0;
  },
};

async function applyMigrations() {
  const nodeEnv = process.env.NODE_ENV || "development";
  let dbHost, dbPort, dbUser, dbPassword, dbName;

  if (nodeEnv === "production") {
    dbHost = process.env.DB_HOST;
    dbPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;
    dbUser = process.env.DB_USER;
    dbPassword = process.env.DB_PASSWORD;
    dbName = process.env.DB_NAME;
  } else {
    // Development / CI: Respect env variables if provided, fallback to standard CI service defaults
    dbHost = (process.env.DB_HOST || "localhost").trim();
    dbPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3307;
    dbUser = (process.env.DB_USER || "root").trim();
    dbPassword = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : "password1";
    dbName = (process.env.DB_NAME || "khatanex").trim();
  }

  let connection;

  try {
    // Attempt connection directly to the target database
    try {
      connection = await mysql.createConnection({
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: dbPassword,
        database: dbName,
        multipleStatements: true,
      });
    } catch (err) {
      // If target database doesn't exist yet, connect to server without db specified and create it
      if (err.code === "ER_BAD_DB_ERROR" || err.errno === 1049) {
        console.log(`ℹ️ Database "${dbName}" does not exist. Creating database...`);
        connection = await mysql.createConnection({
          host: dbHost,
          port: dbPort,
          user: dbUser,
          password: dbPassword,
          multipleStatements: true,
        });
        await connection.query(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
        );
        await connection.query(`USE \`${dbName}\`;`);
      } else {
        throw err;
      }
    }

    const [vRows] = await connection.query("SELECT VERSION() AS ver;");
    const serverVersion = (vRows && vRows[0]?.ver) || "";
    const isMariaDB = serverVersion.toLowerCase().includes("mariadb");

    console.log(
      `✅ Connected to database "${dbName}" on ${dbHost}:${dbPort} (${
        isMariaDB ? "MariaDB" : "MySQL"
      } ${serverVersion}).`
    );

    // Ensure migrations table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name VARCHAR(255) NOT NULL UNIQUE
      );
    `);

    // Query existing applied migrations
    const [rows] = await connection.query("SELECT name FROM migrations;");
    const appliedMigrations = new Set(rows.map((row) => row.name));

    // Read migration files from db directory
    const dbDir = path.join(__dirname, "../db");
    if (!fs.existsSync(dbDir)) {
      console.error(`❌ Migration directory not found at: ${dbDir}`);
      process.exit(1);
    }

    const diskFiles = fs.readdirSync(dbDir).filter((file) => /^migration_.*\.sql$/i.test(file));

    // Merge disk files with historical migration list to ensure complete explicit registry
    const allFilesSet = new Set([...MIGRATION_HISTORY, ...diskFiles]);
    const migrationFiles = Array.from(allFilesSet)
      .filter((file) => fs.existsSync(path.join(dbDir, file)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

    if (migrationFiles.length === 0) {
      console.log("ℹ️ No migration files found in db directory.");
      await connection.end();
      return;
    }

    let appliedCount = 0;

    for (const file of migrationFiles) {
      const baseNameWithoutExt = file.replace(/\.sql$/i, "");

      // If already recorded without .sql extension, normalize to actual migration filename
      if (appliedMigrations.has(baseNameWithoutExt)) {
        if (!appliedMigrations.has(file)) {
          await connection.query("UPDATE migrations SET name = ? WHERE name = ?;", [file, baseNameWithoutExt]);
          appliedMigrations.delete(baseNameWithoutExt);
          appliedMigrations.add(file);
          console.log(`🔄 Normalized migration record to actual filename: ${file}`);
        } else {
          await connection.query("DELETE FROM migrations WHERE name = ?;", [baseNameWithoutExt]);
          appliedMigrations.delete(baseNameWithoutExt);
        }
      }

      // Check if migration has already been applied in tracking table
      if (appliedMigrations.has(file)) {
        console.log(`⏩ Skipping already applied migration: ${file}`);
        continue;
      }

      // Check if existing database schema already contains this migration (e.g. pre-existing Hostinger/dev environment)
      const schemaCheckFn = MIGRATION_SCHEMA_CHECKS[file];
      if (schemaCheckFn) {
        try {
          const alreadyInSchema = await schemaCheckFn(connection, dbName);
          if (alreadyInSchema) {
            console.log(`📌 Migration schema already verified present in "${dbName}": ${file}`);
            await connection.query("INSERT INTO migrations (name) VALUES (?);", [file]);
            appliedMigrations.add(file);
            continue;
          }
        } catch (_) {
          // Proceed to normal execution if schema check query cannot run
        }
      }

      console.log(`\n⏳ Applying migration: ${file}...`);
      const filePath = path.join(dbDir, file);
      let sqlContent = fs.readFileSync(filePath, "utf8");

      // Enforce Rule: NEVER execute USE <database> statements inside migrations
      sqlContent = sqlContent.replace(/^\s*USE\s+[^;]+;/gim, "-- [Stripped USE statement]");

      if (!sqlContent.trim()) {
        console.log(`⚠️ Migration file ${file} is empty. Marking as applied.`);
      } else {
        try {
          if (isMariaDB) {
            // MariaDB natively supports ADD COLUMN IF NOT EXISTS and multi-statement scripts
            await connection.query(sqlContent);
          } else {
            // Try native execution first (for standard DDL)
            try {
              await connection.query(sqlContent);
            } catch (nativeErr) {
              // Local MySQL 8.x compatibility shim:
              // MySQL 8 does not support "ADD COLUMN IF NOT EXISTS".
              // Strip comments first, split into statements, and execute safely.
              if (nativeErr.message.includes("IF NOT EXISTS") || nativeErr.errno === 1064) {
                const noComments = sqlContent.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, "").trim();
                const rawStatements = noComments
                  .split(/;\s*[\r\n]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);

                for (const rawStmt of rawStatements) {
                  try {
                    await connection.query(rawStmt);
                  } catch (stmtErr) {
                    if (stmtErr.errno === 1064 && stmtErr.message.includes("IF NOT EXISTS")) {
                      let stripped = rawStmt.replace(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi, "ADD COLUMN");
                      let cleanStmt = stripped.replace(/^\s*--[^\r\n]*[\r\n]*/gm, "").trim();
                      const alterMatch = cleanStmt.match(/^ALTER\s+TABLE\s+([a-zA-Z0-9_`]+)\s+(.+)$/is);
                      if (alterMatch && alterMatch[2].includes(",")) {
                        const tableName = alterMatch[1];
                        const clauses = alterMatch[2].split(/,\s*(?=ADD\s+COLUMN)/i);
                        for (const clause of clauses) {
                          const cleanedClause = clause.trim().replace(/,+$/, "");
                          const singleAlter = `ALTER TABLE ${tableName} ${cleanedClause}`;
                          try {
                            await connection.query(singleAlter);
                          } catch (subErr) {
                            if (
                              subErr.errno === 1060 ||
                              subErr.errno === 1050 ||
                              subErr.errno === 1061 ||
                              subErr.errno === 1826
                            ) {
                              continue;
                            }
                            throw subErr;
                          }
                        }
                        continue;
                      }

                      try {
                        await connection.query(stripped);
                      } catch (retryErr) {
                        if (
                          retryErr.errno === 1060 ||
                          retryErr.errno === 1050 ||
                          retryErr.errno === 1061 ||
                          retryErr.errno === 1826
                        ) {
                          continue;
                        }
                        throw retryErr;
                      }
                    } else if (
                      stmtErr.errno === 1060 ||
                      stmtErr.errno === 1050 ||
                      stmtErr.errno === 1061 ||
                      stmtErr.errno === 1826
                    ) {
                      continue;
                    } else {
                      throw stmtErr;
                    }
                  }
                }
              } else {
                throw nativeErr;
              }
            }
          }
        } catch (err) {
          console.error(`\n❌ Error executing migration SQL in "${file}":`);
          console.error(err.message || err);
          process.exit(1);
        }
      }

      // Record migration in migrations table
      try {
        await connection.query("INSERT INTO migrations (name) VALUES (?);", [file]);
        console.log(`✅ Successfully applied and recorded migration: ${file}`);
        appliedCount++;
      } catch (err) {
        console.error(`\n❌ Error recording migration "${file}" into migrations table:`);
        console.error(err.message || err);
        process.exit(1);
      }
    }

    if (appliedCount === 0) {
      console.log("\n✨ Database is already up to date. No new migrations applied.");
    } else {
      console.log(`\n🎉 Successfully applied ${appliedCount} absent migration(s).`);
    }
  } catch (err) {
    console.error("\n❌ Migration process failed:", err.message || err);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

applyMigrations();
