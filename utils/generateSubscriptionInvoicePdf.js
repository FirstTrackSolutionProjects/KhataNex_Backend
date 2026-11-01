const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const PRIVATE_INVOICE_DIR = path.join(__dirname, "..", "private", "subscription-invoices");
if (!fs.existsSync(PRIVATE_INVOICE_DIR)) {
  fs.mkdirSync(PRIVATE_INVOICE_DIR, { recursive: true });
}

// Configurable / Centralized SAC Classification for Software Licensing Services
const DEFAULT_SUBSCRIPTION_SAC = process.env.SUBSCRIPTION_SAC_CODE || "997331";
const DEFAULT_SUBSCRIPTION_SAC_DESC = "Licensing services for the right to use computer software and databases";

// Fixed Seller Details (as required by Part 2)
const SELLER_DETAILS = {
  companyName: "First Track Solution Technologies Pvt. Ltd.",
  address: "Saheed Nagar, Bhubaneswar, Odisha, India-751007",
  contactNo: "+91 8240742313",
  email: "contact@firsttrackkhatanex.in",
  gstin: "21AAECF0000A1Z5",
  pan: "AAECF0000A",
  stateCode: "21", // Odisha State Code
  state: "Odisha",
};

// KhataNex Brand Color Palette
const COLORS = {
  purplePrimary: "#6B21A8", // KhataNex Royal Purple
  purpleDark: "#581C87",    // Deep Purple Accent
  purpleLight: "#FAF5FF",   // Subtle Purple Tint (Header/Cards)
  purpleBorder: "#E9D5FF",  // Purple Border
  slateDark: "#0F172A",     // Primary Dark Slate
  slateBody: "#334155",     // Body Slate
  slateMuted: "#64748B",    // Muted Grey Secondary Info
  borderLight: "#E2E8F0",   // Table Dividers
  borderMedium: "#CBD5E1",  // Medium Border
  white: "#FFFFFF",
};

/**
 * Currency formatter using Rs. consistently without unsupported glyphs
 */
