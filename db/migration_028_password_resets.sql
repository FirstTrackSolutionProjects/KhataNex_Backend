-- ============================================================================
-- Migration 028: Password Resets Table & Session Invalidation Columns
--
-- Objective:
--   1) Create `password_resets` table to store cryptographically hashed,
--      single-use, time-expiring reset tokens.
--   2) Add `password_changed_at` and `token_version` columns to `users`
--      to guarantee immediate invalidation of prior sessions across all devices
--      upon password reset.
-- ============================================================================

-- 1. Create password_resets table
CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL DEFAULT NULL,
  ip_address VARCHAR(45) NULL DEFAULT NULL,
  user_agent VARCHAR(255) NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_password_resets_token_hash (token_hash),
  INDEX idx_password_resets_user_id (user_id),
  INDEX idx_password_resets_expires_at (expires_at),
  INDEX idx_password_resets_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Add password_changed_at to users safely
SET @col_pwd_changed = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_changed_at'
);
SET @sql_pwd_changed = IF(@col_pwd_changed = 0,
  "ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL AFTER password",
  "SELECT 1"
);
PREPARE stmt_pwd_changed FROM @sql_pwd_changed;
EXECUTE stmt_pwd_changed;
DEALLOCATE PREPARE stmt_pwd_changed;

-- 3. Add token_version to users safely
SET @col_token_ver = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version'
);
SET @sql_token_ver = IF(@col_token_ver = 0,
  "ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 1 AFTER password_changed_at",
  "SELECT 1"
);
PREPARE stmt_token_ver FROM @sql_token_ver;
EXECUTE stmt_token_ver;
DEALLOCATE PREPARE stmt_token_ver;

