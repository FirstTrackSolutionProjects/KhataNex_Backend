-- FIRST TRACK KHATANEX — Migration 018: Subscription and Billing System
-- Tables: subscription_plans, coupons, subscription_orders, coupon_redemptions, subscriptions, subscription_invoices, payment_webhook_events

-- 1. Subscription Plans
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  code                     VARCHAR(30) NOT NULL UNIQUE,
  name                     VARCHAR(100) NOT NULL,
  duration_months          TINYINT UNSIGNED NOT NULL,
  price_paise              INT UNSIGNED NOT NULL,
  introductory_price_paise  INT UNSIGNED NOT NULL,
  is_active                TINYINT(1) NOT NULL DEFAULT 1,
  created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Initial Seed Plans: Monthly (₹249 reg / ₹129 intro), 6 Months (₹1,399 reg / ₹750 intro), 1 Year (₹2,899 reg / ₹1,299 intro)
INSERT INTO subscription_plans (code, name, duration_months, price_paise, introductory_price_paise, is_active)
VALUES
  ('monthly', 'Monthly Plan', 1, 24900, 12900, 1),
  ('six_months', '6 Months Plan', 6, 139900, 75000, 1),
  ('yearly', '1 Year Plan', 12, 289900, 129900, 1)
ON DUPLICATE KEY UPDATE
  price_paise = VALUES(price_paise),
  introductory_price_paise = VALUES(introductory_price_paise);

-- 2. Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  code               VARCHAR(40) NOT NULL UNIQUE,
  discount_type      ENUM('percent','flat') NOT NULL,
  discount_value     INT UNSIGNED NOT NULL,
  max_discount_paise INT UNSIGNED DEFAULT NULL,
  min_order_paise    INT UNSIGNED NOT NULL DEFAULT 0,
  max_redemptions    INT UNSIGNED DEFAULT NULL,
  redemptions_count  INT UNSIGNED NOT NULL DEFAULT 0,
  per_user_limit     INT UNSIGNED NOT NULL DEFAULT 1,
  plan_code          VARCHAR(30) DEFAULT NULL,
  valid_from         DATETIME DEFAULT NULL,
  valid_until        DATETIME DEFAULT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  target_cohort      VARCHAR(20) DEFAULT NULL,
  created_by         INT DEFAULT NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3. Subscription Orders
CREATE TABLE IF NOT EXISTS subscription_orders (
  id                          INT AUTO_INCREMENT PRIMARY KEY,
  order_number                VARCHAR(40) NOT NULL UNIQUE,
  user_id                     INT NOT NULL,
  plan_id                     INT NOT NULL,
  is_introductory             TINYINT(1) NOT NULL DEFAULT 0,
  list_price_paise            INT UNSIGNED NOT NULL,
  introductory_discount_paise INT UNSIGNED NOT NULL DEFAULT 0,
  coupon_id                   INT DEFAULT NULL,
  coupon_code                 VARCHAR(40) DEFAULT NULL,
  coupon_discount_paise       INT UNSIGNED NOT NULL DEFAULT 0,
  discount_paise              INT UNSIGNED NOT NULL DEFAULT 0,
  taxable_paise               INT UNSIGNED NOT NULL DEFAULT 0,
  tax_percent                 DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  tax_paise                   INT UNSIGNED NOT NULL DEFAULT 0,
  total_paise                 INT UNSIGNED NOT NULL,
  currency                    VARCHAR(10) NOT NULL DEFAULT 'INR',
  status                      ENUM('created','pending','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'created',
  provider                    VARCHAR(30) NOT NULL DEFAULT 'razorpay',
  provider_order_id           VARCHAR(100) DEFAULT NULL,
  provider_payment_id         VARCHAR(100) DEFAULT NULL,
  provider_signature          VARCHAR(255) DEFAULT NULL,
  notes                       TEXT DEFAULT NULL,
  paid_at                     DATETIME DEFAULT NULL,
  created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_orders_user (user_id),
  KEY idx_orders_status (status),
  KEY idx_orders_provider_order (provider_order_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 4. Coupon Redemptions
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  coupon_id    INT NOT NULL,
  user_id      INT NOT NULL,
  order_id     INT NOT NULL,
  status       ENUM('reserved','redeemed','released') NOT NULL DEFAULT 'reserved',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_coupon_order (coupon_id, order_id),
  KEY idx_redemptions_user (coupon_id, user_id),
  FOREIGN KEY (coupon_id) REFERENCES coupons(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES subscription_orders(id)
) ENGINE=InnoDB;

-- 5. Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  user_id            INT NOT NULL,
  plan_id            INT NOT NULL,
  order_id           INT NOT NULL UNIQUE,
  starts_at          DATETIME NOT NULL,
  ends_at            DATETIME NOT NULL,
  status             ENUM('active','expired','cancelled') NOT NULL DEFAULT 'active',
  is_complimentary   TINYINT(1) NOT NULL DEFAULT 0,
  notes              VARCHAR(255) DEFAULT NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_subs_user_ends (user_id, ends_at),
  KEY idx_subs_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (order_id) REFERENCES subscription_orders(id)
) ENGINE=InnoDB;

-- 6. Subscription Invoices
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  invoice_number  VARCHAR(40) NOT NULL UNIQUE,
  order_id        INT NOT NULL UNIQUE,
  user_id         INT NOT NULL,
  pdf_filename    VARCHAR(255) NOT NULL,
  issued_at       DATETIME NOT NULL,
  emailed_at      DATETIME DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES subscription_orders(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 7. Payment Webhook Events
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  provider      VARCHAR(30) NOT NULL DEFAULT 'razorpay',
  event_id      VARCHAR(100) NOT NULL,
  event_type    VARCHAR(100) NOT NULL,
  payload       JSON NOT NULL,
  status        ENUM('processed','ignored','failed') NOT NULL DEFAULT 'processed',
  error_message TEXT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_provider_event (provider, event_id)
) ENGINE=InnoDB;

-- 8. Users table column for introductory offer tracking
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS has_used_intro_offer TINYINT(1) NOT NULL DEFAULT 0;