const rs = (paise) =>
  `Rs. ${(Number(paise || 0) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * Date formatter (DD-MMM-YYYY)
 */
const fmtDate = (d) => {
  if (!d) return "—";
  const date = new Date(d);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
};

/**
 * Number to words conversion (Indian numbering system)
 */
const numberToWordsBelow100 = (number) => {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
  ];
  if (number < 20) return ones[number];
  return tens[Math.floor(number / 10)] + (number % 10 ? ` ${ones[number % 10]}` : "");
};

const numberToWordsIndian = (value) => {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number) || number <= 0) return "Zero";
  if (number < 100) return numberToWordsBelow100(number);
  if (number < 1000) {
    return (
      `${numberToWordsBelow100(Math.floor(number / 100))} Hundred` +
      (number % 100 ? ` ${numberToWordsIndian(number % 100)}` : "")
    );
  }
  if (number < 100000) {
    return (
      `${numberToWordsIndian(Math.floor(number / 1000))} Thousand` +
      (number % 1000 ? ` ${numberToWordsIndian(number % 1000)}` : "")
    );
  }
  if (number < 10000000) {
    return (
      `${numberToWordsIndian(Math.floor(number / 100000))} Lakh` +
      (number % 100000 ? ` ${numberToWordsIndian(number % 100000)}` : "")
    );
  }
  return (
    `${numberToWordsIndian(Math.floor(number / 10000000))} Crore` +
    (number % 10000000 ? ` ${numberToWordsIndian(number % 10000000)}` : "")
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

/**
 * KhataNex Original Logo retrieval mechanism
 */
const getKhataNexLogoPath = () => {
  const candidates = [
    path.join(__dirname, "../assets/images/Logo2.png"),
    path.join(__dirname, "../public/images/Logo2.png"),
    path.join(__dirname, "../assets/images/Logo.jpeg"),
    path.join(__dirname, "../public/images/Logo.jpeg"),
    "/Users/swarajbasu/Downloads/KhataNex-main/public/images/Logo2.png",
    "/Users/swarajbasu/Downloads/KhataNex-main/public/images/Logo.jpeg",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * Builds the redesigned subscription invoice PDF and saves it into PRIVATE_INVOICE_DIR.
 * @param invoice Row from subscription_invoices
 * @param order   Joined row from subscription_orders with plan_name, user details, start/end dates
 * @param company Row from company_settings (unused for seller details per Part 2)
 */
const generateSubscriptionInvoicePdf = ({ invoice, order = {}, company = {} }) =>
  new Promise((resolve, reject) => {
    try {
      const filename = invoice.pdf_filename || `${invoice.invoice_number}.pdf`;
      const outPath = path.join(PRIVATE_INVOICE_DIR, filename);

      const doc = new PDFDocument({
        size: "A4",
        margin: 40,
        info: {
          Title: `Tax Invoice - ${invoice.invoice_number}`,
          Author: "First Track Solution Technologies Pvt. Ltd.",
          Subject: "KhataNex Subscription Tax Invoice",
          Keywords: "KhataNex, Invoice, Tax Invoice, Subscription, GST",
        },
      });

      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      // Top KhataNex Purple Brand Accent Bar
      doc.rect(0, 0, 595.28, 8).fill(COLORS.purplePrimary);

      // ==========================================
      // PART 1: BRANDING AND HEADER (TWO COLUMNS)
      // ==========================================
      const headerTopY = 26;

      // Top-Left: Original Logo & KhataNex Branding
      const logoPath = getKhataNexLogoPath();
      let brandLeftX = 40;
      if (logoPath) {
        try {
          doc.image(logoPath, 40, headerTopY, { fit: [48, 48] });
          brandLeftX = 96;
        } catch (_) {}
      }

      doc.fillColor(COLORS.purplePrimary).font("Helvetica-Bold").fontSize(20).text("KhataNex", brandLeftX, headerTopY + 4);
      doc.fillColor(COLORS.slateMuted).font("Helvetica").fontSize(8.5).text("Digital Ledger & Cloud Accounting", brandLeftX, headerTopY + 28);

      // Top-Right: TAX INVOICE Header & Metadata
      const rightColX = 330;
      const rightColW = 225;

      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(19).text("TAX INVOICE", rightColX, headerTopY, {
        align: "right",
        width: rightColW,
      });

      let metaY = headerTopY + 26;
      const drawMetaRow = (label, value) => {
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.slateMuted).text(label, rightColX, metaY, { width: 90, align: "right" });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.slateDark).text(value, rightColX + 95, metaY, { width: 130, align: "right" });
        metaY += 14;
      };

      drawMetaRow("Invoice Number:", invoice.invoice_number || `SUB-${order.id}`);
      drawMetaRow("Invoice Date:", fmtDate(invoice.issued_at || order.paid_at || order.created_at));
      drawMetaRow("SAC Code:", DEFAULT_SUBSCRIPTION_SAC);

      // Subtle Top Divider
      const dividerY = Math.max(metaY + 6, 86);
      doc.moveTo(40, dividerY).lineTo(555, dividerY).strokeColor(COLORS.borderLight).lineWidth(1).stroke();

      // ==========================================
      // PART 2 & PART 3: FROM & TO SECTIONS
      // ==========================================
      const sectionY = dividerY + 14;
      const colWidth = 240;
      const col1X = 40;
      const col2X = 315;

      // Left Column: FROM (Exact Seller Details)
      doc.fillColor(COLORS.purplePrimary).font("Helvetica-Bold").fontSize(9.5).text("FROM", col1X, sectionY);
      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(10).text(SELLER_DETAILS.companyName, col1X, sectionY + 14, { width: colWidth });

      let fromY = sectionY + 28;
      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.slateBody);
      doc.text(SELLER_DETAILS.address, col1X, fromY, { width: colWidth, lineGap: 2 });
      fromY += 24;

      doc.text(`Contact No: ${SELLER_DETAILS.contactNo}`, col1X, fromY);
      fromY += 12;
      doc.text(`Email Id: ${SELLER_DETAILS.email}`, col1X, fromY);
      fromY += 12;
      doc.font("Helvetica-Bold").text(`GSTIN: ${SELLER_DETAILS.gstin}`, col1X, fromY);
      fromY += 12;
      doc.text(`PAN: ${SELLER_DETAILS.pan}`, col1X, fromY);
      fromY += 12;

      // Right Column: TO (Customer Information)
      doc.fillColor(COLORS.purplePrimary).font("Helvetica-Bold").fontSize(9.5).text("TO", col2X, sectionY);

      const customerName = (order.business_name || order.user_name || "").trim();
      let toY = sectionY + 14;
      if (customerName) {
        doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(10).text(customerName, col2X, toY, { width: colWidth });
        toY += 14;
      }

      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.slateBody);

      // Format customer address (leave blank if unavailable, no dummy/null values)
      const addressParts = [
        order.user_address,
        order.user_city,
        order.user_state,
        order.user_pincode,
      ].filter((p) => p && String(p).trim().length > 0 && String(p).toLowerCase() !== "null" && String(p).toLowerCase() !== "undefined");
      const customerAddress = addressParts.join(", ");

      if (customerAddress) {
        doc.text(customerAddress, col2X, toY, { width: colWidth, lineGap: 2 });
        toY += 24;
      }

      if (order.user_phone && String(order.user_phone).trim()) {
        doc.text(`Contact No: ${String(order.user_phone).trim()}`, col2X, toY);
        toY += 12;
      }

      if (order.user_email && String(order.user_email).trim()) {
        doc.text(`Email Id: ${String(order.user_email).trim()}`, col2X, toY);
        toY += 12;
      }

      if (order.user_gstin && String(order.user_gstin).trim()) {
        doc.font("Helvetica-Bold").text(`GSTIN: ${String(order.user_gstin).trim()}`, col2X, toY);
        toY += 12;
      }

      if (order.user_pan && String(order.user_pan).trim()) {
        doc.font("Helvetica-Bold").text(`PAN: ${String(order.user_pan).trim()}`, col2X, toY);
        toY += 12;
      }

      // Divider below addresses
      const addressBottomY = Math.max(fromY, toY, sectionY + 98);
      doc.moveTo(40, addressBottomY).lineTo(555, addressBottomY).strokeColor(COLORS.borderLight).lineWidth(1).stroke();

      // ==========================================
      // PART 4: SUBSCRIPTION DETAILS (FULL TABLE)
      // ==========================================
      const tableTopY = addressBottomY + 14;
      const tableW = 515;

      // Table Header Row
      doc.rect(40, tableTopY, tableW, 22).fill(COLORS.purpleLight);
      doc.rect(40, tableTopY, tableW, 22).strokeColor(COLORS.purpleBorder).lineWidth(0.75).stroke();

      doc.fillColor(COLORS.purpleDark).font("Helvetica-Bold").fontSize(8.5);
      doc.text("Subscription Details", 50, tableTopY + 6);
      doc.text("Plan Term", 230, tableTopY + 6, { width: 80, align: "center" });
      doc.text("Order & Payment Ref", 320, tableTopY + 6, { width: 120, align: "left" });
      doc.text("Amount", 450, tableTopY + 6, { width: 95, align: "right" });

      // Table Body Row
      const rowY = tableTopY + 22;
      const rowHeight = 62;
      doc.rect(40, rowY, tableW, rowHeight).fillAndStroke(COLORS.white, COLORS.borderLight);

      // Col 1: Plan Name & SAC Description
      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(10).text(order.plan_name || "KhataNex Cloud Subscription", 50, rowY + 8);
      doc.fillColor(COLORS.slateMuted).font("Helvetica").fontSize(7.5);
      doc.text(`SAC: ${DEFAULT_SUBSCRIPTION_SAC} — ${DEFAULT_SUBSCRIPTION_SAC_DESC}`, 50, rowY + 23, { width: 175 });
      doc.text(`Valid: ${fmtDate(order.starts_at)} to ${fmtDate(order.ends_at)}`, 50, rowY + 44, { width: 175 });

      // Col 2: Duration / Period
      doc.fillColor(COLORS.slateBody).font("Helvetica").fontSize(9);
      doc.text(`${order.duration_months || 1} Month(s)`, 230, rowY + 8, { width: 80, align: "center" });
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.slateMuted);
      doc.text("Full Access", 230, rowY + 23, { width: 80, align: "center" });

      // Col 3: Order Number & Payment Reference
      doc.fillColor(COLORS.slateBody).font("Helvetica").fontSize(8);
      doc.text(`Order: ${order.order_number || `SUB-ORD-${order.id}`}`, 320, rowY + 8, { width: 125 });
      const payId = order.provider_payment_id || order.provider_order_id || "Direct Receipt";
      doc.fillColor(COLORS.slateMuted).font("Helvetica").fontSize(7.5);
      doc.text(`Payment: ${payId}`, 320, rowY + 23, { width: 125 });
      doc.text(`Paid At: ${fmtDate(order.paid_at || order.created_at)}`, 320, rowY + 37, { width: 125 });

      // Col 4: Amount
      const displayListPaise = order.list_price_paise || order.total_paise || 0;
      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(9.5);
      doc.text(rs(displayListPaise), 450, rowY + 8, { width: 95, align: "right" });

      // ==========================================
      // PART 5: TAX BREAKDOWN AND GST TREATMENT
      // ==========================================
      // Inclusive Tax Calculation:
      // Pricing is GST-inclusive. Taxable Value + CGST + SGST + IGST = Total Amount Paid.
      const totalPaidPaise = Number(order.total_paise || 0);
      const taxPercent = Number(order.tax_percent !== undefined ? order.tax_percent : 18);

      let taxablePaise = Number(order.taxable_paise || 0);
      let taxPaise = Number(order.tax_paise || 0);

      // If taxable value is not explicitly recorded or zero, extract inclusive tax cleanly
      if (taxablePaise === 0 && totalPaidPaise > 0) {
        if (taxPercent > 0) {
          taxablePaise = Math.round(totalPaidPaise / (1 + taxPercent / 100));
          taxPaise = totalPaidPaise - taxablePaise;
        } else {
          taxablePaise = totalPaidPaise;
          taxPaise = 0;
        }
      } else if (taxPaise === 0 && totalPaidPaise > taxablePaise) {
        taxPaise = totalPaidPaise - taxablePaise;
      }

      // Determine Place of Supply (Seller is in Odisha, State Code 21)
      const userGstin = String(order.user_gstin || "").trim();
      const userState = String(order.user_state || order.user_address || "").trim().toLowerCase();
      const isIntraState =
        (userGstin.length >= 2 && userGstin.startsWith(SELLER_DETAILS.stateCode)) ||
        userState.includes("odisha") ||
        userState.includes("orissa");

      let cgstPaise = 0;
      let sgstPaise = 0;
      let igstPaise = 0;

      if (taxPaise > 0) {
        if (isIntraState) {
          // Intra-state supply: CGST (9%) + SGST (9%)
          cgstPaise = Math.floor(taxPaise / 2);
          sgstPaise = taxPaise - cgstPaise;
          igstPaise = 0;
        } else {
          // Inter-state supply: IGST (18%)
          cgstPaise = 0;
          sgstPaise = 0;
          igstPaise = taxPaise;
        }
      }

      // Financial Calculation Breakdown Box (Right-aligned)
      let calcY = rowY + rowHeight + 16;
      const calcLabelX = 320;
      const calcValX = 430;
      const calcValW = 115;

      const drawCalcRow = (label, valText, isHighlight = false, color = COLORS.slateBody) => {
        doc.font(isHighlight ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(color);
        doc.text(label, calcLabelX, calcY);
        doc.text(valText, calcValX, calcY, { width: calcValW, align: "right" });
        calcY += 15;
      };

      // Optional Discount rows
      if (order.introductory_discount_paise > 0) {
        drawCalcRow("Introductory Discount:", `- ${rs(order.introductory_discount_paise)}`, false, COLORS.purplePrimary);
      }
      if (order.coupon_discount_paise > 0) {
        drawCalcRow(`Coupon (${order.coupon_code || "DISCOUNT"}):`, `- ${rs(order.coupon_discount_paise)}`, false, COLORS.purplePrimary);
      }

      // Mandatory 4 Financial Rows:
      // 1. Taxable Value
      drawCalcRow("Taxable Value:", rs(taxablePaise));

      // 2. CGST
      drawCalcRow(
        isIntraState && taxPaise > 0 ? `CGST (${(taxPercent / 2).toFixed(1)}%):` : "CGST:",
        rs(cgstPaise)
      );

      // 3. SGST
      drawCalcRow(
        isIntraState && taxPaise > 0 ? `SGST (${(taxPercent / 2).toFixed(1)}%):` : "SGST:",
        rs(sgstPaise)
      );

      // 4. IGST
      drawCalcRow(
        !isIntraState && taxPaise > 0 ? `IGST (${taxPercent.toFixed(1)}%):` : "IGST:",
        rs(igstPaise)
      );

      // Total Amount Paid Highlight Box (KhataNex Purple Banner)
      calcY += 3;
      const totalBoxY = calcY;
      const totalBoxH = 26;
      const totalBoxW = 245;
      const totalBoxX = 310;

      doc.rect(totalBoxX, totalBoxY, totalBoxW, totalBoxH).fill(COLORS.purplePrimary);
      doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(10);
      doc.text("Total Amount Paid:", totalBoxX + 12, totalBoxY + 8);
      doc.text(rs(totalPaidPaise), totalBoxX + 115, totalBoxY + 8, { width: 118, align: "right" });

      // Total Amount in Words (Placed below the breakdown / left area)
      const wordsBoxY = totalBoxY + totalBoxH + 16;
      doc.rect(40, wordsBoxY, tableW, 28).fill(COLORS.purpleLight);
      doc.rect(40, wordsBoxY, tableW, 28).strokeColor(COLORS.purpleBorder).lineWidth(0.5).stroke();

      doc.fillColor(COLORS.purpleDark).font("Helvetica-Bold").fontSize(8.5).text("Total Amount in Words:", 50, wordsBoxY + 9);
      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(8.5).text(amountInWordsINR(totalPaidPaise / 100), 160, wordsBoxY + 9, {
        width: 385,
      });

      // Notes & GST Compliance Summary Callout
      const noteY = wordsBoxY + 36;
      doc.rect(40, noteY, tableW, 46).fill("#F8FAFC");
      doc.rect(40, noteY, tableW, 46).strokeColor(COLORS.borderLight).lineWidth(0.5).stroke();

      doc.fillColor(COLORS.slateDark).font("Helvetica-Bold").fontSize(8).text("Billing & GST Notes:", 50, noteY + 8);
      doc.fillColor(COLORS.slateMuted).font("Helvetica").fontSize(7.5);
      doc.text(
        "• Subscription pricing is inclusive of 18% GST under SAC 997331 (Licensing services for computer software and databases).",
        50,
        noteY + 20
      );
      doc.text(
        `• Place of Supply: ${isIntraState ? "Intra-State (Odisha — CGST + SGST)" : "Inter-State (IGST)"}. Total reconciles with online payment receipt.`,
        50,
        noteY + 31
      );

      // ==========================================
      // PART 7: FOOTER
      // ==========================================
      const footerY = 760;
      doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor(COLORS.borderLight).lineWidth(0.75).stroke();

      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.slateMuted);
      doc.text("Details: KhataNex subscription billing.", 40, footerY + 8, {
        align: "center",
        width: tableW,
      });
      doc.text("This is a computer-generated invoice and does not require a physical signature.", 40, footerY + 19, {
        align: "center",
        width: tableW,
      });
      doc.font("Helvetica-Bold").fillColor(COLORS.purplePrimary);
      doc.text("Thank you for choosing KhataNex!", 40, footerY + 30, {
        align: "center",
        width: tableW,
      });

      doc.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });

module.exports = {
  PRIVATE_INVOICE_DIR,
  DEFAULT_SUBSCRIPTION_SAC,
  DEFAULT_SUBSCRIPTION_SAC_DESC,
  SELLER_DETAILS,
  generateSubscriptionInvoicePdf,
  amountInWordsINR,
  rs,
  fmtDate,
};
