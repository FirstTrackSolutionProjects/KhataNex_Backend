-- Migration 014: Customer Dues, Due Allocations, and Payments Extension

CREATE TABLE IF NOT EXISTS customer_dues (
  id INT NOT NULL AUTO_INCREMENT,
  customer_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  remaining_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  due_date DATE NULL,
  status ENUM('pending', 'partially_paid', 'settled') NOT NULL DEFAULT 'pending',
  created_by INT NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_customer_dues_customer (customer_id),
  KEY idx_customer_dues_created_by (created_by),
  CONSTRAINT fk_customer_dues_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_dues_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_due_allocations (
  id INT NOT NULL AUTO_INCREMENT,
  payment_id INT NOT NULL,
  due_id INT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cda_payment (payment_id),
  KEY idx_cda_due (due_id),
  CONSTRAINT fk_cda_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE,
  CONSTRAINT fk_cda_due FOREIGN KEY (due_id) REFERENCES customer_dues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payments MODIFY COLUMN payment_category VARCHAR(50) NOT NULL DEFAULT 'due_received';

ALTER TABLE payments
  ADD COLUMN product_id INT NULL,
  ADD COLUMN product_name VARCHAR(150) NULL,
  ADD COLUMN quantity DECIMAL(10, 2) NULL DEFAULT 1.00,
  ADD COLUMN unit_price DECIMAL(12, 2) NULL,
  ADD COLUMN add_to_khata TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE payments
  ADD CONSTRAINT fk_payments_stock FOREIGN KEY (product_id) REFERENCES stock (id) ON DELETE SET NULL;

UPDATE payments SET add_to_khata = 1 WHERE payment_category = 'paid_by_business';
