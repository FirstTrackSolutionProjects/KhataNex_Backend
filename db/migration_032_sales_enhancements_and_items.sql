-- ============================================================================
-- Migration 032: Sales Module Enhancements, Sale Items & Purchase Selling Price
--
-- Objective:
--   1. Support multi-item sales transactions with full line-item auditing (sale_items).
--   2. Add sale_number, subtotal, tax_amount, paid_amount, due_amount, payment_status to sales.
--   3. Enable bi-directional linking between sales, payments, and invoices.
--   4. Persist purchase_price in stock table separately from selling price (price).
-- ============================================================================

-- 1. Add purchase_price to stock table if not already present
SET @col_stock_purchase_price := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'stock' AND COLUMN_NAME = 'purchase_price'
);
SET @sql_stock_purchase_price := IF(
  @col_stock_purchase_price = 0,
  'ALTER TABLE stock ADD COLUMN purchase_price DECIMAL(12,2) NULL DEFAULT 0.00 AFTER price',
  'SELECT 1'
);
PREPARE stmt FROM @sql_stock_purchase_price;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add enhanced columns to sales table
SET @col_sales_sale_number := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'sale_number'
);
SET @sql_sales_sale_number := IF(
  @col_sales_sale_number = 0,
  'ALTER TABLE sales ADD COLUMN sale_number VARCHAR(100) NULL AFTER user_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_sale_number;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_subtotal := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'subtotal'
);
SET @sql_sales_subtotal := IF(
  @col_sales_subtotal = 0,
  'ALTER TABLE sales ADD COLUMN subtotal DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER discount',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_subtotal;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_tax_amount := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'tax_amount'
);
SET @sql_sales_tax_amount := IF(
  @col_sales_tax_amount = 0,
  'ALTER TABLE sales ADD COLUMN tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER subtotal',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_tax_amount;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_paid_amount := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'paid_amount'
);
SET @sql_sales_paid_amount := IF(
  @col_sales_paid_amount = 0,
  'ALTER TABLE sales ADD COLUMN paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER amount',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_paid_amount;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_due_amount := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'due_amount'
);
SET @sql_sales_due_amount := IF(
  @col_sales_due_amount = 0,
  'ALTER TABLE sales ADD COLUMN due_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER paid_amount',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_due_amount;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_payment_status := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'payment_status'
);
SET @sql_sales_payment_status := IF(
  @col_sales_payment_status = 0,
  'ALTER TABLE sales ADD COLUMN payment_status VARCHAR(50) NOT NULL DEFAULT \'paid\' AFTER due_amount',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_payment_status;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_bank_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'bank_id'
);
SET @sql_sales_bank_id := IF(
  @col_sales_bank_id = 0,
  'ALTER TABLE sales ADD COLUMN bank_id INT NULL AFTER payment_mode',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_bank_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_sales_payment_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'payment_id'
);
SET @sql_sales_payment_id := IF(
  @col_sales_payment_id = 0,
  'ALTER TABLE sales ADD COLUMN payment_id INT NULL AFTER invoice_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql_sales_payment_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add sale_id to payments table
SET @col_payments_sale_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'sale_id'
);
SET @sql_payments_sale_id := IF(
  @col_payments_sale_id = 0,
  'ALTER TABLE payments ADD COLUMN sale_id INT NULL AFTER khata_entry_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql_payments_sale_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Add sale_id to invoices table
SET @col_invoices_sale_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE (TABLE_SCHEMA = DATABASE() OR TABLE_SCHEMA = @db_name)
    AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'sale_id'
);
SET @sql_invoices_sale_id := IF(
  @col_invoices_sale_id = 0,
  'ALTER TABLE invoices ADD COLUMN sale_id INT NULL AFTER created_by',
  'SELECT 1'
);
PREPARE stmt FROM @sql_invoices_sale_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. Create sale_items table for multi-item sales
CREATE TABLE IF NOT EXISTS sale_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  product_id INT NULL,
  product_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NULL,
  quantity DECIMAL(12,2) NOT NULL DEFAULT 1.00,
  unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
  unit_price DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  item_type VARCHAR(50) NOT NULL DEFAULT 'goods',
  hsn_code VARCHAR(50) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sale_items_sale (sale_id),
  INDEX idx_sale_items_product (product_id),
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES stock(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
