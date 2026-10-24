-- ============================================================================
-- Migration 024: Durable Email Outbox, Invoice Email Status & Activity Indexing
-- ============================================================================

-- 1. Create durable email_outbox table for reliable background email delivery
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  recipient_email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body_text TEXT NULL,
  body_html MEDIUMTEXT NULL,
  attachment_path VARCHAR(500) NULL,
  attachment_name VARCHAR(255) NULL,
  category ENUM(
    'subscription_invoice',
    'document_invoice',
    'document_quotation',
    'document_receipt',
    'subscription_reminder',
    'system',
    'other'
  ) NOT NULL DEFAULT 'other',
  reference_type VARCHAR(50) NULL,
  reference_id VARCHAR(100) NULL,
  status ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT NULL,
  next_retry_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_outbox_status_retry (status, next_retry_at),
  INDEX idx_outbox_reference (reference_type, reference_id),
  INDEX idx_outbox_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Add email_status and email_error to subscription_invoices
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'subscription_invoices'
    AND COLUMN_NAME = 'email_status'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE subscription_invoices ADD COLUMN email_status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending', ADD COLUMN email_error TEXT NULL AFTER email_status",
  "SELECT 1"
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add performance index on users.last_active_at for online presence queries
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_users_last_active_at'
);
SET @sql = IF(@idx_exists = 0,
  "ALTER TABLE users ADD INDEX idx_users_last_active_at (last_active_at)",
  "SELECT 1"
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Add performance index on subscription_orders(status, paid_at) for revenue reporting
SET @idx_orders_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'subscription_orders'
    AND INDEX_NAME = 'idx_sub_orders_status_paid'
);
SET @sql = IF(@idx_orders_exists = 0,
  "ALTER TABLE subscription_orders ADD INDEX idx_sub_orders_status_paid (status, paid_at)",
  "SELECT 1"
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

