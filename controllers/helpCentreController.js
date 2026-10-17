const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");
const { hasPermission } = require("../utils/tenantContext");

/**
 * Maps categories to appropriate support department
 */
const inferDepartment = (category) => {
  const c = String(category || "").toLowerCase();
  if (c.includes("subscrip") || c.includes("bill") || c.includes("pay") || c.includes("refund") || c.includes("invoice")) {
    return "billing";
  }
  if (c.includes("bug") || c.includes("tech") || c.includes("error") || c.includes("crash") || c.includes("sync")) {
    return "technical";
  }
  if (c.includes("khata") || c.includes("ledger") || c.includes("account") || c.includes("bank") || c.includes("stock")) {
    return "account";
  }
  return "general";
};

/**
 * Generate a unique, readable ticket number: e.g. TKT-20261016-7842
 */
const generateTicketNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `TKT-${dateStr}-${rand}`;
};

/**
 * POST /api/help-centre/tickets
 * Create a new support ticket (STRICTLY NO PRIORITY FIELD)
 */
const createTicket = asyncHandler(async (req, res) => {
  const { category, subcategory, subject, description, department } = req.body;

  if (!category || !subject || !description) {
    throw new ApiError(400, "Category, subject, and description are required.");
  }

  const dept = department || inferDepartment(category);
  const ticketNumber = generateTicketNumber();

  let attachments = null;
  if (req.file) {
    attachments = JSON.stringify([{
      name: req.file.originalname,
      url: relativeUploadPath(req.file.path),
      size: req.file.size,
    }]);
  } else if (req.body.attachments) {
    attachments = typeof req.body.attachments === "string" ? req.body.attachments : JSON.stringify(req.body.attachments);
  }

  const [result] = await pool.query(
    `INSERT INTO support_tickets
       (ticket_number, user_id, department, category, subcategory, subject, description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    [
      ticketNumber,
      req.user.id,
      dept,
      category,
      subcategory || null,
      subject.trim(),
      description.trim(),
    ]
  );

  const ticketId = result.insertId;

  // Record initial conversation message
  await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_id, sender_role, message, attachments)
     VALUES (?, ?, ?, ?, ?)`,
    [
      ticketId,
      req.user.id,
      req.user.role,
      description.trim(),
      attachments,
    ]
  );

  const [created] = await pool.query("SELECT * FROM support_tickets WHERE id = ?", [ticketId]);

  res.status(201).json({
    success: true,
    message: "Support ticket created successfully.",
    ticket: created[0],
  });
});

/**
 * GET /api/help-centre/tickets
 * Lists tickets based on requester role and filters
 */
const listTickets = asyncHandler(async (req, res) => {
  if (req.user.role === "employee" && !hasPermission(req.user, "help_centre", "view")) {
    throw new ApiError(403, "You do not have permission to view support tickets.");
  }

  const { status, department, view, search } = req.query;

  let query = `
    SELECT t.*,
           u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.business_name,
           emp.name AS assigned_employee_name, emp.email AS assigned_employee_email
    FROM support_tickets t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN users emp ON t.assigned_employee_id = emp.id
    WHERE 1=1
  `;
  const params = [];

  if (req.user.role === "user") {
    // Standard users only see their own tickets
    query += " AND t.user_id = ?";
    params.push(req.user.id);
  } else if (req.user.role === "employee") {
    // Employees see tickets based on tab/view
    if (view === "available") {
      query += " AND t.status = 'open' AND t.assigned_employee_id IS NULL";
    } else if (view === "assigned") {
      query += " AND t.assigned_employee_id = ?";
      params.push(req.user.id);
    } else {
      // Default: show either tickets assigned to this employee OR unassigned open tickets
      query += " AND (t.assigned_employee_id = ? OR (t.status = 'open' AND t.assigned_employee_id IS NULL))";
      params.push(req.user.id);
    }
  }

  // Superadmin or employee filters
  if (status && status !== "all") {
    query += " AND t.status = ?";
    params.push(status);
  }

  if (department && department !== "all") {
    query += " AND t.department = ?";
    params.push(department);
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    query += " AND (t.ticket_number LIKE ? OR t.subject LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.business_name LIKE ?)";
    params.push(s, s, s, s, s);
  }

  query += " ORDER BY t.created_at DESC";

  const [tickets] = await pool.query(query, params);

  res.json({
    success: true,
    count: tickets.length,
    tickets,
  });
});

/**
 * GET /api/help-centre/tickets/:id
 * Retrieve single ticket details with complete message thread
 */
