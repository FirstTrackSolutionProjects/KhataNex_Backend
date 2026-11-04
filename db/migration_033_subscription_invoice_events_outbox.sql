-- ============================================================================
-- Migration 033: Subscription Invoice Events Outbox (Transactional SQS Queueing)
-- ============================================================================
-- Establishes a durable transactional outbox for reliable asynchronous subscription
-- invoice generation via AWS SQS FIFO and the Khatanex-Automations microservice.

CREATE TABLE IF NOT EXISTS subscription_invoice_events_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NOT NULL,
  invoice_number VARCHAR(40) NOT NULL,
  event_payload JSON NOT NULL,
  status ENUM('pending', 'publishing', 'published', 'failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice_outbox_order (order_id),
  INDEX idx_invoice_outbox_status (status, created_at),
  FOREIGN KEY (order_id) REFERENCES subscription_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
