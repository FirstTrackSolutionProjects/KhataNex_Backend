const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../middleware/auth");
const { uploadSupportAttachment } = require("../utils/upload");
const {
  createTicket,
  listTickets,
  getTicketDetails,
  claimTicket,
  addTicketMessage,
  updateTicketStatus,
  reassignTicket,
  submitTicketFeedback,
} = require("../controllers/helpCentreController");

// All routes require authentication
router.use(authenticate);

// Ticket creation and listing
router.post("/tickets", uploadSupportAttachment.single("attachment"), createTicket);
router.get("/tickets", listTickets);
router.get("/tickets/:id", getTicketDetails);

// Atomic claim (employees & superadmin)
router.post("/tickets/:id/claim", claimTicket);

// Conversation messages
router.post("/tickets/:id/messages", uploadSupportAttachment.single("attachment"), addTicketMessage);

// Status updates
router.patch("/tickets/:id/status", updateTicketStatus);

// Customer feedback & ratings (1-5 stars)
router.post("/tickets/:id/feedback", submitTicketFeedback);

// Reassign ticket (superadmin only)
router.post("/tickets/:id/reassign", authorize("superadmin"), reassignTicket);

module.exports = router;
