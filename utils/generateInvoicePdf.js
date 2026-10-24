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


/*
 * ============================================================
 * WATERMARK HELPERS
 * ============================================================
 */

const resolveWatermarkEnabled = (doc, company) => {
  if (doc?.remove_watermark === 1 || doc?.remove_watermark === true || doc?.remove_watermark === "1") return false;
  if (doc?.show_watermark === 0 || doc?.show_watermark === false || doc?.show_watermark === "0") return false;
  if (company?.remove_watermark === 1 || company?.remove_watermark === true || company?.remove_watermark === "1") return false;
  if (company?.show_watermark === 0 || company?.show_watermark === false || company?.show_watermark === "0") return false;

  if (doc?.watermark_enabled !== undefined && doc?.watermark_enabled !== null) {
    return Boolean(doc.watermark_enabled === 1 || doc.watermark_enabled === true || doc.watermark_enabled === "1");
  }
  if (company?.watermark_enabled !== undefined && company?.watermark_enabled !== null) {
    return Boolean(company.watermark_enabled === 1 || company.watermark_enabled === true || company.watermark_enabled === "1");
  }

  return true;
};

const getKhataNexLogoPath = () => {
  const candidates = [
    path.join(__dirname, "../public/images/Logo2.png"),
    path.join(__dirname, "../assets/images/Logo2.png"),
    path.join(UPLOAD_ROOT, "logos/khatanex-logo.png"),
    path.join(__dirname, "../public/images/Logo.jpeg"),
    path.join(__dirname, "../assets/images/Logo.jpeg"),
    "/Users/swarajbasu/Downloads/KhataNex-main/public/images/Logo2.png",
    "/Users/swarajbasu/Downloads/KhataNex-main/public/images/Logo.jpeg",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const drawKhataNexLogoMark = (pdf, x, y, size = 10) => {
  const logoPath = getKhataNexLogoPath();
  if (logoPath) {
    try {
      pdf.image(logoPath, x, y, {
        fit: [size, size],
        align: "center",
        valign: "center",
      });
      return;
    } catch (_) {}
  }

  pdf.save();
  pdf
    .roundedRect(x, y, size, size, 2)
    .fillColor("#4338CA")
    .fill();
  pdf.restore();
};

const drawKhataNexWatermark = (pdf, centerX, y) => {
  const logoSize = 10;
  const gap = 5;
  const text = "Powered by KhataNex";
  pdf.font("Helvetica-Bold").fontSize(7.5);
  const textWidth = pdf.widthOfString(text);
  const totalWidth = logoSize + gap + textWidth;
  const startX = centerX - totalWidth / 2;

  drawKhataNexLogoMark(pdf, startX, y - 1, logoSize);

  pdf
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor("#6B7280")
    .text(text, startX + logoSize + gap, y, {
      lineBreak: false,
    });
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

      const isQuotation = doc?.doc_type === "quotation";
      const docTitle = isQuotation ? "QUOTATION" : "INVOICE";
      const docNoLabel = isQuotation ? "Quotation No" : "Invoice No";

      pdf
        .font("Helvetica-Bold")
        .fontSize(22)
        .fillColor(GREEN);
      const companyNameHeight = pdf.heightOfString(companyName, { width: 350 });
      pdf.text(companyName, 40, 40, { width: 350 });

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
        .fontSize(24)
        .fillColor(TEXT)
        .text(docTitle, 40, 105, {
          align: "right",
        });

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(`${docNoLabel}: ${invoiceNumber}`, 40, 140, {
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

      const topDividerY = Math.max(companyNameHeight + 50, 180);
      pdf
        .moveTo(40, topDividerY)
        .lineTo(555, topDividerY)
        .lineWidth(2)
        .strokeColor(GREEN)
        .stroke();

      const fromTop = topDividerY + 18;

      // Left column: FROM
      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(DARK_GREEN)
        .text("FROM", 40, fromTop);

      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(TEXT)
        .text(companyName, 40, fromTop + 16, { width: 235 });

      let fromY = fromTop + 16 + pdf.heightOfString(companyName, { width: 235, font: "Helvetica-Bold", fontSize: 11 }) + 4;

      if (companyAddress) {
        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(companyAddress, 40, fromY, { width: 235 });
        fromY += pdf.heightOfString(companyAddress, { width: 235, font: "Helvetica", fontSize: 8.5 }) + 4;
      }

      if (doc?.from_email) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Email: ${doc.from_email}`, 40, fromY, { width: 235 });
        fromY += 12;
      }

      if (doc?.from_phone) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Phone: ${doc.from_phone}`, 40, fromY, { width: 235 });
        fromY += 12;
      }

      if (doc?.from_website || company?.website) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Website: ${doc?.from_website || company?.website}`, 40, fromY, { width: 235 });
        fromY += 12;
      }

      if (doc?.from_gstin || company?.gstin) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`GSTIN: ${doc?.from_gstin || company?.gstin}`, 40, fromY, { width: 235 });
        fromY += 12;
      }

      if (doc?.from_pan || company?.pan) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`PAN: ${doc?.from_pan || company?.pan}`, 40, fromY, { width: 235 });
        fromY += 12;
      }

      // Right column: BILL TO / QUOTED TO
      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(DARK_GREEN)
        .text(isQuotation ? "QUOTED TO" : "BILL TO", 320, fromTop);

      pdf
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(TEXT)
        .text(customerName, 320, fromTop + 16, { width: 235 });

      let toY = fromTop + 16 + pdf.heightOfString(customerName, { width: 235, font: "Helvetica-Bold", fontSize: 11 }) + 4;

      if (customerBusiness) {
        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(TEXT)
          .text(customerBusiness, 320, toY, { width: 235 });
        toY += pdf.heightOfString(customerBusiness, { width: 235, font: "Helvetica", fontSize: 8.5 }) + 4;
      }

      if (customerAddress) {
        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(customerAddress, 320, toY, { width: 235 });
        toY += pdf.heightOfString(customerAddress, { width: 235, font: "Helvetica", fontSize: 8.5 }) + 4;
      }

      if (doc?.to_email || customer?.email) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Email: ${doc?.to_email || customer?.email}`, 320, toY, { width: 235 });
        toY += 12;
      }

      if (doc?.to_phone || customer?.phone) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Phone: ${doc?.to_phone || customer?.phone}`, 320, toY, { width: 235 });
        toY += 12;
      }

      if (doc?.to_gstin || customer?.gstin) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`GSTIN: ${doc?.to_gstin || customer?.gstin}`, 320, toY, { width: 235 });
        toY += 12;
      }

      if (doc?.to_pan || customer?.pan) {
        pdf.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`PAN: ${doc?.to_pan || customer?.pan}`, 320, toY, { width: 235 });
        toY += 12;
      }

      let y = Math.max(fromY, toY, fromTop + 90) + 16;

      const PAGE_CONTENT_LIMIT = 720;

      const drawFooter = () => {
        const dividerY = 770;
        pdf
          .moveTo(40, dividerY)
          .lineTo(555, dividerY)
          .lineWidth(0.6)
          .strokeColor(BORDER)
          .stroke();

        const footerText = [
          companyName,
          companyAddress,
          doc?.from_phone,
          doc?.from_email,
          doc?.from_website || company?.website,
        ]
          .filter(Boolean)
          .join("  |  ");

        const isWatermarkEnabled = resolveWatermarkEnabled(doc, company);

        if (isWatermarkEnabled) {
          pdf
            .font("Helvetica")
            .fontSize(7.5)
            .fillColor(MUTED)
            .text(footerText, 40, 778, {
              width: 515,
              align: "center",
              lineBreak: false,
              ellipsis: true,
            });

          drawKhataNexWatermark(pdf, 297.5, 798);
        } else {
          pdf
            .font("Helvetica")
            .fontSize(7.5)
            .fillColor(MUTED)
            .text(footerText, 40, 782, {
              width: 515,
              align: "center",
              lineBreak: false,
              ellipsis: true,
            });
        }
      };

      const drawTableHeader = () => {
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
      };

      if (y > 580) {
        drawFooter();
        pdf.addPage({ size: "A4", margin: 40 });
        y = 45;
      }

      drawTableHeader();

      let subtotal = 0;

      (items || []).forEach((item, index) => {
        const amount = Number(
          item.line_total ??
            item.amount ??
            Number(item.quantity || 1) *
              Number(item.price || 0)
        );

        subtotal += amount;

        if (y + 25 > PAGE_CONTENT_LIMIT) {
          drawFooter();
          pdf.addPage({ size: "A4", margin: 40 });
          y = 45;
          drawTableHeader();
        }

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

      y += 18;

      const discount = Number(doc?.discount_amount || 0);
      const total = Number(
        doc?.total_amount ??
          subtotal -
            discount
      );

      // Ensure totals block (~130px) fits before footer
      if (y + 130 > PAGE_CONTENT_LIMIT) {
        drawFooter();
        pdf.addPage({ size: "A4", margin: 40 });
        y = 45;
      }

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

      if (Number(doc?.tcs_amount || 0) > 0) {
        pdf
          .text(`TCS (${doc.tcs_rate || 0}%)`, 370, y)
          .text(`+${money(doc.tcs_amount)}`, 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      if (Number(doc?.tds_amount || 0) > 0) {
        pdf
          .text(`TDS (${doc.tds_rate || 0}%)`, 370, y)
          .text(`-${money(doc.tds_amount)}`, 455, y, {
            width: 90,
            align: "right",
          });

        y += 18;
      }

      if (Number(doc?.round_off || 0) !== 0) {
        const ro = Number(doc.round_off);
        pdf
          .text("Round Off", 370, y)
          .text(`${ro > 0 ? "+" : ""}${money(ro)}`, 455, y, {
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
        const notesH = pdf.heightOfString(doc.notes, { width: 500, font: "Helvetica", fontSize: 8.5 });
        if (y + notesH + 25 > PAGE_CONTENT_LIMIT) {
          drawFooter();
          pdf.addPage({ size: "A4", margin: 40 });
          y = 45;
        }
        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text("Notes", 40, y);

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(TEXT)
          .text(doc.notes, 40, y + 14, {
            width: 500,
          });

        y += notesH + 22;
      }

      if (doc?.terms_conditions) {
        const termsH = pdf.heightOfString(doc.terms_conditions, { width: 500, font: "Helvetica", fontSize: 8.5 });
        if (y + termsH + 25 > PAGE_CONTENT_LIMIT) {
          drawFooter();
          pdf.addPage({ size: "A4", margin: 40 });
          y = 45;
        }
        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text("Terms & Conditions", 40, y);

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(TEXT)
          .text(doc.terms_conditions, 40, y + 14, {
            width: 500,
          });

        y += termsH + 22;
      }

      // Check if signature section (~65px) fits before footer
      if (y + 65 > PAGE_CONTENT_LIMIT) {
        drawFooter();
        pdf.addPage({ size: "A4", margin: 40 });
        y = 45;
      }

      const signatureY = Math.min(Math.max(y + 10, 665), 700);

      if (signaturePath) {
        drawImageIfExists(
          pdf,
          signaturePath,
          415,
          signatureY,
          {
            fit: [120, 42],
            align: "center",
            valign: "center",
          }
        );
      }

      pdf
        .moveTo(400, signatureY + 44)
        .lineTo(555, signatureY + 44)
        .lineWidth(0.8)
        .strokeColor(BORDER)
        .stroke();

      pdf
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(
          "Authorized Signature",
          400,
          signatureY + 50,
          {
            width: 155,
            align: "center",
          }
        );

      drawFooter();

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
 * EXPORTS (DELEGATED TO GENERATEDOCUMENTPDF)
 * ============================================================
 */
const documentPdf = require("./generateDocumentPdf");

module.exports = {
  generateInvoicePdf: documentPdf.generateInvoicePdf,
  generateQuotationPdf: documentPdf.generateQuotationPdf,
  resolveWatermarkEnabled: documentPdf.resolveWatermarkEnabled,
};

