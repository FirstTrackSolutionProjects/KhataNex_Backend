const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function applyMigrations() {
  const nodeEnv = process.env.NODE_ENV || "development";
  let dbHost, dbPort, dbUser, dbPassword, dbName;
  
  if(nodeEnv === "production") {
    dbHost = process.env.DB_HOST
    dbPort = process.env.DB_PORT;
    dbUser = process.env.DB_USER;
    dbPassword = process.env.DB_PASSWORD;
    dbName = process.env.DB_NAME;
  } else {
    dbHost = "localhost";
    dbPort = 3307;
    dbUser = "root";
    dbPassword = "password1";
    dbName = "khatanex";
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
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        await connection.query(`USE \`${dbName}\`;`);
      } else {
        throw err;
      }
    }

    console.log(`✅ Connected to MySQL database "${dbName}".`);

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

    const files = fs.readdirSync(dbDir);

    // Filter migration files (e.g. migration_001_abc.sql) and sort in order of filename
    const migrationFiles = files
      .filter((file) => /^migration_.*\.sql$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

    if (migrationFiles.length === 0) {
      console.log("ℹ️ No migration files found in db directory.");
      await connection.end();
      return;
    }

    let appliedCount = 0;

    for (const file of migrationFiles) {
      const baseNameWithoutExt = file.replace(/\.sql$/i, "");
      
      // Check if migration has already been applied (checking both full filename and basename without extension)
      if (appliedMigrations.has(file) || appliedMigrations.has(baseNameWithoutExt)) {
        console.log(`⏩ Skipping already applied migration: ${file}`);
        continue;
      }

      console.log(`\n⏳ Applying migration: ${file}...`);
      const filePath = path.join(dbDir, file);
      const sqlContent = fs.readFileSync(filePath, "utf8");

      if (!sqlContent.trim()) {
        console.log(`⚠️ Migration file ${file} is empty. Marking as applied.`);
      } else {
        try {
          await connection.query(sqlContent);
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
