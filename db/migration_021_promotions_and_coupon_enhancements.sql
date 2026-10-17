-- FIRST TRACK KHATANEX — Migration 021: Promotions, Flash Sales, and Coupon Enhancements
-- 1. Adds soft-delete and metadata columns to coupons
-- 2. Normalizes existing flat coupon discount_values to paise
-- 3. Adds summary column to subscription_plans
-- 4. Creates promotions table for seasonal and flash sale campaigns

-- Soft-delete and metadata on coupons
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL DEFAULT NULL AFTER is_active,
  ADD COLUMN IF NOT EXISTS name VARCHAR(100) NULL DEFAULT NULL AFTER code,
  ADD COLUMN IF NOT EXISTS description VARCHAR(255) NULL DEFAULT NULL AFTER name;

-- Normalize any flat coupons whose discount_value was saved in rupees instead of paise
UPDATE coupons
SET discount_value = discount_value * 100
WHERE discount_type = 'flat' AND discount_value > 0 AND discount_value < 1000;

-- Add summary column to subscription_plans
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS summary VARCHAR(255) NULL DEFAULT NULL AFTER description;

-- Create promotions table for time-based offers, flash sales, and festival campaigns
CREATE TABLE IF NOT EXISTS promotions (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(100) NOT NULL,
  code                  VARCHAR(40) NULL DEFAULT NULL,
  discount_type         ENUM('percent', 'flat') NOT NULL,
  discount_value        INT UNSIGNED NOT NULL,
  max_discount_paise    INT UNSIGNED DEFAULT NULL,
  plan_code             VARCHAR(30) DEFAULT NULL,
  starts_at             DATETIME NOT NULL,
  ends_at               DATETIME NOT NULL,
  target_cohort         VARCHAR(20) DEFAULT NULL,
  user_eligibility      ENUM('all', 'new_users_only', 'existing_users_only') NOT NULL DEFAULT 'all',
  max_redemptions       INT UNSIGNED DEFAULT NULL,
  redemptions_count     INT UNSIGNED NOT NULL DEFAULT 0,
  per_user_limit        INT UNSIGNED NOT NULL DEFAULT 1,
  can_stack_with_coupon TINYINT(1) NOT NULL DEFAULT 0,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at            TIMESTAMP NULL DEFAULT NULL,
  created_by            INT DEFAULT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_promo_dates (starts_at, ends_at, is_active),
  KEY idx_promo_code (code),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Add promotion_id to subscription_orders
ALTER TABLE subscription_orders
  ADD COLUMN IF NOT EXISTS promotion_id INT NULL DEFAULT NULL AFTER coupon_id;

