-- Migration 008: Separate Quotation Storage
-- Moves quotations out of invoices/invoice_items into dedicated tables.
-- Existing invoices, money receipts and allocations are untouched.

CREATE TABLE IF NOT EXISTS quotations (
  id INT AUTO_INCREMENT PRIMARY KEY,

  quotation_number VARCHAR(50) NOT NULL UNIQUE,
  customer_id INT DEFAULT NULL,
  quotation_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  document_status ENUM('draft','issued','cancelled') NOT NULL DEFAULT 'issued',
  valid_until DATE DEFAULT NULL,

  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  discount_percent DECIMAL(7,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  cgst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  cgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  sgst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  sgst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  igst_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  igst_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  tcs_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  tcs_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  tds_rate DECIMAL(7,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(12,2) NOT NULL DEFAULT 0,

  round_off DECIMAL(12,2) NOT NULL DEFAULT 0,

  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  payment_terms VARCHAR(255) DEFAULT NULL,

  notes TEXT DEFAULT NULL,
  terms_conditions TEXT DEFAULT NULL,

  bank_account_id INT DEFAULT NULL,

  from_name VARCHAR(150) DEFAULT NULL,
  from_business_name VARCHAR(150) DEFAULT NULL,
  from_email VARCHAR(150) DEFAULT NULL,
  from_phone VARCHAR(20) DEFAULT NULL,
  from_gstin VARCHAR(20) DEFAULT NULL,
  from_pan VARCHAR(20) DEFAULT NULL,
  from_website VARCHAR(255) DEFAULT NULL,
  from_address_line1 VARCHAR(255) DEFAULT NULL,
  from_address_line2 VARCHAR(255) DEFAULT NULL,
  from_city VARCHAR(100) DEFAULT NULL,
  from_state VARCHAR(100) DEFAULT NULL,
  from_pincode VARCHAR(20) DEFAULT NULL,
  from_country VARCHAR(100) DEFAULT NULL,
  from_logo_path VARCHAR(255) DEFAULT NULL,
  from_signature_path VARCHAR(255) DEFAULT NULL,

  to_name VARCHAR(150) DEFAULT NULL,
  to_business_name VARCHAR(150) DEFAULT NULL,
  to_email VARCHAR(150) DEFAULT NULL,
  to_phone VARCHAR(20) DEFAULT NULL,
  to_gstin VARCHAR(20) DEFAULT NULL,
  to_pan VARCHAR(20) DEFAULT NULL,
  to_billing_state VARCHAR(100) DEFAULT NULL,
  to_billing_district VARCHAR(100) DEFAULT NULL,
  to_billing_city VARCHAR(100) DEFAULT NULL,
  to_billing_pincode VARCHAR(20) DEFAULT NULL,
  to_billing_landmark VARCHAR(255) DEFAULT NULL,
  to_shipping_state VARCHAR(100) DEFAULT NULL,
  to_shipping_district VARCHAR(100) DEFAULT NULL,
  to_shipping_city VARCHAR(100) DEFAULT NULL,
  to_shipping_pincode VARCHAR(20) DEFAULT NULL,
  to_shipping_landmark VARCHAR(255) DEFAULT NULL,

  bank_name VARCHAR(150) DEFAULT NULL,
  bank_branch VARCHAR(150) DEFAULT NULL,
  bank_account_holder_name VARCHAR(150) DEFAULT NULL,
  bank_account_number VARCHAR(50) DEFAULT NULL,
  bank_account_type VARCHAR(30) DEFAULT NULL,
  bank_ifsc_code VARCHAR(20) DEFAULT NULL,

  pdf_path VARCHAR(255) DEFAULT NULL,

  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (customer_id)
    REFERENCES customers(id)
    ON DELETE SET NULL,

  FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_quotations_customer
  ON quotations(customer_id);

CREATE INDEX idx_quotations_created_by_date
  ON quotations(created_by, quotation_date);

CREATE INDEX idx_quotations_status
  ON quotations(document_status);


CREATE TABLE IF NOT EXISTS quotation_items (
  id INT AUTO_INCREMENT PRIMARY KEY,

  quotation_id INT NOT NULL,

  product_name VARCHAR(150) DEFAULT 'Item',
  hsn_code VARCHAR(20) DEFAULT NULL,

  quantity DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  description TEXT DEFAULT NULL,
  category VARCHAR(100) DEFAULT NULL,

  item_type ENUM('goods','service') NOT NULL DEFAULT 'goods',
  unit VARCHAR(30) DEFAULT NULL,

  discount_percent DECIMAL(7,2) NOT NULL DEFAULT 0.00,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  tax_rate DECIMAL(7,2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  FOREIGN KEY (quotation_id)
    REFERENCES quotations(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_quotation_items_quotation
  ON quotation_items(quotation_id);


-- Temporary mapping from the old invoices IDs to the new quotation IDs.
CREATE TEMPORARY TABLE quotation_id_map (
  old_invoice_id INT NOT NULL PRIMARY KEY,
  new_quotation_id INT NOT NULL
);


-- Copy existing quotation headers.
INSERT INTO quotations (
  quotation_number,
  customer_id,
  quotation_date,
  document_status,
  valid_until,

  subtotal,
  total_amount,

  discount_percent,
  discount_amount,

  cgst_rate,
  cgst_amount,
  sgst_rate,
  sgst_amount,
  igst_rate,
  igst_amount,

  tcs_rate,
  tcs_amount,
  tds_rate,
  tds_amount,

  round_off,
  currency,
  payment_terms,
  notes,
  terms_conditions,

  bank_account_id,

  from_name,
  from_business_name,
  from_email,
  from_phone,
  from_gstin,
  from_pan,
  from_website,
  from_address_line1,
  from_address_line2,
  from_city,
  from_state,
  from_pincode,
  from_country,
  from_logo_path,
  from_signature_path,

  to_name,
  to_business_name,
  to_email,
  to_phone,
  to_gstin,
  to_pan,
  to_billing_state,
  to_billing_district,
  to_billing_city,
  to_billing_pincode,
  to_billing_landmark,
  to_shipping_state,
  to_shipping_district,
  to_shipping_city,
  to_shipping_pincode,
  to_shipping_landmark,

  bank_name,
  bank_branch,
  bank_account_holder_name,
  bank_account_number,
  bank_account_type,
  bank_ifsc_code,

  pdf_path,
  created_by,
  created_at
)
SELECT
  invoice_number,
  customer_id,
  invoice_date,
  document_status,
  valid_until,

  subtotal,
  total_amount,

  discount_percent,
  discount_amount,

  cgst_rate,
  cgst_amount,
  sgst_rate,
  sgst_amount,
  igst_rate,
  igst_amount,

  tcs_rate,
  tcs_amount,
  tds_rate,
  tds_amount,

  round_off,
  currency,
  payment_terms,
  notes,
  terms_conditions,

  bank_account_id,

  from_name,
  from_business_name,
  from_email,
  from_phone,
  from_gstin,
  from_pan,
  from_website,
  from_address_line1,
  from_address_line2,
  from_city,
  from_state,
  from_pincode,
  from_country,
  from_logo_path,
  from_signature_path,

  to_name,
  to_business_name,
  to_email,
  to_phone,
  to_gstin,
  to_pan,
  to_billing_state,
  to_billing_district,
  to_billing_city,
  to_billing_pincode,
  to_billing_landmark,
  to_shipping_state,
  to_shipping_district,
  to_shipping_city,
  to_shipping_pincode,
  to_shipping_landmark,

  bank_name,
  bank_branch,
  bank_account_holder_name,
  bank_account_number,
  bank_account_type,
  bank_ifsc_code,

  pdf_path,
  created_by,
  created_at
FROM invoices
WHERE doc_type = 'quotation';


-- Build old-ID → new-ID mapping using the unique quotation number.
INSERT INTO quotation_id_map (
  old_invoice_id,
  new_quotation_id
)
SELECT
  i.id,
  q.id
FROM invoices i
JOIN quotations q
  ON q.quotation_number = i.invoice_number
WHERE i.doc_type = 'quotation';


-- Copy quotation items.
INSERT INTO quotation_items (
  quotation_id,
  product_name,
  hsn_code,
  quantity,
  price,
  amount,
  description,
  category,
  item_type,
  unit,
  discount_percent,
  discount_amount,
  tax_rate,
  tax_amount,
  line_total
)
SELECT
  m.new_quotation_id,
  ii.product_name,
  ii.hsn_code,
  ii.quantity,
  ii.price,
  ii.amount,
  ii.description,
  ii.category,
  ii.item_type,
  ii.unit,
  ii.discount_percent,
  ii.discount_amount,
  ii.tax_rate,
  ii.tax_amount,
  ii.line_total
FROM invoice_items ii
JOIN quotation_id_map m
  ON m.old_invoice_id = ii.invoice_id;


DROP TEMPORARY TABLE quotation_id_map;
