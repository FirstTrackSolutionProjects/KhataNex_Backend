-- FIRST TRACK KHATANEX — Migration 013
-- Link stock (Product Master) to purchase_bills

ALTER TABLE stock
  ADD COLUMN purchase_bill_id INT DEFAULT NULL AFTER expense_type;

ALTER TABLE stock
  ADD CONSTRAINT fk_stock_purchase_bills
  FOREIGN KEY (purchase_bill_id) REFERENCES purchase_bills(id) ON DELETE SET NULL;
