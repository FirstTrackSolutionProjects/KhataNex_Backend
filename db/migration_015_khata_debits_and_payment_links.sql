-- Migration 015: Khata entries, Sale of Product support for Khata/Due, and Payment linking (Khata, Money Receipts, Purchase Bills)

CREATE TABLE IF NOT EXISTS khata_entries (
  id INT NOT NULL AUTO_INCREMENT,
  type ENUM('credit', 'debit') NOT NULL DEFAULT 'debit',
  customer_id INT NULL,
  amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  description VARCHAR(255) NULL,
  entry_date DATE NOT NULL,
  product_id INT NULL,
  quantity DECIMAL(10, 2) NULL,
  unit_price DECIMAL(12, 2) NULL,
  payment_id INT NULL,
  is_linked_to_payment TINYINT(1) NOT NULL DEFAULT 0,
  is_skipped TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ke_customer (customer_id),
  KEY idx_ke_product (product_id),
  KEY idx_ke_payment (payment_id),
  KEY idx_ke_created_by (created_by),
  CONSTRAINT fk_ke_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL,
  CONSTRAINT fk_ke_product FOREIGN KEY (product_id) REFERENCES stock (id) ON DELETE SET NULL,
  CONSTRAINT fk_ke_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE customer_dues
  ADD COLUMN product_id INT NULL,
  ADD COLUMN quantity DECIMAL(10, 2) NULL,
  ADD COLUMN unit_price DECIMAL(12, 2) NULL;

ALTER TABLE customer_dues
  ADD CONSTRAINT fk_cd_product FOREIGN KEY (product_id) REFERENCES stock (id) ON DELETE SET NULL;

ALTER TABLE payments
  ADD COLUMN purchase_bill_id INT NULL,
  ADD COLUMN money_receipt_id INT NULL,
  ADD COLUMN khata_entry_id INT NULL;

ALTER TABLE payments
  ADD CONSTRAINT fk_pay_pb FOREIGN KEY (purchase_bill_id) REFERENCES purchase_bills (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_pay_mr FOREIGN KEY (money_receipt_id) REFERENCES money_receipts (id) ON DELETE SET NULL;

ALTER TABLE money_receipts
  ADD COLUMN is_linked_to_payment TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN payment_id INT NULL;

ALTER TABLE purchase_bills
  ADD COLUMN is_paid TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN payment_id INT NULL;

ALTER TABLE invoice_items
  ADD COLUMN product_id INT NULL;

ALTER TABLE invoice_items
  ADD CONSTRAINT fk_inv_item_product FOREIGN KEY (product_id) REFERENCES stock (id) ON DELETE SET NULL;
