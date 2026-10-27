-- ============================================================================
-- Migration 027: Allow Email Reuse After Soft Deletion
--
-- Objective:
--   Allow users whose accounts were soft-deleted to re-register with the exact
--   same email address as a genuinely NEW user (new ID, clean slate, full data isolation).
--   Ensure at the database engine level that:
--     1) Multiple soft-deleted user records can exist with the same email.
--     2) At most ONE active/non-deleted user can exist with any given email.
--     3) Concurrent registrations for the same email are blocked with ER_DUP_ENTRY.
-- ============================================================================

-- 1. Drop existing global unique index on email if present
SET @drop_uniq_email = (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'email'
    ),
    'ALTER TABLE users DROP INDEX email',
    'SELECT 1'
  )
);
PREPARE stmt_drop_email FROM @drop_uniq_email;
EXECUTE stmt_drop_email;
DEALLOCATE PREPARE stmt_drop_email;

-- 2. Add non-unique index on email for O(log N) lookup performance
SET @add_idx_email = (
  SELECT IF(
    NOT EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_email'
    ),
    'ALTER TABLE users ADD INDEX idx_users_email (email)',
    'SELECT 1'
  )
);
PREPARE stmt_add_idx FROM @add_idx_email;
EXECUTE stmt_add_idx;
DEALLOCATE PREPARE stmt_add_idx;

-- 3. Add stored generated column active_email
-- active_email is NULL when status = 'deleted' OR deleted_at IS NOT NULL.
-- active_email is equal to email when user is active or inactive (not soft-deleted).
SET @col_active_email = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'active_email'
);
SET @sql_active_email = IF(@col_active_email = 0,
  "ALTER TABLE users ADD COLUMN active_email VARCHAR(150) GENERATED ALWAYS AS (IF(status = 'deleted' OR deleted_at IS NOT NULL, NULL, email)) STORED AFTER email",
  "SELECT 1"
);
PREPARE stmt_active_col FROM @sql_active_email;
EXECUTE stmt_active_col;
DEALLOCATE PREPARE stmt_active_col;

-- 4. Add unique index on active_email
-- In MySQL InnoDB, UNIQUE indexes allow multiple NULL values.
-- Therefore, multiple soft-deleted records (active_email = NULL) can coexist,
-- but at most ONE non-deleted user can possess any email address at any time.
SET @add_uq_active = (
  SELECT IF(
    NOT EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_active_email'
    ),
    'ALTER TABLE users ADD UNIQUE KEY uq_users_active_email (active_email)',
    'SELECT 1'
  )
);
PREPARE stmt_add_uq FROM @add_uq_active;
EXECUTE stmt_add_uq;
DEALLOCATE PREPARE stmt_add_uq;

