-- FIRST TRACK KHATANEX — Migration 012
-- MySQL-compatible completion of Migration 011.
-- Migration 011 failed before applying its inventory/purchase-bill changes.

ALTER TABLE stock
  ADD COLUMN unit VARCHAR(30) DEFAULT NULL AFTER hsn_code;

ALTER TABLE stock
  ADD COLUMN gst_rate DECIMAL(5,2) DEFAULT 0 AFTER unit;

ALTER TABLE stock
  ADD COLUMN price_inclusive_gst TINYINT(1) NOT NULL DEFAULT 0 AFTER gst_rate;

ALTER TABLE stock
  ADD COLUMN description TEXT DEFAULT NULL AFTER price_inclusive_gst;

ALTER TABLE stock
  ADD COLUMN expense_type VARCHAR(50) DEFAULT NULL AFTER description;

CREATE TABLE IF NOT EXISTS purchase_bills (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  bill_number   VARCHAR(100) DEFAULT NULL,
  vendor_name   VARCHAR(150) DEFAULT NULL,
  bill_date     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gst_rate      DECIMAL(5,2) DEFAULT 0,
  created_by    INT DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_bill_items (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  purchase_bill_id  INT NOT NULL,
  product_id        INT DEFAULT NULL,
  item_name         VARCHAR(150) DEFAULT NULL,
  quantity          DECIMAL(10,2) NOT NULL DEFAULT 0,
  price             DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  unit              VARCHAR(30) DEFAULT NULL,
  item_type         VARCHAR(20) DEFAULT 'goods',
  gst_rate          DECIMAL(5,2) DEFAULT 0,
  hsn_code          VARCHAR(20) DEFAULT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (purchase_bill_id) REFERENCES purchase_bills(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES stock(id) ON DELETE SET NULL
) ENGINE=InnoDB;
