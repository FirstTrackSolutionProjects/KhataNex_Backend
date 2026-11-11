-- Fiscal-year invoice sequence used by subscription invoices in the FTS series.
CREATE TABLE IF NOT EXISTS subscription_invoice_series (
  fiscal_year VARCHAR(7) NOT NULL,
  last_number INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (fiscal_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
