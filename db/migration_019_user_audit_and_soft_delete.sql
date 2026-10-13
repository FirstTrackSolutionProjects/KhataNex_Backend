-- FIRST TRACK KHATANEX — Migration 019: User Audit Logs and Safe Soft Deletion
-- Tracks superadmin administrative actions and soft-delete metadata while preserving referential integrity

-- 1. Soft-delete columns on users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by INT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(255) NULL DEFAULT NULL;

-- 2. Audit log table for superadmin operations
CREATE TABLE IF NOT EXISTS user_audit_logs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  superadmin_id  INT NOT NULL,
  target_user_id INT NOT NULL,
  action         VARCHAR(50) NOT NULL,
  reason         VARCHAR(255) DEFAULT NULL,
  details        JSON DEFAULT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_target (target_user_id),
  KEY idx_audit_superadmin (superadmin_id),
  FOREIGN KEY (superadmin_id) REFERENCES users(id)
) ENGINE=InnoDB;