const getTicketDetails = asyncHandler(async (req, res) => {
  if (req.user.role === "employee" && !hasPermission(req.user, "help_centre", "view")) {
    throw new ApiError(403, "You do not have permission to view support tickets.");
  }
  const ticketId = Number(req.params.id);

  const [tickets] = await pool.query(
    `SELECT t.*,
            u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.business_name,
            emp.name AS assigned_employee_name, emp.email AS assigned_employee_email
     FROM support_tickets t
     JOIN users u ON t.user_id = u.id
     LEFT JOIN users emp ON t.assigned_employee_id = emp.id
     WHERE t.id = ?`,
    [ticketId]
  );

  if (!tickets.length) throw new ApiError(404, "Ticket not found.");
  const ticket = tickets[0];

  // Access validation: regular user can only view their own ticket
  if (req.user.role === "user" && ticket.user_id !== req.user.id) {
    throw new ApiError(403, "You do not have permission to view this ticket.");
  }

  // Customer privacy: Mask employee personal name for regular users
  if (req.user.role === "user") {
    if (ticket.assigned_employee_id) {
      ticket.assigned_employee_name = "KhataNex Support Team";
      ticket.assigned_employee_email = "support@khatanex.com";
    }
  }

  const [messages] = await pool.query(
    `SELECT m.*, u.name AS sender_name, u.email AS sender_email, u.role AS sender_user_role
     FROM support_ticket_messages m
     JOIN users u ON m.sender_id = u.id
     WHERE m.ticket_id = ?
     ORDER BY m.created_at ASC`,
    [ticketId]
  );

  const formattedMessages = messages.map((m) => {
    let atts = null;
    if (m.attachments) {
      if (typeof m.attachments === "string") {
        try { atts = JSON.parse(m.attachments); } catch (_) { atts = m.attachments; }
      } else {
        atts = m.attachments;
      }
    }

    let displayName = m.sender_name;
    // Mask employee name from customers
    if (req.user.role === "user" && (m.sender_user_role === "employee" || m.sender_user_role === "superadmin")) {
      displayName = "KhataNex Support Team";
    }

    return {
      ...m,
      sender_name: displayName,
      attachments: atts,
    };
  });

  // Fetch feedback if any
  const [feedbackRows] = await pool.query(
    "SELECT id, rating, comment, created_at FROM support_ticket_feedback WHERE ticket_id = ?",
    [ticketId]
  );

  res.json({
    success: true,
    ticket,
    messages: formattedMessages,
    feedback: feedbackRows[0] || null,
  });
});

/**
 * POST /api/help-centre/tickets/:id/claim
 * Concurrency-safe atomic ticket claim
 */
