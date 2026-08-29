-- FIRST TRACK KHATANEX — Migration 002: Invoices, Purchase Invoices (HSN),
-- Company Settings, Vehicle Trips / Way Bills.
--
-- Run this ONLY if you already created the database from the earlier
-- version of db/schema.sql and have real data in it:
--   mysql -u root -p first_track_khatanex < db/migration_002_new_features.sql
--
-- If you are setting up fresh, just run db/schema.sql (already includes
-- everything below) and skip this file.

USE first_track_khatanex;

-- Note: "ADD COLUMN IF NOT EXISTS" requires MySQL 8.0.29+ / MariaDB 10.3+.
-- On an older server, drop the "IF NOT EXISTS" and just run each ALTER once.

-- Customers: add email so invoices can be auto-mailed to them
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(150) DEFAULT NULL AFTER phone;

-- Stock: add category + HSN code
ALTER TABLE stock ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT NULL AFTER product_name;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20) DEFAULT NULL AFTER type;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  seller_name     VARCHAR(150) NOT NULL,
  invoice_number  VARCHAR(50) DEFAULT NULL,
  product_name    VARCHAR(150) NOT NULL,
  hsn_code        VARCHAR(20) NOT NULL,
  quantity        DECIMAL(10,2) NOT NULL,
  price           DECIMAL(12,2) NOT NULL,
  invoice_file    VARCHAR(255) DEFAULT NULL,
  invoice_date    DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_by      INT NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS company_settings (
  id            INT PRIMARY KEY DEFAULT 1,
  company_name  VARCHAR(150) NOT NULL DEFAULT 'FIRST TRACK KHATANEX',
  address       VARCHAR(255) DEFAULT NULL,
  gstin         VARCHAR(20) DEFAULT NULL,
  logo_path     VARCHAR(255) DEFAULT NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
INSERT IGNORE INTO company_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  invoice_number  VARCHAR(30) NOT NULL UNIQUE,
  customer_id     INT NOT NULL,
  invoice_date    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  subtotal        DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  pdf_path        VARCHAR(255) DEFAULT NULL,
  email_status    ENUM('not_sent','sent','failed') NOT NULL DEFAULT 'not_sent',
  created_by      INT NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id    INT NOT NULL,
  product_name  VARCHAR(150) NOT NULL,
  hsn_code      VARCHAR(20) DEFAULT NULL,
  quantity      DECIMAL(10,2) NOT NULL DEFAULT 1,
  price         DECIMAL(12,2) NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  trip_type             ENUM('outgoing','incoming') NOT NULL,
  vehicle_number        VARCHAR(30) NOT NULL,
  driver_name           VARCHAR(100) NOT NULL,
  driver_phone          VARCHAR(20) NOT NULL,
  from_location         VARCHAR(150) DEFAULT NULL,
  to_location           VARCHAR(150) DEFAULT NULL,
  goods_description     VARCHAR(255) DEFAULT NULL,
  loading_photo         VARCHAR(255) DEFAULT NULL,
  unloading_photo       VARCHAR(255) DEFAULT NULL,
  waybill_number        VARCHAR(50) DEFAULT NULL,
  waybill_pdf_path      VARCHAR(255) DEFAULT NULL,
  waybill_uploaded_file VARCHAR(255) DEFAULT NULL,
  journey_start_time    DATETIME DEFAULT NULL,
  journey_end_time      DATETIME DEFAULT NULL,
  status                ENUM('created','in_transit','completed') NOT NULL DEFAULT 'created',
  created_by            INT NOT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_stock_hsn ON stock(hsn_code);
CREATE INDEX idx_purchase_invoices_hsn ON purchase_invoices(hsn_code);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_vehicle_trips_type ON vehicle_trips(trip_type);
CREATE INDEX idx_vehicle_trips_vehicle ON vehicle_trips(vehicle_number);
