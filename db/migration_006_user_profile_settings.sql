-- FIRST TRACK KHATANEX — Migration 006: user profile & business settings

USE first_track_khatanex;

ALTER TABLE users
  ADD COLUMN business_type VARCHAR(100) DEFAULT NULL AFTER business_name,
  ADD COLUMN gstin VARCHAR(20) DEFAULT NULL AFTER business_type,
  ADD COLUMN pan VARCHAR(20) DEFAULT NULL AFTER gstin,
  ADD COLUMN website VARCHAR(255) DEFAULT NULL AFTER pan,
  ADD COLUMN logo_path VARCHAR(255) DEFAULT NULL AFTER website,
  ADD COLUMN signature_path VARCHAR(255) DEFAULT NULL AFTER logo_path,
  ADD COLUMN address_line1 VARCHAR(255) DEFAULT NULL AFTER address,
  ADD COLUMN address_line2 VARCHAR(255) DEFAULT NULL AFTER address_line1,
  ADD COLUMN city VARCHAR(100) DEFAULT NULL AFTER address_line2,
  ADD COLUMN state VARCHAR(100) DEFAULT NULL AFTER city,
  ADD COLUMN pincode VARCHAR(20) DEFAULT NULL AFTER state,
  ADD COLUMN country VARCHAR(100) DEFAULT 'India' AFTER pincode,
  ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'INR' AFTER country,
  ADD COLUMN tax_type VARCHAR(30) NOT NULL DEFAULT 'standard' AFTER currency,
  ADD COLUMN tcs_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER tax_type,
  ADD COLUMN tds_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER tcs_enabled,
  ADD COLUMN payment_terms VARCHAR(255) DEFAULT NULL AFTER tds_enabled;

ALTER TABLE banking
  ADD COLUMN account_holder_name VARCHAR(150) DEFAULT NULL AFTER bank_name,
  ADD COLUMN account_number VARCHAR(50) DEFAULT NULL AFTER account_holder_name,
  ADD COLUMN account_type VARCHAR(30) DEFAULT NULL AFTER account_number,
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0 AFTER ifsc_code;

CREATE INDEX idx_banking_creator_default
  ON banking(created_by, is_default);
