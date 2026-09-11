-- FIRST TRACK KHATANEX — Banking
-- Adds bank account details for users.

USE first_track_khatanex;

CREATE TABLE IF NOT EXISTS banking (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  bank_name   VARCHAR(150) DEFAULT NULL,
  branch      VARCHAR(150) DEFAULT NULL,
  ifsc_code   VARCHAR(20) DEFAULT NULL,
  created_by  INT DEFAULT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_banking_creator ON banking(created_by);
