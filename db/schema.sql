-- FIRST TRACK KHATANEX — Database Schema (v3)
-- Run this once against your MySQL server:
--   mysql -u root -p < db/schema.sql
--
-- If you already have a database from an earlier version, do NOT run this —
-- run db/migration_003_roles_and_optional_fields.sql instead (see that file's
-- header comment for exactly when to use it).

CREATE DATABASE IF NOT EXISTS first_track_khatanex
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE first_track_khatanex;

-- ---------------------------------------------------------------------
-- USERS
--   role = 'user'        -> self-registers via /api/auth/register, uses
--                           the normal operational dashboard.
--   role = 'employee'    -> created directly by the super admin (with
--                           login credentials assigned by the super admin,
--                           never self-registered), also uses the normal
--                           operational dashboard, with an employee_role_type
--                           label (e.g. "accountant") for reference.
--   role = 'superadmin'  -> exactly one account, created only via
--                           scripts/createSuperAdmin.js. Sees the
--                           overview dashboard + manages employees.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(100) DEFAULT NULL,
  email              VARCHAR(150) NOT NULL UNIQUE,
  phone              VARCHAR(20) DEFAULT NULL,
  password           VARCHAR(255) NOT NULL,
  business_name      VARCHAR(150) DEFAULT NULL,
  address            VARCHAR(255) DEFAULT NULL,
  role               ENUM('user','employee','superadmin') NOT NULL DEFAULT 'user',
  employee_role_type VARCHAR(50)  DEFAULT NULL,      -- e.g. accountant, manager, stock-keeper
  status             ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by_admin   INT DEFAULT NULL,               -- super admin who created this employee
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_admin) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- CUSTOMERS  — nothing here is mandatory; a blank add-customer form still
-- creates a row (name defaults to "Unnamed Customer" if left blank).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(150) DEFAULT 'Unnamed Customer',
  phone        VARCHAR(20) DEFAULT NULL,
  email        VARCHAR(150) DEFAULT NULL,
  total_due    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_by   INT DEFAULT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- COLLECTIONS  (every sale entry: cash / online (UPI) / due). Nothing is
-- mandatory — amount defaults to 0, payment_type defaults to 'cash'.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  item_name     VARCHAR(150) DEFAULT NULL,
  amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_type  ENUM('cash','online','due') NOT NULL DEFAULT 'cash',
  customer_id   INT DEFAULT NULL,
  sale_date     DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_by    INT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PAYMENTS  (due received from customer / paid out by business / advance
-- from investor). Nothing is mandatory.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  payment_category  ENUM('due_received','paid_by_business','advance_from_investor')
                     NOT NULL DEFAULT 'due_received',
  party_name        VARCHAR(150) DEFAULT NULL,
  customer_id       INT DEFAULT NULL,
  purpose           VARCHAR(255) DEFAULT NULL,
  amount            DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_mode      ENUM('cash','online') NOT NULL DEFAULT 'cash',
  payment_date      DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_by        INT DEFAULT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- STOCK  — nothing is mandatory.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  product_name  VARCHAR(150) DEFAULT 'Unnamed product',
  category      VARCHAR(100) DEFAULT NULL,
  type          VARCHAR(100) DEFAULT NULL,
  hsn_code      VARCHAR(20) DEFAULT NULL,
  price         DECIMAL(12,2) NOT NULL DEFAULT 0,
  quantity      INT NOT NULL DEFAULT 0,
  created_by    INT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PURCHASE INVOICES  (records of what a seller billed us for, keyed by
-- HSN code — powers "auto-fetch price/quantity by HSN code" when adding
-- stock). Nothing is mandatory.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  seller_name     VARCHAR(150) DEFAULT NULL,
  invoice_number  VARCHAR(50) DEFAULT NULL,
  product_name    VARCHAR(150) DEFAULT NULL,
  hsn_code        VARCHAR(20) DEFAULT NULL,
  quantity        DECIMAL(10,2) NOT NULL DEFAULT 0,
  price           DECIMAL(12,2) NOT NULL DEFAULT 0,
  invoice_file    VARCHAR(255) DEFAULT NULL,
  invoice_date    DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_by      INT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- COMPANY SETTINGS  (single row: brand name, address, GSTIN, logo — used
-- on generated invoice / quotation / merchant bill / way bill PDFs)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
  id            INT PRIMARY KEY DEFAULT 1,
  company_name  VARCHAR(150) NOT NULL DEFAULT 'FIRST TRACK KHATANEX',
  address       VARCHAR(255) DEFAULT NULL,
  gstin         VARCHAR(20) DEFAULT NULL,
  logo_path     VARCHAR(255) DEFAULT NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
