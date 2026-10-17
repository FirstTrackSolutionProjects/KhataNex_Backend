-- FIRST TRACK KHATANEX — Migration 023: Support Ticket Customer Feedback & Ratings
-- Creates support_ticket_feedback table to record post-resolution star ratings (1-5) and feedback

CREATE TABLE IF NOT EXISTS support_ticket_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,
  user_id INT NOT NULL,
  employee_id INT NULL DEFAULT NULL,
  rating TINYINT NOT NULL,
  comment TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticket_feedback (ticket_id),
  KEY idx_feedback_employee (employee_id),
  KEY idx_feedback_user (user_id),
  CONSTRAINT fk_feedback_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_employee FOREIGN KEY (employee_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
