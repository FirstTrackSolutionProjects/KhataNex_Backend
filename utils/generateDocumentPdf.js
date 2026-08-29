const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { UPLOAD_ROOT } = require("./upload");

// Shared PDF layout for all three billing document types.
const TITLES = {
  invoice: "INVOICE",
  quotation: "QUOTATION",
  merchant_bill: "MERCHANT BILL",
};

/**
 * generateDocumentPdf — builds a downloadable PDF (Invoice / Quotation /
 * Merchant Bill, decided by doc.doc_type) and saves it to
 * uploads/invoices/<invoice_number>.pdf. Returns the absolute file path.
 * Works fine with an empty items array or a missing customer — everything
 * here is optional, so blanks just render as "-" / ₹0.00.
 *
 * @param {object} doc      { doc_type, invoice_number, invoice_date, subtotal, total_amount }
 * @param {object} customer { name, phone, email } or null/undefined for a walk-in customer
 * @param {array}  items    [{ product_name, hsn_code, quantity, price, amount }] (may be empty)
 * @param {object} company  { company_name, address, gstin, logo_path }
 */
const generateDocumentPdf = ({ doc, customer, items, company }) => {
  return new Promise((resolve, reject) => {
    try {
      const title = TITLES[doc.doc_type] || "DOCUMENT";
      const fileName = `${doc.invoice_number}.pdf`;
      const outPath = path.join(UPLOAD_ROOT, "invoices", fileName);
      const pdf = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(outPath);
      pdf.pipe(stream);

      // --- Header: logo + company info ---
      if (company.logo_path) {
        const absLogoPath = path.join(UPLOAD_ROOT, "..", company.logo_path.replace(/^\/uploads/, "uploads"));
        if (fs.existsSync(absLogoPath)) {
          try {
            pdf.image(absLogoPath, 50, 45, { width: 90 });
          } catch (_) {
            /* if the logo file is corrupt/unsupported, just skip it silently */
          }
        }
      }

      pdf
        .fontSize(18)
        .text(company.company_name || "FIRST TRACK KHATANEX", 160, 50, { align: "right" })
        .fontSize(9)
        .fillColor("#555")
        .text(company.address || "", 160, 72, { align: "right" })
        .text(company.gstin ? `GSTIN: ${company.gstin}` : "", 160, 86, { align: "right" })
        .fillColor("#000");

      pdf.moveTo(50, 120).lineTo(545, 120).strokeColor("#ccc").stroke();

      // --- Document meta ---
      pdf.fontSize(16).text(title, 50, 135);
      pdf
        .fontSize(10)
        .text(`No: ${doc.invoice_number}`, 50, 160)
        .text(`Date: ${new Date(doc.invoice_date).toLocaleString("en-IN")}`, 50, 175);

      pdf
        .fontSize(10)
        .text("Billed To:", 350, 160)
        .fontSize(11)
        .text(customer?.name || "Walk-in Customer", 350, 175)
        .fontSize(9)
        .text(customer?.phone || "", 350, 190)
        .text(customer?.email || "", 350, 203);

      // --- Items table ---
      let y = 240;
      pdf.fontSize(10).fillColor("#fff");
      pdf.rect(50, y, 495, 20).fill("#333");
      pdf
        .fillColor("#fff")
        .text("Item", 55, y + 6)
        .text("HSN", 230, y + 6)
        .text("Qty", 300, y + 6)
        .text("Price", 360, y + 6)
        .text("Amount", 450, y + 6);
      pdf.fillColor("#000");
      y += 25;

      (items || []).forEach((item, idx) => {
        if (idx % 2 === 1) {
          pdf.rect(50, y - 4, 495, 20).fill("#f6f6f6");
          pdf.fillColor("#000");
        }
        pdf
          .fontSize(9)
          .text(String(item.product_name || "Item"), 55, y, { width: 170 })
          .text(item.hsn_code || "-", 230, y)
          .text(String(item.quantity ?? 0), 300, y)
          .text(`₹${Number(item.price || 0).toFixed(2)}`, 360, y)
          .text(`₹${Number(item.amount || 0).toFixed(2)}`, 450, y);
        y += 22;
      });

      if (!items || !items.length) {
        pdf.fontSize(9).fillColor("#888").text("No items added.", 55, y);
        y += 22;
      }

      pdf.moveTo(50, y + 5).lineTo(545, y + 5).strokeColor("#ccc").stroke();
      y += 15;

      pdf.fillColor("#000").fontSize(10).text("Subtotal:", 400, y).text(`₹${Number(doc.subtotal || 0).toFixed(2)}`, 480, y);
      y += 18;
      pdf
        .fontSize(12)
        .text("Total:", 400, y, { continued: false })
        .text(`₹${Number(doc.total_amount || 0).toFixed(2)}`, 480, y);

      pdf
        .fontSize(8)
        .fillColor("#888")
        .text(`This is a system-generated ${title.toLowerCase()}.`, 50, 780, { align: "center", width: 495 });

      pdf.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = { generateDocumentPdf };