INSERT IGNORE INTO company_settings (id) VALUES (1);

-- ---------------------------------------------------------------------
-- BILLING DOCUMENTS  — one shared table for Invoice / Quotation / Merchant
-- Bill. doc_type decides the number prefix (INV-/QUO-/BILL-) and the PDF
-- title; everything else (items, PDF generation, optional auto-email)
-- is shared code. Nothing is mandatory — customer_id may be NULL (a
-- walk-in / unnamed customer), and an empty items list is allowed
-- (totals just come out to 0).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  doc_type        ENUM('invoice','quotation','merchant_bill') NOT NULL DEFAULT 'invoice',
  invoice_number  VARCHAR(30) NOT NULL UNIQUE,
  customer_id     INT DEFAULT NULL,
  invoice_date    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  subtotal        DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  pdf_path        VARCHAR(255) DEFAULT NULL,
  email_status    ENUM('not_sent','sent','failed') NOT NULL DEFAULT 'not_sent',
  created_by      INT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id    INT NOT NULL,
  product_name  VARCHAR(150) DEFAULT 'Item',
  hsn_code      VARCHAR(20) DEFAULT NULL,
  quantity      DECIMAL(10,2) NOT NULL DEFAULT 1,
  price         DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- VEHICLE TRIPS / WAY BILLS  — nothing is mandatory, including vehicle
-- number, driver details, and both photo fields.
--   trip_type = 'outgoing'  -> WE are sending the truck: a way bill is
--               generated automatically; start-trip / reached buttons
--               stamp real timestamps.
--   trip_type = 'incoming'  -> WE are the buyer: the seller's way bill
--               (received e.g. over WhatsApp) can be uploaded here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_trips (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  trip_type             ENUM('outgoing','incoming') NOT NULL DEFAULT 'outgoing',
  vehicle_number        VARCHAR(30) DEFAULT NULL,
  driver_name           VARCHAR(100) DEFAULT NULL,
  driver_phone          VARCHAR(20) DEFAULT NULL,
  from_location         VARCHAR(150) DEFAULT NULL,
  to_location            VARCHAR(150) DEFAULT NULL,
  goods_description     VARCHAR(255) DEFAULT NULL,
  loading_photo         VARCHAR(255) DEFAULT NULL,
  unloading_photo       VARCHAR(255) DEFAULT NULL,
  waybill_number        VARCHAR(50) DEFAULT NULL,
  waybill_pdf_path      VARCHAR(255) DEFAULT NULL,
  waybill_uploaded_file VARCHAR(255) DEFAULT NULL,
  journey_start_time    DATETIME DEFAULT NULL,
  journey_end_time      DATETIME DEFAULT NULL,
  status                ENUM('created','in_transit','completed') NOT NULL DEFAULT 'created',
  created_by            INT DEFAULT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- EXPENSES  (daily business cash outflow). Nothing is mandatory.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  description   VARCHAR(255) DEFAULT 'Expense',
  category      VARCHAR(100) DEFAULT NULL,
  amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  expense_date  DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_by    INT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Helpful indexes for date-range & sort queries
CREATE INDEX idx_collections_date ON collections(sale_date);
CREATE INDEX idx_collections_creator ON collections(created_by);
CREATE INDEX idx_payments_date ON payments(payment_date);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_stock_name ON stock(product_name);
CREATE INDEX idx_stock_hsn ON stock(hsn_code);
CREATE INDEX idx_purchase_invoices_hsn ON purchase_invoices(hsn_code);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_doctype ON invoices(doc_type);
CREATE INDEX idx_vehicle_trips_type ON vehicle_trips(trip_type);
CREATE INDEX idx_vehicle_trips_vehicle ON vehicle_trips(vehicle_number);
