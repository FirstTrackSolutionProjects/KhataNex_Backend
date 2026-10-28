#!/usr/bin/env node
/**
 * KhataNex Email Diagnostic & Verification Suite
 *
 * Verifies:
 * 1. Zoho Mail SMTP configuration (host, port, SSL/TLS, auth) for info@khatanex.in
 * 2. Welcome email template rendering and delivery
 * 3. Subscription invoice confirmation with PDF attachment delivery
 * 4. Idempotency and deduplication safeguards
 * 5. Outbox queue persistence and delivery state tracking
 *
 * Usage:
 *   node scripts/test_email_diagnostic.js [--to=your_email@domain.com]
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const pool = require("../config/db");
const mailer = require("../utils/mailer");
const emailService = require("../services/emailService");

// Parse CLI flags
const args = process.argv.slice(2);
let targetEmail = "info@khatanex.in";

for (const arg of args) {
  if (arg.startsWith("--to=")) {
    targetEmail = arg.split("=")[1].trim();
  }
}

const mask = (email) => {
  if (!email || !email.includes("@")) return "unknown";
  return email.replace(/(.{2})(.*)(?=@)/, (_, a, b) => a + "*".repeat(b.length));
};

async function runDiagnostic() {
  console.log("====================================================================");
  console.log("🧪 KHATANEX EMAIL DIAGNOSTIC & VERIFICATION SUITE");
  console.log("====================================================================");
  console.log(`Target Test Recipient : ${mask(targetEmail)} (${targetEmail})`);
  console.log(`Configured Sender     : ${process.env.SMTP_FROM || "KhataNex <info@khatanex.in>"}`);
  console.log(`SMTP Host             : ${process.env.SMTP_HOST || "unconfigured"}`);
  console.log(`SMTP Port             : ${process.env.SMTP_PORT || "465"}`);
  console.log(`SMTP User             : ${process.env.SMTP_USER || "unconfigured"}`);
  console.log(`SMTP Password Loaded  : ${Boolean(process.env.SMTP_PASS) ? "YES (secret preserved)" : "NO"}`);
  console.log("====================================================================\n");

  let passes = 0;
  let fails = 0;

  // -------------------------------------------------------------------------
  // Test 1: SMTP Transporter Verification
  // -------------------------------------------------------------------------
  console.log("▶ [Test 1/5] Verifying Zoho SMTP Connection & Credentials...");
  try {
    const connRes = await mailer.verifyConnection();
    if (connRes.ok) {
      console.log("  ✅ SUCCESS: Connected to Zoho Mail SMTP server and authenticated successfully.");
      passes++;
    } else {
      console.error(`  ❌ FAILED: SMTP connection failed: ${connRes.error}`);
      fails++;
    }
  } catch (err) {
    console.error(`  ❌ FAILED: Unexpected SMTP error: ${err.message}`);
    fails++;
  }

  // -------------------------------------------------------------------------
  // Test 2: Welcome Email Workflow
  // -------------------------------------------------------------------------
  console.log("\n▶ [Test 2/5] Testing Registration Welcome Email Workflow...");
  let welcomeOutboxId = null;
  try {
    const testUserId = "diag_user_" + Date.now();
    const enqueueRes = await emailService.sendWelcomeEmail({
      to: targetEmail,
      userName: "Diagnostic Business Owner",
      userId: testUserId,
    });

    if (!enqueueRes.success || !enqueueRes.outboxId) {
      throw new Error(`Failed to enqueue welcome email: ${enqueueRes.error}`);
    }
    welcomeOutboxId = enqueueRes.outboxId;
    console.log(`  📥 Enqueued in durable outbox: ID ${welcomeOutboxId} (status: ${enqueueRes.status})`);

    // Synchronously deliver for deterministic testing
    const deliverRes = await emailService.deliverItem(welcomeOutboxId);
    if (!deliverRes.delivered) {
      throw new Error(`Delivery failed: ${deliverRes.error}`);
    }

    console.log(`  ✅ SUCCESS: Welcome email delivered via SMTP (Message-ID: ${deliverRes.messageId || "ok"}).`);
    passes++;
  } catch (err) {
    console.error(`  ❌ FAILED: Welcome email test failed: ${err.message}`);
    fails++;
  }

  // -------------------------------------------------------------------------
  // Test 3: Subscription Invoice Email with PDF Attachment
  // -------------------------------------------------------------------------
  console.log("\n▶ [Test 3/5] Testing Subscription Confirmation & Invoice PDF Attachment...");
  let invoiceOutboxId = null;
  const testInvoiceNumber = `SUB-DIAG-${Date.now().toString().slice(-5)}`;
  const privateDir = path.join(__dirname, "..", "private", "subscription-invoices");
  if (!fs.existsSync(privateDir)) {
    fs.mkdirSync(privateDir, { recursive: true });
  }
  const testPdfPath = path.join(privateDir, `${testInvoiceNumber}.pdf`);

  try {
    // Generate valid sample invoice PDF
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(testPdfPath);
    doc.pipe(stream);
    doc.rect(0, 0, 595.28, 12).fill("#059669");
    doc.fillColor("#065f46").font("Helvetica-Bold").fontSize(18).text("KHATANEX TAX INVOICE", 40, 40);
    doc.fillColor("#334155").font("Helvetica").fontSize(10);
    doc.text(`Invoice Number: ${testInvoiceNumber}`, 40, 70);
    doc.text(`Date: ${new Date().toLocaleDateString("en-IN")}`, 40, 85);
    doc.text(`Billed To: ${targetEmail}`, 40, 100);
    doc.text("Plan: Premium Annual Plan", 40, 115);
    doc.text("Amount: Rs. 1,499.00", 40, 130);
    doc.text("Status: PAID", 40, 145);
    doc.end();
    await new Promise((resolve) => stream.on("finish", resolve));

    console.log(`  📄 Generated test invoice PDF: ${path.basename(testPdfPath)} (${fs.statSync(testPdfPath).size} bytes)`);

    const enqueueRes = await emailService.sendSubscriptionConfirmationEmail({
      to: targetEmail,
      userName: "Diagnostic Subscriber",
      planName: "KhataNex Premium Annual",
      invoiceNumber: testInvoiceNumber,
      durationMonths: 12,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 365 * 86400000),
      totalPaise: 149900,
      pdfPath: testPdfPath,
      invoiceId: testInvoiceNumber,
    });

    if (!enqueueRes.success || !enqueueRes.outboxId) {
      throw new Error(`Failed to enqueue subscription invoice email: ${enqueueRes.error}`);
    }
    invoiceOutboxId = enqueueRes.outboxId;
    console.log(`  📥 Enqueued in durable outbox: ID ${invoiceOutboxId} (attachment: ${testInvoiceNumber}.pdf)`);

    const deliverRes = await emailService.deliverItem(invoiceOutboxId);
    if (!deliverRes.delivered) {
      throw new Error(`Delivery failed: ${deliverRes.error}`);
    }

    console.log(`  ✅ SUCCESS: Subscription invoice email delivered with PDF attachment (Message-ID: ${deliverRes.messageId || "ok"}).`);
    passes++;
  } catch (err) {
    console.error(`  ❌ FAILED: Subscription invoice email test failed: ${err.message}`);
    fails++;
  } finally {
    // Clean up temporary test PDF
    if (fs.existsSync(testPdfPath)) {
      try { fs.unlinkSync(testPdfPath); } catch (_) {}
    }
  }

  // -------------------------------------------------------------------------
  // Test 4: Idempotency & Deduplication
  // -------------------------------------------------------------------------
  console.log("\n▶ [Test 4/5] Testing Duplicate Prevention & Idempotency Safeguards...");
  try {
    // Attempt duplicate enqueue with identical reference
    const dupRes = await emailService.sendSubscriptionConfirmationEmail({
      to: targetEmail,
      userName: "Diagnostic Subscriber",
      planName: "KhataNex Premium Annual",
      invoiceNumber: testInvoiceNumber,
      durationMonths: 12,
      totalPaise: 149900,
      pdfPath: null,
      invoiceId: testInvoiceNumber, // identical reference ID
    });

    if (dupRes.duplicateIgnored === true) {
      console.log(`  🛡️ SUCCESS: Duplicate enqueue correctly identified and ignored (Outbox ID: ${dupRes.outboxId}, Status: ${dupRes.status}).`);
      passes++;
    } else {
      console.error(`  ❌ FAILED: Duplicate email was not blocked: ${JSON.stringify(dupRes)}`);
      fails++;
    }
  } catch (err) {
    console.error(`  ❌ FAILED: Idempotency test error: ${err.message}`);
    fails++;
  }

  // -------------------------------------------------------------------------
  // Test 5: Verify Outbox Database Persistence
  // -------------------------------------------------------------------------
  console.log("\n▶ [Test 5/5] Verifying Outbox Records in MySQL...");
  try {
    const idsToCheck = [welcomeOutboxId, invoiceOutboxId].filter(Boolean);
    if (idsToCheck.length === 0) {
      throw new Error("No outbox IDs available to verify.");
    }

    const [rows] = await pool.query(
      "SELECT id, recipient_email, subject, category, reference_type, status, attempts, sent_at, last_error FROM email_outbox WHERE id IN (?)",
      [idsToCheck]
    );

    let allSent = true;
    for (const r of rows) {
      console.log(`  📊 Row #${r.id}: [${r.category}] status='${r.status}', attempts=${r.attempts}, sent_at=${r.sent_at}, error=${r.last_error || "none"}`);
      if (r.status !== "sent") allSent = false;
    }

    if (allSent && rows.length === idsToCheck.length) {
      console.log("  ✅ SUCCESS: All outbox records verified in state 'sent' with zero errors.");
      passes++;
    } else {
      console.error("  ❌ FAILED: Some outbox records are not in 'sent' state.");
      fails++;
    }
  } catch (err) {
    console.error(`  ❌ FAILED: Database outbox verification failed: ${err.message}`);
    fails++;
  }

  console.log("\n====================================================================");
  console.log(`🏁 DIAGNOSTIC COMPLETE: ${passes} passed, ${fails} failed.`);
  console.log("====================================================================");

  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

runDiagnostic().catch((err) => {
  console.error("Fatal diagnostic runner error:", err);
  process.exit(1);
});

