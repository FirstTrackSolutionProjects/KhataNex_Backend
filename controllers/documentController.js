const path = require("path");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { generateDocumentPdf } = require("../utils/generateDocumentPdf");
const { sendMail } = require("../utils/mailer");
const { relativeUploadPath } = require("../utils/upload");

const DOC_TYPES = ["invoice", "quotation", "merchant_bill"];
const PREFIXES = { invoice: "INV", quotation: "QUO", merchant_bill: "BILL" };

const getCompanySettings = async () => {
  const [rows] = await pool.query("SELECT * FROM company_settings WHERE id = 1");
  return (
    rows[0] || {
      company_name: process.env.COMPANY_NAME || "FIRST TRACK KHATANEX",
      address: process.env.COMPANY_ADDRESS || "",
      gstin: process.env.COMPANY_GSTIN || "",
      logo_path: null,
    }
  );
};

// POST /api/documents
// body: { doc_type: 'invoice'|'quotation'|'merchant_bill' (default 'invoice'),
//         customer_id (optional — walk-in customer if omitted),
//         items: [{ product_name, hsn_code, quantity, price }] (optional, can be empty) }
// invoice_date is always "now" — never taken from the client.
// Auto-emails the PDF to the customer ONLY if they have an email on file —
// never required, never blocks creation if it fails.
const createDocument = asyncHandler(async (req, res) => {
  const { customer_id, items } = req.body;
  const doc_type = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : "invoice";
  const safeItems = Array.isArray(items) ? items : [];

  let customer = null;
  if (customer_id) {
    const [custRows] = await pool.query("SELECT * FROM customers WHERE id = ?", [customer_id]);
    if (custRows.length) customer = custRows[0];
  }

  const subtotal = safeItems.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0),
    0
  );
  const total = subtotal;

  const conn = await pool.getConnection();
  let docId;
  let docNumber;
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO invoices (doc_type, invoice_number, customer_id, subtotal, total_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [doc_type, `TEMP-${Date.now()}`, customer?.id || null, subtotal, total, req.user.id]
    );
    docId = result.insertId;
    docNumber = `${PREFIXES[doc_type]}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${docId}`;
    await conn.query("UPDATE invoices SET invoice_number = ? WHERE id = ?", [docNumber, docId]);

    for (const it of safeItems) {
      const quantity = Number(it.quantity) > 0 ? it.quantity : 1;
      const price = Number(it.price) >= 0 ? it.price : 0;
      const amount = Number(price) * Number(quantity);
      await conn.query(
        `INSERT INTO invoice_items (invoice_id, product_name, hsn_code, quantity, price, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [docId, it.product_name || "Item", it.hsn_code || null, quantity, price, amount]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [docRows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [docId]);
  const doc = docRows[0];
  const [itemRows] = await pool.query("SELECT * FROM invoice_items WHERE invoice_id = ?", [docId]);
  const company = await getCompanySettings();

  // Generate the branded, downloadable PDF.
  const absPdfPath = await generateDocumentPdf({ doc, customer, items: itemRows, company });
  const pdfRelPath = relativeUploadPath(absPdfPath);
  await pool.query("UPDATE invoices SET pdf_path = ? WHERE id = ?", [pdfRelPath, docId]);

  // Auto-email it to the customer, only if we have their email on file.
  let emailResult = { sent: false, error: "No customer email on file — PDF is still available to download." };
  if (customer?.email) {
    emailResult = await sendMail({
      to: customer.email,
      subject: `${docNumber} from ${company.company_name}`,
      text: `Dear ${customer.name || "Customer"},\n\nPlease find attached your ${doc_type.replace(
        "_",
        " "
      )} ${docNumber} dated ${new Date(doc.invoice_date).toLocaleString("en-IN")} for a total of ₹${total.toFixed(
        2
      )}.\n\nThank you.\n\n${company.company_name}`,
      attachments: [{ filename: `${docNumber}.pdf`, path: absPdfPath }],
    });
  }
  await pool.query("UPDATE invoices SET email_status = ? WHERE id = ?", [
    emailResult.sent ? "sent" : "failed",
    docId,
  ]);

  const [finalRows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [docId]);
  res.status(201).json({
    success: true,
    document: finalRows[0],
    items: itemRows,
    download_url: `${process.env.BASE_URL || ""}${pdfRelPath}`,
    email: emailResult,
  });
});

// GET /api/documents?doc_type=&customer_id=&from=&to=
const listDocuments = asyncHandler(async (req, res) => {
  const { doc_type, customer_id, from, to } = req.query;
  let sql = `SELECT i.*, c.name AS customer_name, u.name AS created_by_name
             FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
             LEFT JOIN users u ON u.id = i.created_by WHERE 1=1`;
  const params = [];

  if (req.user.role === "user") {
    sql += " AND i.created_by = ?";
    params.push(req.user.id);
  }
  if (doc_type && DOC_TYPES.includes(doc_type)) {
    sql += " AND i.doc_type = ?";
    params.push(doc_type);
  }
  if (customer_id) {
    sql += " AND i.customer_id = ?";
    params.push(customer_id);
  }
  if (from) {
    sql += " AND i.invoice_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND i.invoice_date <= ?";
    params.push(to);
  }
  sql += " ORDER BY i.invoice_date DESC";

  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, documents: rows });
});

// GET /api/documents/:id
const getDocument = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "Document not found.");
  const [items] = await pool.query("SELECT * FROM invoice_items WHERE invoice_id = ?", [req.params.id]);
  res.json({ success: true, document: rows[0], items });
});

// POST /api/documents/:id/resend-email
const resendDocumentEmail = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
    [req.params.id]
  );
  if (!rows.length) throw new ApiError(404, "Document not found.");
  const doc = rows[0];
  if (!doc.pdf_path) throw new ApiError(400, "This document has no generated PDF to attach.");
  if (!doc.customer_email) throw new ApiError(400, "This customer has no email on file.");

  const absPdfPath = path.join(__dirname, "..", doc.pdf_path.replace(/^\/uploads/, "uploads"));
  const company = await getCompanySettings();

  const emailResult = await sendMail({
    to: doc.customer_email,
    subject: `${doc.invoice_number} from ${company.company_name}`,
    text: `Dear ${doc.customer_name || "Customer"},\n\nPlease find attached ${doc.invoice_number}.\n\n${company.company_name}`,
    attachments: [{ filename: `${doc.invoice_number}.pdf`, path: absPdfPath }],
  });

  await pool.query("UPDATE invoices SET email_status = ? WHERE id = ?", [
    emailResult.sent ? "sent" : "failed",
    doc.id,
  ]);

  res.json({ success: true, email: emailResult });
});

module.exports = { createDocument, listDocuments, getDocument, resendDocumentEmail };