const claimTicket = asyncHandler(async (req, res) => {
  const ticketId = Number(req.params.id);

  if (req.user.role !== "employee" && req.user.role !== "superadmin") {
    throw new ApiError(403, "Only support staff can claim tickets.");
  }
  if (req.user.role === "employee" && !hasPermission(req.user, "help_centre", "claim")) {
    throw new ApiError(403, "You do not have permission to claim support tickets.");
  }

  // Atomic SQL update preventing race conditions
  const [updateResult] = await pool.query(
    `UPDATE support_tickets
     SET assigned_employee_id = ?, status = 'assigned', claimed_at = NOW(), updated_at = NOW()
     WHERE id = ? AND status = 'open' AND assigned_employee_id IS NULL`,
    [req.user.id, ticketId]
  );

  if (updateResult.affectedRows === 0) {
    // Ticket already claimed or status changed
    const [current] = await pool.query(
      "SELECT id, status, assigned_employee_id FROM support_tickets WHERE id = ?",
      [ticketId]
    );
    if (!current.length) throw new ApiError(404, "Ticket not found.");
    throw new ApiError(
      409,
      "This issue has already been claimed by another team member or is no longer available in the open queue."
    );
  }

  // Add system record to message thread
  await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_id, sender_role, message)
     VALUES (?, ?, ?, ?)`,
    [
      ticketId,
      req.user.id,
      req.user.role,
      "Our support team has claimed this ticket and is assisting you.",
    ]
  );

  // Audit log
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, details, ip_address)
       VALUES (?, ?, 'CLAIM_TICKET', 'support_ticket', ?, ?, ?)`,
      [
        req.user.id,
        req.user.role,
        String(ticketId),
        JSON.stringify({ ticket_id: ticketId, claimant_name: req.user.name }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  const [claimed] = await pool.query("SELECT * FROM support_tickets WHERE id = ?", [ticketId]);

  res.json({
    success: true,
    message: "Ticket claimed successfully.",
    ticket: claimed[0],
  });
});

/**
 * POST /api/help-centre/tickets/:id/messages
 * Post a reply in the ticket thread
 */
const addTicketMessage = asyncHandler(async (req, res) => {
  const ticketId = Number(req.params.id);
  const { message } = req.body;

  if (!message || !message.trim()) {
    throw new ApiError(400, "Message content is required.");
  }

  const [tickets] = await pool.query("SELECT * FROM support_tickets WHERE id = ?", [ticketId]);
  if (!tickets.length) throw new ApiError(404, "Ticket not found.");
  const ticket = tickets[0];

  // Access validation
  if (req.user.role === "user" && ticket.user_id !== req.user.id) {
    throw new ApiError(403, "You do not have access to this ticket.");
  }

  // Staff validation: Employee must be assigned to this ticket to reply
  if (req.user.role === "employee") {
    if (!hasPermission(req.user, "help_centre", "reply")) {
      throw new ApiError(403, "You do not have permission to reply to support tickets.");
    }
    if (!ticket.assigned_employee_id) {
      throw new ApiError(403, "You must claim this ticket before sending replies.");
    }
    if (ticket.assigned_employee_id !== req.user.id) {
      throw new ApiError(403, "You cannot reply to this ticket because it is assigned to another team member.");
    }
    if (ticket.status === "closed") {
      throw new ApiError(400, "This ticket is closed. No new messages can be added.");
    }
  }

  let attachments = null;
  if (req.file) {
    attachments = JSON.stringify([{
      name: req.file.originalname,
      url: relativeUploadPath(req.file.path),
      size: req.file.size,
    }]);
  } else if (req.body.attachments) {
    attachments = typeof req.body.attachments === "string" ? req.body.attachments : JSON.stringify(req.body.attachments);
  }

  const [resMsg] = await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_id, sender_role, message, attachments)
     VALUES (?, ?, ?, ?, ?)`,
    [
      ticketId,
      req.user.id,
      req.user.role,
      message.trim(),
      attachments,
    ]
  );

  // Automatically adjust ticket status based on response
  let nextStatus = ticket.status;
  if (req.user.role === "user") {
    if (ticket.status === "waiting_for_user" || ticket.status === "resolved") {
      nextStatus = "in_progress";
    }
  } else if (req.user.role === "employee" || req.user.role === "superadmin") {
    if (ticket.status === "assigned" || ticket.status === "open") {
      nextStatus = "in_progress";
    }
  }

  await pool.query(
    "UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?",
    [nextStatus, ticketId]
  );

  const [newMsg] = await pool.query(
    `SELECT m.*, u.name AS sender_name, u.email AS sender_email, u.role AS sender_user_role
     FROM support_ticket_messages m
     JOIN users u ON m.sender_id = u.id
     WHERE m.id = ?`,
    [resMsg.insertId]
  );

  res.status(201).json({
    success: true,
    message: newMsg[0],
    ticket_status: nextStatus,
  });
});

/**
 * PATCH /api/help-centre/tickets/:id/status
 * Update ticket lifecycle status
 */
const updateTicketStatus = asyncHandler(async (req, res) => {
  const ticketId = Number(req.params.id);
  const { status } = req.body;

  const validStatuses = ["open", "assigned", "in_progress", "waiting_for_user", "resolved", "closed"];
  if (!validStatuses.includes(status)) {
    throw new ApiError(400, `Invalid status. Valid values: ${validStatuses.join(", ")}`);
  }

  const [tickets] = await pool.query("SELECT * FROM support_tickets WHERE id = ?", [ticketId]);
  if (!tickets.length) throw new ApiError(404, "Ticket not found.");
  const ticket = tickets[0];

  // User authorization: can only resolve or close their own ticket
  if (req.user.role === "user") {
    if (ticket.user_id !== req.user.id) throw new ApiError(403, "Access denied.");
    if (status !== "closed" && status !== "resolved") {
      throw new ApiError(403, "Customers cannot modify staff-only ticket fields or lifecycle statuses.");
    }
  }

  // Employee authorization:
  if (req.user.role === "employee") {
    if (!hasPermission(req.user, "help_centre", "resolve")) {
      throw new ApiError(403, "You do not have permission to update ticket status.");
    }
    // 1. Unclaimed tickets cannot be updated by any employee
    if (!ticket.assigned_employee_id) {
      throw new ApiError(403, "Unclaimed tickets cannot be updated. You must claim this ticket first.");
    }

    // 2. Employee must be assigned to this ticket
    if (ticket.assigned_employee_id !== req.user.id) {
      throw new ApiError(403, "You cannot update this ticket because it is assigned to another team member.");
    }

    // 3. Closed tickets cannot be reopened by employees (only Superadmin)
    if (ticket.status === "closed" && status !== "closed") {
      throw new ApiError(403, "Only Superadmin can modify or reopen a closed ticket.");
    }
  }

  let resolvedAtSql = "";
  let closedAtSql = "";
  if (status === "resolved") resolvedAtSql = ", resolved_at = NOW()";
  if (status === "closed") closedAtSql = ", closed_at = NOW()";

  await pool.query(
    `UPDATE support_tickets
     SET status = ?, updated_at = NOW() ${resolvedAtSql} ${closedAtSql}
     WHERE id = ?`,
    [status, ticketId]
  );

  // Add system message
  await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_id, sender_role, message)
     VALUES (?, ?, ?, ?)`,
    [
      ticketId,
      req.user.id,
      req.user.role,
      `Status updated to "${status.replace(/_/g, " ")}".`,
    ]
  );

  // Audit log
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, details, ip_address)
       VALUES (?, ?, 'UPDATE_TICKET_STATUS', 'support_ticket', ?, ?, ?)`,
      [
        req.user.id,
        req.user.role,
        String(ticketId),
        JSON.stringify({ previous_status: ticket.status, new_status: status }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  res.json({
    success: true,
    message: `Ticket status updated to ${status}.`,
    status,
  });
});

/**
 * POST /api/help-centre/tickets/:id/reassign
 * Reassign ticket to another employee or unassign (Superadmin only)
 */
const reassignTicket = asyncHandler(async (req, res) => {
  const ticketId = Number(req.params.id);
  const { employee_id } = req.body;

  let assignedId = null;
  let newStatus = "open";

  if (employee_id) {
    const [emp] = await pool.query("SELECT id, name FROM users WHERE id = ? AND role = 'employee'", [employee_id]);
    if (!emp.length) throw new ApiError(404, "Employee not found.");
    assignedId = emp[0].id;
    newStatus = "assigned";
  }

  await pool.query(
    `UPDATE support_tickets
     SET assigned_employee_id = ?, status = ?, updated_at = NOW()
     WHERE id = ?`,
    [assignedId, newStatus, ticketId]
  );

  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_role, action, target_type, target_id, details, ip_address)
       VALUES (?, ?, 'REASSIGN_TICKET', 'support_ticket', ?, ?, ?)`,
      [
        req.user.id,
        req.user.role,
        String(ticketId),
        JSON.stringify({ ticket_id: ticketId, new_assigned_employee_id: assignedId }),
        req.ip || null,
      ]
    );
  } catch (_) {}

  res.json({
    success: true,
    message: assignedId ? "Ticket reassigned successfully." : "Ticket returned to open queue.",
  });
});

