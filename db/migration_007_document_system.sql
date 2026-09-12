-- Migration 007: Document System
-- Invoice / Quotation / Money Receipt

CREATE TABLE IF NOT EXISTS document_sequences (
  year INT NOT NULL,
  doc_type ENUM('invoice', 'quotation', 'money_receipt') NOT NULL,
  last_number INT NOT NULL DEFAULT 0,
  PRIMARY KEY (year, doc_type)
);

ALTER TABLE invoices
  ADD COLUMN document_status ENUM('draft','issued','cancelled') NOT NULL DEFAULT 'issued',
  ADD COLUMN due_date DATE DEFAULT NULL,
  ADD COLUMN valid_until DATE DEFAULT NULL,
  ADD COLUMN discount_percent DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN cgst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN sgst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN igst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN tcs_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN tcs_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN tds_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN tds_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN round_off DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  ADD COLUMN payment_terms VARCHAR(255) DEFAULT NULL,
  ADD COLUMN notes TEXT DEFAULT NULL,
  ADD COLUMN terms_conditions TEXT DEFAULT NULL,
  ADD COLUMN bank_account_id INT DEFAULT NULL,
  ADD COLUMN quotation_converted_invoice_id INT DEFAULT NULL,

  ADD COLUMN from_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_business_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_email VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_phone VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_gstin VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_pan VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_website VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_address_line1 VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_address_line2 VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_city VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_state VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_pincode VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_country VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_logo_path VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_signature_path VARCHAR(255) DEFAULT NULL,

  ADD COLUMN to_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN to_business_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN to_email VARCHAR(150) DEFAULT NULL,
  ADD COLUMN to_phone VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_gstin VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_pan VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_billing_state VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_district VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_city VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_pincode VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_billing_landmark VARCHAR(255) DEFAULT NULL,
  ADD COLUMN to_shipping_state VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_shipping_district VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_shipping_city VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_shipping_pincode VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_shipping_landmark VARCHAR(255) DEFAULT NULL,

  ADD COLUMN bank_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN bank_branch VARCHAR(150) DEFAULT NULL,
  ADD COLUMN bank_account_holder_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN bank_account_number VARCHAR(50) DEFAULT NULL,
  ADD COLUMN bank_account_type VARCHAR(30) DEFAULT NULL,
  ADD COLUMN bank_ifsc_code VARCHAR(20) DEFAULT NULL;

ALTER TABLE invoice_items
  ADD COLUMN description TEXT DEFAULT NULL,
  ADD COLUMN category VARCHAR(100) DEFAULT NULL,
  ADD COLUMN item_type ENUM('goods','service') NOT NULL DEFAULT 'goods',
  ADD COLUMN unit VARCHAR(30) DEFAULT NULL,
  ADD COLUMN discount_percent DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN line_total DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS money_receipts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  receipt_number VARCHAR(30) NOT NULL UNIQUE,
  document_status ENUM('draft','issued','cancelled') NOT NULL DEFAULT 'issued',
  receipt_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  customer_id INT DEFAULT NULL,

  received_from_name VARCHAR(150) DEFAULT NULL,
  received_from_email VARCHAR(150) DEFAULT NULL,
  received_from_phone VARCHAR(20) DEFAULT NULL,

  against_type ENUM('invoice','multiple_invoices','advance','other')
    NOT NULL DEFAULT 'invoice',

  amount_received DECIMAL(12,2) NOT NULL DEFAULT 0,

  payment_mode ENUM(
    'cash',
    'upi',
    'bank_transfer',
    'cheque',
    'card',
    'other'
  ) NOT NULL DEFAULT 'cash',

  transaction_reference VARCHAR(100) DEFAULT NULL,

  bank_account_id INT DEFAULT NULL,
  bank_name VARCHAR(150) DEFAULT NULL,
  bank_branch VARCHAR(150) DEFAULT NULL,
  bank_account_holder_name VARCHAR(150) DEFAULT NULL,
  bank_account_number VARCHAR(50) DEFAULT NULL,
  bank_ifsc_code VARCHAR(20) DEFAULT NULL,

  description TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',

  pdf_path VARCHAR(255) DEFAULT NULL,

  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_money_receipts_customer
  ON money_receipts(customer_id);

CREATE INDEX idx_money_receipts_created_by
  ON money_receipts(created_by);

CREATE INDEX idx_money_receipts_date
  ON money_receipts(receipt_date);

ALTER TABLE money_receipts
  ADD COLUMN from_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_business_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_email VARCHAR(150) DEFAULT NULL,
  ADD COLUMN from_phone VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_gstin VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_pan VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_website VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_address_line1 VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_address_line2 VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_city VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_state VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_pincode VARCHAR(20) DEFAULT NULL,
  ADD COLUMN from_country VARCHAR(100) DEFAULT NULL,
  ADD COLUMN from_logo_path VARCHAR(255) DEFAULT NULL,
  ADD COLUMN from_signature_path VARCHAR(255) DEFAULT NULL,

  ADD COLUMN to_business_name VARCHAR(150) DEFAULT NULL,
  ADD COLUMN to_gstin VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_pan VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_billing_state VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_district VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_city VARCHAR(100) DEFAULT NULL,
  ADD COLUMN to_billing_pincode VARCHAR(20) DEFAULT NULL,
  ADD COLUMN to_billing_landmark VARCHAR(255) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS money_receipt_allocations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  money_receipt_id INT NOT NULL,
  invoice_id INT NOT NULL,
  amount_applied DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (money_receipt_id)
    REFERENCES money_receipts(id)
    ON DELETE CASCADE,

  FOREIGN KEY (invoice_id)
    REFERENCES invoices(id)
    ON DELETE CASCADE,

  UNIQUE KEY uq_receipt_invoice (money_receipt_id, invoice_id)
);

CREATE INDEX idx_receipt_allocations_invoice
  ON money_receipt_allocations(invoice_id);

CREATE INDEX idx_invoices_doc_type_date
  ON invoices(doc_type, invoice_date);

CREATE INDEX idx_invoices_created_by_date
  ON invoices(created_by, invoice_date);


CREATE INDEX idx_invoices_status
  ON invoices(document_status);