-- Migration 016: Watermark preference, Inventory item type, Vehicle invoice link, Payment categories and Khata sync

-- 1. Watermark preference for Users and Company Settings (Default ON = 1)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS watermark_enabled TINYINT(1) NOT NULL DEFAULT 1;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS watermark_enabled TINYINT(1) NOT NULL DEFAULT 1;

-- 2. Inventory item type support in Stock (goods / service / null)
ALTER TABLE stock
  ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT NULL;

-- 3. Vehicle Trips invoice reference
ALTER TABLE vehicle_trips
  ADD COLUMN IF NOT EXISTS invoice_id INT NULL;

-- 4. Khata entries payment mode (cash / upi)
ALTER TABLE khata_entries
  ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'cash';

-- 5. Payment category default update to money_received (normal received)
ALTER TABLE payments
  MODIFY COLUMN payment_category VARCHAR(50) NOT NULL DEFAULT 'money_received';