/**
 * POST /api/help-centre/tickets/:id/feedback
 * Submit customer feedback (1-5 stars + optional comment)
 */
const submitTicketFeedback = asyncHandler(async (req, res) => {
  const ticketId = Number(req.params.id);
  const { rating, comment } = req.body;

  const numRating = Number(rating);
  if (!numRating || numRating < 1 || numRating > 5 || !Number.isInteger(numRating)) {
    throw new ApiError(400, "A valid rating between 1 and 5 is required.");
  }

  const [tickets] = await pool.query("SELECT * FROM support_tickets WHERE id = ?", [ticketId]);
  if (!tickets.length) throw new ApiError(404, "Ticket not found.");
  const ticket = tickets[0];

  if (req.user.role === "user" && ticket.user_id !== req.user.id) {
    throw new ApiError(403, "You can only submit feedback for your own tickets.");
  }

  // Enforce duplicate-rating rule
  const [existing] = await pool.query(
    "SELECT id FROM support_ticket_feedback WHERE ticket_id = ?",
    [ticketId]
  );
  if (existing.length > 0) {
    throw new ApiError(409, "Feedback has already been submitted for this ticket.");
  }

  const [result] = await pool.query(
    `INSERT INTO support_ticket_feedback (ticket_id, user_id, employee_id, rating, comment)
     VALUES (?, ?, ?, ?, ?)`,
    [
      ticketId,
      req.user.id,
      ticket.assigned_employee_id || null,
      numRating,
      comment ? String(comment).trim() : null,
    ]
  );
  const feedbackId = result.insertId;

  const [saved] = await pool.query(
    "SELECT * FROM support_ticket_feedback WHERE id = ?",
    [feedbackId]
  );

  res.status(200).json({
    success: true,
    message: "Thank you for rating our support team!",
    feedback: saved[0],
  });
});

module.exports = {
  createTicket,
  listTickets,
  getTicketDetails,
  claimTicket,
  addTicketMessage,
  updateTicketStatus,
  reassignTicket,
  submitTicketFeedback,
};
