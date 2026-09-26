-- FIRST TRACK KHATANEX — Extended Banking Details
-- Adds account details and default-bank support.

USE first_track_khatanex;

ALTER TABLE banking
  ADD COLUMN account_holder_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN account_number VARCHAR(100) DEFAULT NULL,
  ADD COLUMN account_type VARCHAR(50) DEFAULT NULL,
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX idx_banking_default ON banking(created_by, is_default);
