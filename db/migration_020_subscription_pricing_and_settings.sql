-- FIRST TRACK KHATANEX — Migration 020: Subscription Pricing Update and Settings Configuration
-- 1. Updates subscription_plans to new pricing:
--    Monthly: 29900 (regular) / 14900 (intro)
--    6 Months: 159900 (regular) / 85900 (intro)
--    Yearly: 329900 (regular) / 149900 (intro)
-- 2. Adds description column to subscription_plans
-- 3. Creates subscription_settings table for Superadmin controls
-- 4. Creates subscription_settings_audit table for audit logging

-- Add optional description column to plans
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS description VARCHAR(255) NULL DEFAULT NULL AFTER duration_months;

-- Update plan pricing
UPDATE subscription_plans
SET price_paise = 29900,
    introductory_price_paise = 14900,
    description = 'Full-featured monthly access to digital ledger, invoicing, and khata.'
WHERE code = 'monthly';

UPDATE subscription_plans
SET price_paise = 159900,
    introductory_price_paise = 85900,
    description = 'Save more with 6 months of uninterrupted ledger and invoicing access.'
WHERE code = 'six_months';

UPDATE subscription_plans
SET price_paise = 329900,
    introductory_price_paise = 149900,
    description = 'Best value: 1 full year with all premium tools and maximum savings.'
WHERE code = 'yearly';

-- Create subscription_settings table
CREATE TABLE IF NOT EXISTS subscription_settings (
  id                        INT PRIMARY KEY DEFAULT 1,
  intro_offers_enabled      TINYINT(1) NOT NULL DEFAULT 1,
  tax_percent               DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  tax_inclusive             TINYINT(1) NOT NULL DEFAULT 1,
  subscription_enforcement  ENUM('off','on') NOT NULL DEFAULT 'off',
  reminders_enabled         TINYINT(1) NOT NULL DEFAULT 1,
  reminder_days             VARCHAR(50) NOT NULL DEFAULT '7,3,1',
  updated_by                INT DEFAULT NULL,
  updated_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Seed default settings row if not present
INSERT INTO subscription_settings (id, intro_offers_enabled, tax_percent, tax_inclusive, subscription_enforcement, reminders_enabled, reminder_days)
VALUES (1, 1, 18.00, 1, 'off', 1, '7,3,1')
ON DUPLICATE KEY UPDATE id = id;

-- Create settings audit log
CREATE TABLE IF NOT EXISTS subscription_settings_audit (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  superadmin_id  INT NOT NULL,
  action         VARCHAR(50) NOT NULL,
  previous_value JSON DEFAULT NULL,
  new_value      JSON DEFAULT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_settings_audit_admin (superadmin_id),
  FOREIGN KEY (superadmin_id) REFERENCES users(id)
) ENGINE=InnoDB;

