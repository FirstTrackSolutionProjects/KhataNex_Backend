-- Migration 030: Subscription Order Invoice Number Persistence
-- Ensures subscription_orders table stores the generated invoice_number permanently,
-- establishing direct database persistence on both subscription_orders and subscription_invoices.

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = (SELECT DATABASE()))
    AND TABLE_NAME = 'subscription_orders'
    AND COLUMN_NAME = 'invoice_number'
);

SET @sql = IF(
  @col_exists = 0,
  'ALTER TABLE subscription_orders ADD COLUMN invoice_number VARCHAR(40) NULL DEFAULT NULL AFTER order_number, ADD UNIQUE KEY uq_sub_orders_invoice_number (invoice_number)',
  'SELECT "Column invoice_number already exists on subscription_orders"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill existing invoice numbers from subscription_invoices into subscription_orders
UPDATE subscription_orders o
JOIN subscription_invoices i ON i.order_id = o.id
SET o.invoice_number = i.invoice_number
WHERE o.invoice_number IS NULL;

