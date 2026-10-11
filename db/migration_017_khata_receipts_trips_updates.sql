-- Migration 017: Khata items, time, money receipt transfer type, and vehicle trip fields
-- Supports MariaDB native execution and MySQL 8.x runner shim
-- Note: Do NOT add USE <database> statements

ALTER TABLE `khata_entries` ADD COLUMN IF NOT EXISTS `items` LONGTEXT NULL;
ALTER TABLE `khata_entries` ADD COLUMN IF NOT EXISTS `entry_time` TIME NULL;

ALTER TABLE `customer_dues` ADD COLUMN IF NOT EXISTS `items` LONGTEXT NULL;
ALTER TABLE `customer_dues` ADD COLUMN IF NOT EXISTS `due_time` TIME NULL;
ALTER TABLE `customer_dues` ADD COLUMN IF NOT EXISTS `payment_mode` VARCHAR(20) NULL DEFAULT 'credit';

ALTER TABLE `money_receipts` ADD COLUMN IF NOT EXISTS `transfer_type` VARCHAR(20) NULL;
ALTER TABLE `money_receipts` ADD COLUMN IF NOT EXISTS `receipt_time` TIME NULL;

ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `trip_datetime` DATETIME NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `departure_time` DATETIME NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `reach_time` DATETIME NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `eway_bill_number` VARCHAR(100) NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `eway_bill_file` VARCHAR(255) NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `vehicle_photo` VARCHAR(255) NULL;
ALTER TABLE `vehicle_trips` ADD COLUMN IF NOT EXISTS `trip_photo` VARCHAR(255) NULL;
