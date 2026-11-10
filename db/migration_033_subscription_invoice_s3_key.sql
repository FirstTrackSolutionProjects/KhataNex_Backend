-- Migration 033: Persist S3 object keys for subscription invoices

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'subscription_invoices'
    AND COLUMN_NAME = 's3_key'
);

SET @sql = IF(
  @col_exists = 0,
  'ALTER TABLE subscription_invoices ADD COLUMN s3_key VARCHAR(512) NULL',
  'SELECT "Column s3_key already exists on subscription_invoices"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
