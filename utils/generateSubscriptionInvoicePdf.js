const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const PRIVATE_INVOICE_DIR = path.join(__dirname, "..", "private", "subscription-invoices");
if (!fs.existsSync(PRIVATE_INVOICE_DIR)) {
  fs.mkdirSync(PRIVATE_INVOICE_DIR, { recursive: true });
}

const rs = (paise) => `Rs. ${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) => {
  if (!d) return "-";
  const date = new Date(d);
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
};

/**
 * Builds the subscription invoice PDF and saves it into PRIVATE_INVOICE_DIR.
 * @param invoice Row from subscription_invoices
 * @param order   Joined row from subscription_orders with plan_name, user details, start/end dates
 * @param company Row from company_settings
 */
const generateSubscriptionInvoicePdf = ({ invoice, order, company = {} }) =>
  new Promise((resolve, reject) => {
    try {
      const filename = invoice.pdf_filename || `SUB-INV-${invoice.invoice_number}.pdf`;
      const outPath = path.join(PRIVATE_INVOICE_DIR, filename);

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const stream = fs.createWriteStream(outPath);

      doc.pipe(stream);

      // Emerald brand bar at top
      doc.rect(0, 0, 595.28, 12).fill("#059669");

      // Header
      const companyName = company.company_name || process.env.COMPANY_NAME || "FIRST TRACK KHATANEX";
      const companyAddress = company.address || process.env.COMPANY_ADDRESS || "";
      const companyGstin = company.gstin || process.env.COMPANY_GSTIN || "";

      let y = 35;
      doc.fillColor("#065f46").font("Helvetica-Bold").fontSize(20).text(companyName, 40, y);
      doc.fillColor("#64748b").font("Helvetica").fontSize(9);

      y += 24;
      if (companyAddress) {
        doc.text(companyAddress, 40, y, { width: 300 });
        y += 14;
      }
      if (companyGstin) {
        doc.text(`GSTIN: ${companyGstin}`, 40, y);
        y += 14;
      }

      // Title & Invoice Meta (Right side)
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(16).text("TAX INVOICE", 380, 35, { align: "right", width: 175 });
      doc.fillColor("#059669").font("Helvetica-Bold").fontSize(10).text(`INV: ${invoice.invoice_number}`, 380, 58, { align: "right", width: 175 });
      doc.fillColor("#475569").font("Helvetica").fontSize(9);
      doc.text(`Date: ${fmtDate(invoice.issued_at || order.paid_at)}`, 380, 74, { align: "right", width: 175 });
      doc.text(`Payment ID: ${order.provider_payment_id || order.provider_order_id || "Direct"}`, 380, 88, { align: "right", width: 175 });
      doc.text(`Status: PAID`, 380, 102, { align: "right", width: 175 });

      // Divider
      y = Math.max(y + 10, 125);
      doc.moveTo(40, y).lineTo(555, y).strokeColor("#e2e8f0").stroke();

      // Billed To Section
      y += 15;
      doc.fillColor("#059669").font("Helvetica-Bold").fontSize(10).text("BILLED TO", 40, y);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text(order.business_name || order.user_name || "Customer", 40, y + 14);

      doc.fillColor("#475569").font("Helvetica").fontSize(9);
      let clientY = y + 28;
      if (order.user_email) {
        doc.text(`Email: ${order.user_email}`, 40, clientY);
        clientY += 12;
      }
      if (order.user_phone) {
        doc.text(`Phone: ${order.user_phone}`, 40, clientY);
        clientY += 12;
      }
      if (order.user_address) {
        doc.text(`Address: ${order.user_address}`, 40, clientY, { width: 280 });
        clientY += 12;
      }
      if (order.user_gstin) {
        doc.text(`GSTIN: ${order.user_gstin}`, 40, clientY);
        clientY += 12;
      }

      // Subscription Plan & Term Meta (Right Box)
      const termY = y;
      doc.rect(370, termY, 185, 80).fillAndStroke("#f0fdf4", "#bbf7d0");
      doc.fillColor("#166534").font("Helvetica-Bold").fontSize(9).text("SUBSCRIPTION PERIOD", 380, termY + 10);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text(order.plan_name || "KhataNex Plan", 380, termY + 24);
      doc.fillColor("#475569").font("Helvetica").fontSize(9);
      doc.text(`Starts: ${fmtDate(order.starts_at)}`, 380, termY + 42);
      doc.text(`Valid Until: ${fmtDate(order.ends_at)}`, 380, termY + 56);

      // Table Header
      y = Math.max(clientY + 15, termY + 95);
      doc.rect(40, y, 515, 24).fill("#f8fafc");
      doc.fillColor("#475569").font("Helvetica-Bold").fontSize(9);
      doc.text("Description", 50, y + 7);
      doc.text("Plan Term", 280, y + 7);
      doc.text("Qty", 380, y + 7, { width: 30, align: "center" });
      doc.text("Amount", 430, y + 7, { width: 115, align: "right" });

      // Table Row
      y += 24;
      doc.moveTo(40, y).lineTo(555, y).strokeColor("#cbd5e1").stroke();
      y += 8;

      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10);
      doc.text(order.plan_name || "Subscription", 50, y);
      doc.font("Helvetica").fontSize(8).fillColor("#64748b");
      doc.text(`KhataNex cloud digital ledger & accounting platform`, 50, y + 13);

      doc.font("Helvetica").fontSize(9).fillColor("#334155");
      doc.text(`${order.duration_months || 1} Month(s)`, 280, y);
      doc.text("1", 380, y, { width: 30, align: "center" });
      doc.font("Helvetica-Bold").fillColor("#0f172a");
      doc.text(rs(order.list_price_paise), 430, y, { width: 115, align: "right" });

      y += 35;
      doc.moveTo(40, y).lineTo(555, y).strokeColor("#e2e8f0").stroke();

      // Calculation Breakdown
      y += 12;
      const calcX = 350;
      const valX = 430;
      const width = 115;

      doc.font("Helvetica").fontSize(9).fillColor("#475569");
      doc.text("List Price:", calcX, y);
      doc.text(rs(order.list_price_paise), valX, y, { width, align: "right" });
      y += 16;

      if (order.introductory_discount_paise > 0) {
        doc.fillColor("#059669");
        doc.text("Introductory Discount:", calcX, y);
        doc.text(`- ${rs(order.introductory_discount_paise)}`, valX, y, { width, align: "right" });
        y += 16;
      }

      if (order.coupon_discount_paise > 0) {
        doc.fillColor("#059669");
        doc.text(`Coupon (${order.coupon_code || "DISCOUNT"}):`, calcX, y);
        doc.text(`- ${rs(order.coupon_discount_paise)}`, valX, y, { width, align: "right" });
        y += 16;
      }

      doc.fillColor("#475569");
      doc.text("Taxable Value:", calcX, y);
      doc.text(rs(order.taxable_paise), valX, y, { width, align: "right" });
      y += 16;

      if (Number(order.tax_percent) > 0) {
        doc.text(`GST / Tax (${order.tax_percent}%):`, calcX, y);
        doc.text(rs(order.tax_paise), valX, y, { width, align: "right" });
        y += 16;
      }

      // Total Box
      y += 4;
      doc.rect(calcX - 10, y, 215, 28).fill("#059669");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11);
      doc.text("Total Paid:", calcX, y + 8);
      doc.text(rs(order.total_paise), valX, y + 8, { width, align: "right" });

      // Footer
      doc.fontSize(8).fillColor("#94a3b8").font("Helvetica");
      doc.text(
        "This is a system-generated electronic invoice. No physical signature is required.",
        40,
        760,
        { align: "center", width: 515 }
      );
      doc.text(
        "For support or billing inquiries, visit khatanex.com or email support@khatanex.com",
        40,
        774,
        { align: "center", width: 515 }
      );

      doc.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });

module.exports = {
  PRIVATE_INVOICE_DIR,
  generateSubscriptionInvoicePdf,
};

