-- ============================================================================
-- Migration 026: Proper Soft Delete Lifecycle, Restoration & Archival Metadata
-- ============================================================================

-- 1. Expand users.status enum to include 'deleted'
ALTER TABLE users MODIFY COLUMN status ENUM('active', 'inactive', 'deleted') NOT NULL DEFAULT 'active';

-- 2. Ensure deleted_at, deleted_by, deletion_reason exist safely
SET @col_deleted_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deleted_at'
);
SET @sql_deleted_at = IF(@col_deleted_at = 0,
  "ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL AFTER has_used_intro_offer",
  "SELECT 1"
);
PREPARE stmt_del_at FROM @sql_deleted_at;
EXECUTE stmt_del_at;
DEALLOCATE PREPARE stmt_del_at;

SET @col_deleted_by = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deleted_by'
);
SET @sql_deleted_by = IF(@col_deleted_by = 0,
  "ALTER TABLE users ADD COLUMN deleted_by INT NULL AFTER deleted_at",
  "SELECT 1"
);
PREPARE stmt_del_by FROM @sql_deleted_by;
EXECUTE stmt_del_by;
DEALLOCATE PREPARE stmt_del_by;

SET @col_del_reason = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deletion_reason'
);
SET @sql_del_reason = IF(@col_del_reason = 0,
  "ALTER TABLE users ADD COLUMN deletion_reason VARCHAR(255) NULL AFTER deleted_by",
  "SELECT 1"
);
PREPARE stmt_del_reason FROM @sql_del_reason;
EXECUTE stmt_del_reason;
DEALLOCATE PREPARE stmt_del_reason;

-- 3. Add restoration metadata (restored_at, restored_by, restoration_reason)
SET @col_restored_at = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'restored_at'
);
SET @sql_restored_at = IF(@col_restored_at = 0,
  "ALTER TABLE users ADD COLUMN restored_at DATETIME NULL AFTER deletion_reason",
  "SELECT 1"
);
PREPARE stmt_res_at FROM @sql_restored_at;
EXECUTE stmt_res_at;
DEALLOCATE PREPARE stmt_res_at;

SET @col_restored_by = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'restored_by'
);
SET @sql_restored_by = IF(@col_restored_by = 0,
  "ALTER TABLE users ADD COLUMN restored_by INT NULL AFTER restored_at",
  "SELECT 1"
);
PREPARE stmt_res_by FROM @sql_restored_by;
EXECUTE stmt_res_by;
DEALLOCATE PREPARE stmt_res_by;

SET @col_res_reason = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'restoration_reason'
);
SET @sql_res_reason = IF(@col_res_reason = 0,
  "ALTER TABLE users ADD COLUMN restoration_reason VARCHAR(255) NULL AFTER restored_by",
  "SELECT 1"
);
PREPARE stmt_res_reason FROM @sql_res_reason;
EXECUTE stmt_res_reason;
DEALLOCATE PREPARE stmt_res_reason;

-- 4. Add indexing on deleted_at and status for fast active/deleted filtering
SET @idx_del_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_deleted_at'
);
SET @sql_idx_del = IF(@idx_del_exists = 0,
  "ALTER TABLE users ADD INDEX idx_users_deleted_at (deleted_at)",
  "SELECT 1"
);
PREPARE stmt_idx_del FROM @sql_idx_del;
EXECUTE stmt_idx_del;
DEALLOCATE PREPARE stmt_idx_del;

SET @idx_status_del_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_status_deleted'
);
SET @sql_idx_status_del = IF(@idx_status_del_exists = 0,
  "ALTER TABLE users ADD INDEX idx_users_status_deleted (status, deleted_at)",
  "SELECT 1"
);
PREPARE stmt_idx_status_del FROM @sql_idx_status_del;
EXECUTE stmt_idx_status_del;
DEALLOCATE PREPARE stmt_idx_status_del;

