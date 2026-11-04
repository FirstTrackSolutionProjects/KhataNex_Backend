-- ============================================================================
-- Migration 029: Two-Factor Authentication (2FA) and Recovery Codes
--
-- Objective:
--   1) Add two-factor authentication columns to `users`:
--      - `two_factor_enabled`: Boolean flag indicating if 2FA is active
--      - `two_factor_secret`: AES-256-GCM encrypted TOTP secret
--      - `two_factor_temp_secret`: AES-256-GCM encrypted secret during setup
--      - `two_factor_temp_created_at`: Expiration tracker for pending setups
--      - `two_factor_enabled_at`: Timestamp when 2FA was activated
--   2) Create `user_recovery_codes` table to store cryptographically hashed,
--      single-use backup recovery codes.
-- ============================================================================

-- 1. Add two_factor_enabled to users
SET @col_2fa_enabled = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'two_factor_enabled'
);
SET @sql_2fa_enabled = IF(@col_2fa_enabled = 0,
  "ALTER TABLE users ADD COLUMN two_factor_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER token_version",
  "SELECT 1"
);
PREPARE stmt_2fa_enabled FROM @sql_2fa_enabled;
EXECUTE stmt_2fa_enabled;
DEALLOCATE PREPARE stmt_2fa_enabled;

-- 2. Add two_factor_secret to users
SET @col_2fa_secret = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'two_factor_secret'
);
SET @sql_2fa_secret = IF(@col_2fa_secret = 0,
  "ALTER TABLE users ADD COLUMN two_factor_secret TEXT NULL DEFAULT NULL AFTER two_factor_enabled",
  "SELECT 1"
);
PREPARE stmt_2fa_secret FROM @sql_2fa_secret;
EXECUTE stmt_2fa_secret;
DEALLOCATE PREPARE stmt_2fa_secret;

-- 3. Add two_factor_temp_secret to users
SET @col_2fa_temp = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'two_factor_temp_secret'
);
SET @sql_2fa_temp = IF(@col_2fa_temp = 0,
  "ALTER TABLE users ADD COLUMN two_factor_temp_secret TEXT NULL DEFAULT NULL AFTER two_factor_secret",
  "SELECT 1"
);
PREPARE stmt_2fa_temp FROM @sql_2fa_temp;
EXECUTE stmt_2fa_temp;
DEALLOCATE PREPARE stmt_2fa_temp;

-- 4. Add two_factor_temp_created_at to users
SET @col_2fa_temp_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'two_factor_temp_created_at'
);
SET @sql_2fa_temp_at = IF(@col_2fa_temp_at = 0,
  "ALTER TABLE users ADD COLUMN two_factor_temp_created_at DATETIME NULL DEFAULT NULL AFTER two_factor_temp_secret",
  "SELECT 1"
);
PREPARE stmt_2fa_temp_at FROM @sql_2fa_temp_at;
EXECUTE stmt_2fa_temp_at;
DEALLOCATE PREPARE stmt_2fa_temp_at;

-- 5. Add two_factor_enabled_at to users
SET @col_2fa_enabled_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'two_factor_enabled_at'
);
SET @sql_2fa_enabled_at = IF(@col_2fa_enabled_at = 0,
  "ALTER TABLE users ADD COLUMN two_factor_enabled_at DATETIME NULL DEFAULT NULL AFTER two_factor_temp_created_at",
  "SELECT 1"
);
PREPARE stmt_2fa_enabled_at FROM @sql_2fa_enabled_at;
EXECUTE stmt_2fa_enabled_at;
DEALLOCATE PREPARE stmt_2fa_enabled_at;

-- 6. Create user_recovery_codes table
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  consumed_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_recovery_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_recovery_codes_user_id (user_id),
  INDEX idx_user_recovery_codes_hash (code_hash),
  INDEX idx_user_recovery_codes_consumed (user_id, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

