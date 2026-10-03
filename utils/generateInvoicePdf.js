const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { UPLOAD_ROOT } = require("./upload");

const money = (value) =>
  `Rs. ${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const resolveUploadPath = (filePath) => {
  if (!filePath) return null;

  let normalized = String(filePath).replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");

  if (normalized.startsWith("uploads/")) {
    normalized = normalized.substring("uploads/".length);
  }

  return path.join(UPLOAD_ROOT, normalized);
};

const safeDate = (value) => {
  if (!value) return new Date();

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const formatDate = (value) =>
  safeDate(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const numberToWordsBelow100 = (number) => {
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];

  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  if (number < 20) return ones[number];

  return (
    tens[Math.floor(number / 10)] +
    (number % 10 ? ` ${ones[number % 10]}` : "")
  );
};

const numberToWordsIndian = (value) => {
  const number = Math.floor(Number(value || 0));

  if (!Number.isFinite(number) || number <= 0) {
    return "Zero";
  }

  if (number < 100) {
    return numberToWordsBelow100(number);
  }

  if (number < 1000) {
    return (
      `${numberToWordsBelow100(Math.floor(number / 100))} Hundred` +
      (number % 100
        ? ` ${numberToWordsIndian(number % 100)}`
        : "")
    );
  }

  if (number < 100000) {
    return (
      `${numberToWordsIndian(Math.floor(number / 1000))} Thousand` +
      (number % 1000
        ? ` ${numberToWordsIndian(number % 1000)}`
        : "")
    );
  }

  if (number < 10000000) {
    return (
      `${numberToWordsIndian(Math.floor(number / 100000))} Lakh` +
      (number % 100000
        ? ` ${numberToWordsIndian(number % 100000)}`
        : "")
    );
  }

  return (
    `${numberToWordsIndian(Math.floor(number / 10000000))} Crore` +
    (number % 10000000
      ? ` ${numberToWordsIndian(number % 10000000)}`
      : "")
  );
};

const amountInWordsINR = (value) => {
  const amount = Number(value || 0);

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  let result = `Rupees ${numberToWordsIndian(rupees)}`;

  if (paise > 0) {
    result += ` and ${numberToWordsIndian(paise)} Paise`;
  }

  return `${result} Only`;
};

const drawImageIfExists = (
  pdf,
  filePath,
  x,
  y,
  options = {}
) => {
  const absolutePath = resolveUploadPath(filePath);

  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return false;
  }

  try {
    pdf.image(absolutePath, x, y, options);
    return true;
  } catch (_) {
    return false;
  }
};

const addressFromCompany = (company = {}) => {
  return [
    company.address_line1,
    company.address_line2,
    company.city,
    company.state,
    company.pincode,
    company.country,
  ]
    .filter(Boolean)
    .join(", ");
};

const addressFromCustomer = (customer = {}) => {
  return [
    customer.billing_address ||
      customer.address ||
      null,
    customer.billing_landmark,
    customer.billing_district,
    customer.billing_city,
    customer.billing_state,
    customer.billing_pincode,
  ]
    .filter(Boolean)
    .join(", ");
};

/*
 * ============================================================
 * INVOICE PDF
 * ============================================================
 */

const generateInvoicePdf = ({
  doc,
  customer,
  items,
  company,
}) => {
  return new Promise((resolve, reject) => {
    try {
      const invoiceNumber =
        doc?.invoice_number || "#INVOICE";

      const companyName =
        doc?.from_business_name ||
        company?.business_name ||
        company?.company_name ||
        doc?.from_name ||
        "Business";

      const companyAddress =
        [
          doc?.from_address_line1,
          doc?.from_address_line2,
          doc?.from_city,
          doc?.from_state,
          doc?.from_pincode,
          doc?.from_country,
        ]
          .filter(Boolean)
          .join(", ") ||
        addressFromCompany(company);

      const customerName =
        doc?.to_name ||
        customer?.display_name ||
        customer?.name ||
        "Customer";

      const customerBusiness =
        doc?.to_business_name ||
        customer?.business_name ||
        "";

      const customerAddress =
        [
          doc?.to_billing_state,
          doc?.to_billing_district,
          doc?.to_billing_city,
          doc?.to_billing_pincode,
          doc?.to_billing_landmark,
        ]
          .filter(Boolean)
          .join(", ") ||
        addressFromCustomer(customer);

      const logoPath =
        doc?.from_logo_path ||
        company?.logo_path ||
        null;

      const signaturePath =
        doc?.from_signature_path ||
        company?.signature_path ||
        null;

      const outPath = path.join(
        UPLOAD_ROOT,
        "invoices",
        `${invoiceNumber}.pdf`
      );

      fs.mkdirSync(path.dirname(outPath), {
        recursive: true,
      });

      const pdf = new PDFDocument({
        size: "A4",
        margin: 40,
      });

      const stream = fs.createWriteStream(outPath);

      pdf.pipe(stream);

      const GREEN = "#16A34A";
      const DARK_GREEN = "#166534";
      const LIGHT_GREEN = "#F0FDF4";
      const BORDER = "#D1D5DB";
      const TEXT = "#111827";
      const MUTED = "#6B7280";

      pdf
        .font("Helvetica-Bold")
        .fontSize(24)
        .fillColor(GREEN)
        .text(companyName, 40, 40, {
          width: 350,
        });

      drawImageIfExists(
        pdf,
        logoPath,
        465,
        35,
        {
          fit: [90, 55],
          align: "right",
          valign: "center",
        }
      );

      pdf
        .font("Helvetica-Bold")
        .fontSize(25)
        .fillColor(TEXT)
        .text("INVOICE", 40, 105, {
          align: "right",
        });

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(`Invoice No: ${invoiceNumber}`, 40, 140, {
          align: "right",
        });

      pdf.text(
        `Date: ${formatDate(doc?.invoice_date)}`,
        40,
        155,
        {
          align: "right",
        }
      );

      pdf
        .moveTo(40, 180)
        .lineTo(555, 180)
        .lineWidth(2)
        .strokeColor(GREEN)
        .stroke();

      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(DARK_GREEN)
        .text("FROM", 40, 200);

      pdf
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(TEXT)
        .text(companyName, 40, 218);

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(companyAddress || "", 40, 236, {
          width: 230,
        });

      if (doc?.from_email) {
        pdf.text(`Email: ${doc.from_email}`, 40, 270);
      }

      if (doc?.from_phone) {
        pdf.text(`Phone: ${doc.from_phone}`, 40, 283);
      }

      if (doc?.from_gstin) {
        pdf.text(`GSTIN: ${doc.from_gstin}`, 40, 296);
      }

      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(DARK_GREEN)
        .text("BILL TO", 320, 200);

      pdf
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(TEXT)
        .text(customerName, 320, 218);

      if (customerBusiness) {
        pdf
          .font("Helvetica")
          .fontSize(9)
          .text(customerBusiness, 320, 235);
      }

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(customerAddress || "", 320, 252, {
          width: 220,
        });

      if (doc?.to_email || customer?.email) {
        pdf.text(
          `Email: ${doc?.to_email || customer?.email}`,
          320,
          286
        );
      }

      if (doc?.to_phone || customer?.phone) {
        pdf.text(
          `Phone: ${doc?.to_phone || customer?.phone}`,
          320,
          299
        );
      }

      if (doc?.to_gstin || customer?.gstin) {
        pdf.text(
          `GSTIN: ${doc?.to_gstin || customer?.gstin}`,
          320,
          312
        );
      }

      let y = 350;

      pdf
        .rect(40, y, 515, 25)
        .fill(GREEN);

      pdf
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#FFFFFF")
        .text("#", 48, y + 8)
        .text("Item", 75, y + 8)
        .text("Qty", 310, y + 8)
        .text("Rate", 365, y + 8)
        .text("Amount", 465, y + 8);

      y += 25;

      let subtotal = 0;

      (items || []).forEach((item, index) => {
        const amount = Number(
          item.line_total ??
            item.amount ??
            Number(item.quantity || 1) *
              Number(item.price || 0)
        );

        subtotal += amount;

        if (index % 2 === 0) {
          pdf
            .rect(40, y, 515, 25)
            .fill(LIGHT_GREEN);
        }

        pdf
          .font("Helvetica")
          .fontSize(9)
          .fillColor(TEXT)
          .text(String(index + 1), 48, y + 8)
          .text(item.product_name || "Item", 75, y + 8, {
            width: 220,
            ellipsis: true,
          })
          .text(String(item.quantity || 1), 310, y + 8)
          .text(money(item.price), 365, y + 8)
          .text(money(amount), 465, y + 8);

        y += 25;
      });

      y += 20;

      const discount = Number(doc?.discount_amount || 0);
      const total = Number(
        doc?.total_amount ??
          subtotal -
            discount
      );

      pdf
        .font("Helvetica")
        .fontSize(10)
        .fillColor(TEXT)
        .text("Subtotal", 370, y)
        .text(money(subtotal), 455, y, {
          width: 90,
          align: "right",
        });

      y += 18;

      if (discount > 0) {
        pdf
          .text("Discount", 370, y)
          .text(`-${money(discount)}`, 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      if (Number(doc?.cgst_amount || 0) > 0) {
        pdf
          .text(`CGST (${doc.cgst_rate || 0}%)`, 370, y)
          .text(money(doc.cgst_amount), 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      if (Number(doc?.sgst_amount || 0) > 0) {
        pdf
          .text(`SGST (${doc.sgst_rate || 0}%)`, 370, y)
          .text(money(doc.sgst_amount), 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      if (Number(doc?.igst_amount || 0) > 0) {
        pdf
          .text(`IGST (${doc.igst_rate || 0}%)`, 370, y)
          .text(money(doc.igst_amount), 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      pdf
        .rect(360, y + 8, 195, 34)
        .fill(GREEN);

      pdf
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#FFFFFF")
        .text("TOTAL", 375, y + 19)
        .text(money(total), 465, y + 19);

      y += 65;

      pdf
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(DARK_GREEN)
        .text("Amount in Words", 40, y);

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(TEXT)
        .text(amountInWordsINR(total), 40, y + 16, {
          width: 500,
        });

      y += 48;

      if (doc?.notes) {
        pdf
          .font("Helvetica-Bold")
          .fillColor(DARK_GREEN)
          .text("Notes", 40, y);

        pdf
          .font("Helvetica")
          .fillColor(TEXT)
          .text(doc.notes, 40, y + 16, {
            width: 500,
          });

        y += 45;
      }

      if (doc?.terms_conditions) {
        pdf
          .font("Helvetica-Bold")
          .fillColor(DARK_GREEN)
          .text("Terms & Conditions", 40, y);

        pdf
          .font("Helvetica")
          .fillColor(TEXT)
          .text(doc.terms_conditions, 40, y + 16, {
            width: 500,
          });
      }

      if (signaturePath) {
        drawImageIfExists(
          pdf,
          signaturePath,
          410,
          700,
          {
            fit: [120, 50],
            align: "center",
            valign: "center",
          }
        );
      }

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(
          "Authorized Signature",
          400,
          755,
          {
            width: 150,
            align: "center",
          }
        );

      pdf.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (error) {
      reject(error);
    }
  });
};

/*
 * ============================================================
 * QUOTATION PDF
 * ============================================================
 */

const generateQuotationPdf = ({
  doc,
  customer,
  items,
  company,
}) => {
  return new Promise((resolve, reject) => {
    try {
