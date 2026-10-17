-- FIRST TRACK KHATANEX — Migration 022: Plan Management, Employees Module & Granular Permissions, and Help Centre
-- 1. Adds configurable fields to subscription_plans (billing_interval, features, promotional_badge, display_order, is_highlighted)
-- 2. Adds employee metadata and assigned_modules to users
-- 3. Creates support_tickets table (strictly NO priority column; atomic claiming workflow)
-- 4. Creates support_ticket_messages table
-- 5. Creates admin_audit_logs table for administrative auditing

-- 1. Add configurable plan management columns to subscription_plans
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(50) NOT NULL DEFAULT 'monthly' AFTER duration_months,
  ADD COLUMN IF NOT EXISTS features JSON NULL DEFAULT NULL AFTER description,
  ADD COLUMN IF NOT EXISTS promotional_badge VARCHAR(100) NULL DEFAULT NULL AFTER summary,
  ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0 AFTER introductory_price_paise,
  ADD COLUMN IF NOT EXISTS is_highlighted TINYINT(1) NOT NULL DEFAULT 0 AFTER display_order;

-- Seed default values for existing plans
UPDATE subscription_plans
SET billing_interval = 'monthly',
    display_order = 1,
    is_highlighted = 0,
    promotional_badge = 'Starter',
    features = JSON_ARRAY(
      'Unlimited Invoices & Quotations',
      'Customer Khata & Digital Ledgers',
      'Payment Records & PDF Waybills',
      'Standard Email & In-App Support',
      '1 User Access'
    )
WHERE code = 'monthly';

UPDATE subscription_plans
SET billing_interval = 'half_yearly',
    display_order = 2,
    is_highlighted = 0,
    promotional_badge = 'Save 46%',
    features = JSON_ARRAY(
      'Everything in Monthly Plan',
      'Complete Inventory & Stock Management',
      'Purchase Bills & Supplier Tracking',
      'Multi-Device Sync',
      'Priority Ticket Support'
    )
WHERE code = 'six_months';

UPDATE subscription_plans
SET billing_interval = 'yearly',
    display_order = 3,
    is_highlighted = 1,
    promotional_badge = 'Best Value · 13 Months',
    features = JSON_ARRAY(
      'Everything in 6 Months Plan',
      '1 Extra Month Free (13 Months Total)',
      'Custom Business Watermark & Branding',
      'Dedicated Help Centre Support',
      'Early Access to All New Features',
      'Maximum Savings Guaranteed'
    )
WHERE code = 'yearly';

-- 2. Add employee profile and permission fields to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_code VARCHAR(50) NULL DEFAULT NULL AFTER employee_title,
  ADD COLUMN IF NOT EXISTS joining_date DATE NULL DEFAULT NULL AFTER employee_code,
  ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(100) NULL DEFAULT NULL AFTER secondary_phone,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL DEFAULT NULL AFTER emergency_contact,
  ADD COLUMN IF NOT EXISTS assigned_modules JSON NULL DEFAULT NULL AFTER permissions;

-- 3. Create support_tickets table (STRICTLY NO PRIORITY SYSTEM)
CREATE TABLE IF NOT EXISTS support_tickets (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  ticket_number         VARCHAR(40) NOT NULL UNIQUE,
  user_id               INT NOT NULL,
  department            VARCHAR(50) NOT NULL,
  category              VARCHAR(50) NOT NULL,
  subcategory           VARCHAR(100) NULL DEFAULT NULL,
  subject               VARCHAR(255) NOT NULL,
  description           TEXT NOT NULL,
  status                ENUM('open', 'assigned', 'in_progress', 'waiting_for_user', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  assigned_employee_id  INT NULL DEFAULT NULL,
  claimed_at            DATETIME NULL DEFAULT NULL,
  resolved_at           DATETIME NULL DEFAULT NULL,
  closed_at             DATETIME NULL DEFAULT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ticket_user (user_id),
  KEY idx_ticket_dept_status (department, status),
  KEY idx_ticket_assigned (assigned_employee_id),
  KEY idx_ticket_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_employee_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 4. Create support_ticket_messages table
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id     INT NOT NULL,
  sender_id     INT NOT NULL,
  sender_role   ENUM('user', 'employee', 'superadmin') NOT NULL,
  message       TEXT NOT NULL,
  attachments   JSON NULL DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msg_ticket (ticket_id),
  KEY idx_msg_created (created_at),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Create admin_audit_logs table
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  actor_id      INT NOT NULL,
  actor_role    VARCHAR(50) NOT NULL,
  action        VARCHAR(100) NOT NULL,
  target_type   VARCHAR(50) NOT NULL,
  target_id     VARCHAR(100) NULL DEFAULT NULL,
  before_value  JSON NULL DEFAULT NULL,
  after_value   JSON NULL DEFAULT NULL,
  details       JSON NULL DEFAULT NULL,
  ip_address    VARCHAR(45) NULL DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_actor (actor_id),
  KEY idx_audit_action (action),
  KEY idx_audit_target (target_type, target_id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB;
