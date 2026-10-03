-- FIRST TRACK KHATANEX — Migration 010
-- Owner Console: employee profiles, permissions and account activity

USE first_track_khatanex;

ALTER TABLE users
  ADD COLUMN employee_title VARCHAR(100) DEFAULT NULL AFTER employee_role_type,
  ADD COLUMN secondary_phone VARCHAR(20) DEFAULT NULL AFTER phone,
  ADD COLUMN date_of_birth DATE DEFAULT NULL AFTER secondary_phone,
  ADD COLUMN employee_age INT DEFAULT NULL AFTER date_of_birth,
  ADD COLUMN aadhaar_number VARCHAR(20) DEFAULT NULL AFTER pan,
  ADD COLUMN passport_number VARCHAR(30) DEFAULT NULL AFTER aadhaar_number,
  ADD COLUMN profile_photo_path VARCHAR(255) DEFAULT NULL AFTER passport_number,
  ADD COLUMN permissions JSON DEFAULT NULL AFTER employee_role_type,
  ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL AFTER status,
  ADD COLUMN last_active_at TIMESTAMP NULL DEFAULT NULL AFTER last_login_at;

CREATE INDEX idx_users_role_status
  ON users(role, status);

CREATE INDEX idx_users_created_by_admin
  ON users(created_by_admin);

CREATE INDEX idx_users_last_active
  ON users(last_active_at);
