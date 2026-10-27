-- ============================================================================
-- Migration 025: Email Unsubscribes for Promotional Communications
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  reason VARCHAR(255) NULL,
  unsubscribed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_unsubscribes_email (email),
  INDEX idx_unsubscribes_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

