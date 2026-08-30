-- FIRST TRACK KHATANEX — Migration 003: role model change (admin -> employee),
-- everything becomes optional, business_name/address on users, and
-- doc_type (invoice/quotation/merchant_bill) on the billing documents table.
--
-- Run this ONLY if you already have a database created from schema.sql v1/v2
-- (i.e. before this migration existed):
--   mysql -u root -p first_track_khatanex < db/migration_003_roles_and_optional_fields.sql
--
-- If you are setting up fresh, just run db/schema.sql and skip this file.

USE first_track_khatanex;

-- ---- users: role rename admin -> employee, new profile fields ----
ALTER TABLE users MODIFY role ENUM('user','employee','superadmin','admin') NOT NULL DEFAULT 'user';
UPDATE users SET role = 'employee' WHERE role = 'admin';
ALTER TABLE users MODIFY role ENUM('user','employee','superadmin') NOT NULL DEFAULT 'user';

ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name VARCHAR(150) DEFAULT NULL AFTER password;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address VARCHAR(255) DEFAULT NULL AFTER business_name;
ALTER TABLE users MODIFY name VARCHAR(100) DEFAULT NULL;
ALTER TABLE users MODIFY phone VARCHAR(20) DEFAULT NULL;

-- ---- everything below: drop NOT NULL / add sensible defaults so no
-- field is mandatory anywhere ----
ALTER TABLE customers MODIFY name VARCHAR(150) DEFAULT 'Unnamed Customer';
ALTER TABLE customers MODIFY created_by INT DEFAULT NULL;

ALTER TABLE collections MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE collections MODIFY payment_type ENUM('cash','online','due') NOT NULL DEFAULT 'cash';
ALTER TABLE collections MODIFY created_by INT DEFAULT NULL;

ALTER TABLE payments MODIFY party_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE payments MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payments MODIFY payment_category ENUM('due_received','paid_by_business','advance_from_investor')
  NOT NULL DEFAULT 'due_received';
ALTER TABLE payments MODIFY created_by INT DEFAULT NULL;

ALTER TABLE stock MODIFY product_name VARCHAR(150) DEFAULT 'Unnamed product';
ALTER TABLE stock MODIFY price DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE stock MODIFY created_by INT DEFAULT NULL;

ALTER TABLE purchase_invoices MODIFY seller_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE purchase_invoices MODIFY product_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE purchase_invoices MODIFY hsn_code VARCHAR(20) DEFAULT NULL;
ALTER TABLE purchase_invoices MODIFY quantity DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_invoices MODIFY price DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_invoices MODIFY created_by INT DEFAULT NULL;

ALTER TABLE expenses MODIFY description VARCHAR(255) DEFAULT 'Expense';
ALTER TABLE expenses MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE expenses MODIFY created_by INT DEFAULT NULL;

ALTER TABLE vehicle_trips MODIFY trip_type ENUM('outgoing','incoming') NOT NULL DEFAULT 'outgoing';
ALTER TABLE vehicle_trips MODIFY vehicle_number VARCHAR(30) DEFAULT NULL;
ALTER TABLE vehicle_trips MODIFY driver_name VARCHAR(100) DEFAULT NULL;
ALTER TABLE vehicle_trips MODIFY driver_phone VARCHAR(20) DEFAULT NULL;
ALTER TABLE vehicle_trips MODIFY created_by INT DEFAULT NULL;

-- ---- billing documents: add doc_type, allow walk-in customer ----
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doc_type ENUM('invoice','quotation','merchant_bill')
  NOT NULL DEFAULT 'invoice' AFTER id;
ALTER TABLE invoices MODIFY customer_id INT DEFAULT NULL;
ALTER TABLE invoices MODIFY created_by INT DEFAULT NULL;
ALTER TABLE invoice_items MODIFY product_name VARCHAR(150) DEFAULT 'Item';
ALTER TABLE invoice_items MODIFY quantity DECIMAL(10,2) NOT NULL DEFAULT 1;
ALTER TABLE invoice_items MODIFY price DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice_items MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Note: "ADD COLUMN IF NOT EXISTS" / "CHANGE COLUMN" require MySQL 8.0.29+ /
-- MariaDB 10.3+. If your server is older, drop "IF NOT EXISTS" and run each
-- statement once (re-running a plain ADD COLUMN twice will error, which is
-- how you'll know it already applied).
