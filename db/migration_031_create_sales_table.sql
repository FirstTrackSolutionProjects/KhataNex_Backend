-- ============================================================================
-- Migration 031: Create Sales Table
--
-- Objective:
--   Establish the Sales management module table with full tenant isolation,
--   customer linkage, inventory/stock tracking, and seamless integration
--   with official KhataNex tax invoices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  customer_id INT NULL,
  customer_name VARCHAR(191) NOT NULL,
  customer_phone VARCHAR(50) NULL,
  customer_email VARCHAR(191) NULL,
  customer_address TEXT NULL,
  customer_gstin VARCHAR(30) NULL,
  product_id INT NULL,
  product_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NULL,
  quantity DECIMAL(12,2) NOT NULL DEFAULT 1.00,
  unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
  unit_price DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  payment_mode VARCHAR(50) NOT NULL DEFAULT 'cash',
  amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sale_date DATE NOT NULL,
  sale_time TIME NOT NULL,
  notes TEXT NULL,
  invoice_id INT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sales_user_date (user_id, sale_date),
  INDEX idx_sales_customer (user_id, customer_id),
  INDEX idx_sales_invoice (invoice_id),
  INDEX idx_sales_product (product_id),
  INDEX idx_sales_created_by (created_by),
  CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_product FOREIGN KEY (product_id) REFERENCES stock(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
