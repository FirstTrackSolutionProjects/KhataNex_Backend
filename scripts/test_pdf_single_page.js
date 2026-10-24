const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { UPLOAD_ROOT } = require("../utils/upload");

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

const numberToWordsIndian = (number) => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  if (number < 20) return ones[number];
  if (number < 100) return tens[Math.floor(number / 10)] + (number % 10 ? ` ${ones[number % 10]}` : "");
  if (number < 1000) return `${ones[Math.floor(number / 100)]} Hundred` + (number % 100 ? ` and ${numberToWordsIndian(number % 100)}` : "");
  if (number < 100000) return `${numberToWordsIndian(Math.floor(number / 1000))} Thousand` + (number % 1000 ? ` ${numberToWordsIndian(number % 1000)}` : "");
  if (number < 10000000) return `${numberToWordsIndian(Math.floor(number / 100000))} Lakh` + (number % 100000 ? ` ${numberToWordsIndian(number % 100000)}` : "");
  return `${numberToWordsIndian(Math.floor(number / 10000000))} Crore` + (number % 10000000 ? ` ${numberToWordsIndian(number % 10000000)}` : "");
};

const amountInWordsINR = (value) => {
  const amount = Number(value || 0);
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let result = `Rupees ${numberToWordsIndian(rupees)}`;
  if (paise > 0) result += ` and ${numberToWordsIndian(paise)} Paise`;
  return `${result} Only`;
};

const addressFromCompany = (company = {}) => [
  company.address_line1,
  company.address_line2,
  company.city,
  company.state,
  company.pincode,
  company.country,
].filter(Boolean).join(", ");

const addressFromCustomer = (customer = {}) => [
  customer.billing_address || customer.address,
  customer.billing_landmark,
  customer.billing_district,
  customer.billing_city,
  customer.billing_state,
  customer.billing_pincode,
].filter(Boolean).join(", ");

const getBankDetails = (doc = {}) => ({
  bankName: doc.bank_name || null,
  branch: doc.bank_branch || doc.branch || null,
  holder: doc.bank_account_holder_name || doc.account_holder_name || null,
  accountNumber: doc.bank_account_number || doc.account_number || null,
  accountType: doc.bank_account_type || doc.account_type || null,
  ifsc: doc.bank_ifsc_code || doc.ifsc_code || null,
});

const renderSinglePageDocument = ({
  doc = {},
  customer = {},
  items = [],
  company = {},
  docType = "invoice",
}) => {
  return new Promise((resolve, reject) => {
    try {
      const isQuotation = docType === "quotation" || doc?.doc_type === "quotation";
      const docNumber = isQuotation
        ? (doc?.quotation_number || doc?.document_number || "#QUOTATION")
        : (doc?.invoice_number || doc?.document_number || "#INVOICE");

      const outPath = path.join(UPLOAD_ROOT, "invoices", `${docNumber}.pdf`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const pdf = new PDFDocument({
        size: "A4", // 595.28 x 841.89
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        bufferPages: true,
      });

      const stream = fs.createWriteStream(outPath);
      pdf.pipe(stream);

      // Page constants
      const PAGE_W = 595.28;
      const PAGE_H = 841.89;
      const MARGIN_X = 28;
      const MARGIN_TOP = 24;
      const CONTENT_W = PAGE_W - (MARGIN_X * 2); // 539.28
      const FOOTER_Y = PAGE_H - 20;

      // Color Palette (Predominantly white background, dark readable text, restrained green accents, NO dark grey blocks)
      const C_TEXT = "#111827";
      const C_MUTED = "#4B5563";
      const C_LIGHT_MUTED = "#9CA3AF";
      const C_GREEN = "#16A34A";
      const C_DARK_GREEN = "#15803D";
      const C_LIGHT_GREEN = "#F0FDF4";
      const C_ROW_ALT = "#FAFAFA";
      const C_BORDER = "#E5E7EB";
      const C_BORDER_STRONG = "#D1D5DB";

      // Business & Customer Details
      const bizName = doc?.from_business_name || company?.business_name || company?.company_name || doc?.from_name || "Business Name";
      const bizAddress = doc?.from_address || addressFromCompany(company) || "";
      const bizPhone = doc?.from_phone || company?.phone || "";
      const bizEmail = doc?.from_email || company?.email || "";
      const bizGstin = doc?.from_gstin || company?.gstin || "";
      const bizPan = doc?.from_pan || company?.pan || "";

      const custName = doc?.to_name || customer?.display_name || customer?.name || "Customer";
      const custBiz = doc?.to_business_name || customer?.business_name || "";
      const custAddress = [
        doc?.to_address || customer?.billing_address || customer?.address,
        doc?.to_billing_city || customer?.billing_city || customer?.city,
        doc?.to_billing_state || customer?.billing_state || customer?.state,
        doc?.to_billing_pincode || customer?.billing_pincode || customer?.pincode,
      ].filter(Boolean).join(", ");
      const custPhone = doc?.to_phone || customer?.phone || "";
      const custEmail = doc?.to_email || customer?.email || "";
      const custGstin = doc?.to_gstin || customer?.gstin || "";
      const custPan = doc?.to_pan || customer?.pan || "";

      // Document Meta
      const docTitle = isQuotation
        ? (doc?.quotation_title || "QUOTATION")
        : (doc?.invoice_title || (doc?.is_tax_invoice !== false ? "TAX INVOICE" : "INVOICE"));
      const docDate = formatDate(isQuotation ? (doc?.quotation_date || doc?.created_at) : (doc?.invoice_date || doc?.created_at));
      const dueDateLabel = isQuotation ? "Valid Until" : "Due Date";
      const dueDateVal = (isQuotation ? doc?.valid_until : doc?.due_date) ? formatDate(isQuotation ? doc?.valid_until : doc?.due_date) : null;
      const placeOfSupply = doc?.place_of_supply || null;

      // 1. HEADER SECTION
      let curY = MARGIN_TOP;

      // Left: Company Info
      pdf.font("Helvetica-Bold").fontSize(13).fillColor(C_TEXT).text(bizName, MARGIN_X, curY, { width: 290 });
      let leftY = pdf.y + 2;

      if (bizAddress) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(bizAddress, MARGIN_X, leftY, { width: 290 });
        leftY = pdf.y + 1;
      }
      const contactBits = [];
      if (bizPhone) contactBits.push(`Phone: ${bizPhone}`);
      if (bizEmail) contactBits.push(`Email: ${bizEmail}`);
      if (contactBits.length > 0) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(contactBits.join(" | "), MARGIN_X, leftY, { width: 290 });
        leftY = pdf.y + 1;
      }
      const taxBits = [];
      if (bizGstin) taxBits.push(`GSTIN: ${bizGstin}`);
      if (bizPan) taxBits.push(`PAN: ${bizPan}`);
      if (taxBits.length > 0) {
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(taxBits.join(" | "), MARGIN_X, leftY, { width: 290 });
        leftY = pdf.y + 1;
      }

      // Right: Document Meta Info
      const rightX = MARGIN_X + 310;
      const rightW = CONTENT_W - 310;
      let rightY = MARGIN_TOP;

      pdf.font("Helvetica-Bold").fontSize(18).fillColor(C_GREEN).text(docTitle, rightX, rightY, { width: rightW, align: "right" });
      rightY = pdf.y + 4;

      pdf.font("Helvetica-Bold").fontSize(9).fillColor(C_TEXT).text(`${isQuotation ? "Quotation" : "Invoice"} #: ${docNumber}`, rightX, rightY, { width: rightW, align: "right" });
      rightY = pdf.y + 2;

      pdf.font("Helvetica").fontSize(8).fillColor(C_MUTED).text(`Date: ${docDate}`, rightX, rightY, { width: rightW, align: "right" });
      rightY = pdf.y + 2;

      if (dueDateVal) {
        pdf.font("Helvetica").fontSize(8).fillColor(C_MUTED).text(`${dueDateLabel}: ${dueDateVal}`, rightX, rightY, { width: rightW, align: "right" });
        rightY = pdf.y + 2;
      }
      if (placeOfSupply) {
        pdf.font("Helvetica").fontSize(8).fillColor(C_MUTED).text(`Place of Supply: ${placeOfSupply}`, rightX, rightY, { width: rightW, align: "right" });
        rightY = pdf.y + 2;
      }

      // Divider line below header
      curY = Math.max(leftY, rightY) + 6;
      pdf.strokeColor(C_BORDER).lineWidth(0.75).moveTo(MARGIN_X, curY).lineTo(MARGIN_X + CONTENT_W, curY).stroke();
      curY += 6;

      // 2. BILL TO SECTION
      let billLeftY = curY;
      pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("BILL TO / CUSTOMER DETAILS", MARGIN_X, billLeftY);
      billLeftY = pdf.y + 2;

      const custTitle = custBiz ? `${custBiz} (${custName})` : custName;
      pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_TEXT).text(custTitle, MARGIN_X, billLeftY, { width: 320 });
      billLeftY = pdf.y + 1;

      if (custAddress) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custAddress, MARGIN_X, billLeftY, { width: 320 });
        billLeftY = pdf.y + 1;
      }
      const custContact = [];
      if (custPhone) custContact.push(`Phone: ${custPhone}`);
      if (custEmail) custContact.push(`Email: ${custEmail}`);
      if (custContact.length > 0) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custContact.join(" | "), MARGIN_X, billLeftY, { width: 320 });
        billLeftY = pdf.y + 1;
      }
      const custTax = [];
      if (custGstin) custTax.push(`GSTIN: ${custGstin}`);
      if (custPan) custTax.push(`PAN: ${custPan}`);
      if (custTax.length > 0) {
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(custTax.join(" | "), MARGIN_X, billLeftY, { width: 320 });
        billLeftY = pdf.y + 1;
      }

      // Divider below Bill To
      curY = billLeftY + 6;
      pdf.strokeColor(C_BORDER).lineWidth(0.75).moveTo(MARGIN_X, curY).lineTo(MARGIN_X + CONTENT_W, curY).stroke();
      curY += 8;

      // 3. ITEMS TABLE
      // Normalized items list
      const rawItems = Array.isArray(items) && items.length > 0 ? items : (Array.isArray(doc?.items) ? doc.items : []);
      const normalizedItems = rawItems.map((item, idx) => {
        const name = (item?.product_name || item?.name || item?.item_name || item?.description || `Item #${idx + 1}`).trim();
        const desc = (item?.description && item.description.trim() !== name) ? item.description.trim() : "";
        const hsn = item?.hsn_code || item?.hsn || "-";
        const qty = Number(item?.quantity || 1);
        const unit = item?.unit ? ` ${item.unit}` : "";
        const rate = Number(item?.rate || item?.unit_price || item?.price || 0);
        const discount = Number(item?.discount || item?.discount_amount || 0);
        const taxRate = Number(item?.tax_rate || item?.tax_percent || item?.gst_rate || 0);
        const amount = Number(item?.total_amount || item?.amount || (qty * rate) || 0);
        return { name, desc, hsn, qty, unit, rate, discount, taxRate, amount };
      });

      // Bottom section height reservation (Side-by-side lower section)
      // Left: Words (20) + Bank (45) + Terms (45) + Notes (30) = ~140pt
      // Right: Summary (85) + Signatory (50) = ~135pt
      const LOWER_SECTION_H = 145;
      const TABLE_MAX_BOTTOM = FOOTER_Y - LOWER_SECTION_H - 10;
      const availableTableH = TABLE_MAX_BOTTOM - curY;

      // Table Column widths (sum = 539.28)
      // 1. # (24), 2. Description (200), 3. HSN (48), 4. Qty (42), 5. Rate (55), 6. Disc (45), 7. Tax% (45), 8. Total (80.28)
      const cols = [
        { label: "#", x: MARGIN_X, w: 24, align: "center" },
        { label: "Item Description", x: MARGIN_X + 24, w: 200, align: "left" },
        { label: "HSN/SAC", x: MARGIN_X + 224, w: 48, align: "center" },
        { label: "Qty", x: MARGIN_X + 272, w: 42, align: "center" },
        { label: "Rate (₹)", x: MARGIN_X + 314, w: 55, align: "right" },
        { label: "Disc", x: MARGIN_X + 369, w: 45, align: "right" },
        { label: "Tax %", x: MARGIN_X + 414, w: 45, align: "right" },
        { label: "Amount (₹)", x: MARGIN_X + 459, w: CONTENT_W - 459, align: "right" },
      ];

      // Draw Table Header
      const TH_H = 18;
      pdf.rect(MARGIN_X, curY, CONTENT_W, TH_H).fillColor(C_LIGHT_GREEN).fill();
      pdf.rect(MARGIN_X, curY, CONTENT_W, TH_H).strokeColor(C_BORDER_STRONG).lineWidth(0.5).stroke();

      pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN);
      cols.forEach((col) => {
        pdf.text(col.label, col.x + 3, curY + 5, { width: col.w - 6, align: col.align });
      });
      curY += TH_H;

      // Row height calculation to guarantee fit within single page
      const itemCount = Math.max(1, normalizedItems.length);
      const remainingForRows = availableTableH - TH_H;
      const targetRowH = Math.min(22, Math.max(14, Math.floor(remainingForRows / itemCount)));
      const isCompact = targetRowH < 18;
      const rowFontSize = isCompact ? 6.5 : 7.5;

      // Draw Rows
      normalizedItems.forEach((it, idx) => {
        const rowY = curY;
        const isAlt = idx % 2 === 1;

        if (isAlt) {
          pdf.rect(MARGIN_X, rowY, CONTENT_W, targetRowH).fillColor(C_ROW_ALT).fill();
        }
        pdf.rect(MARGIN_X, rowY, CONTENT_W, targetRowH).strokeColor(C_BORDER).lineWidth(0.5).stroke();

        pdf.font("Helvetica").fontSize(rowFontSize).fillColor(C_TEXT);
        const padY = isCompact ? 3 : 5;

        // 1. #
        pdf.text(String(idx + 1), cols[0].x + 2, rowY + padY, { width: cols[0].w - 4, align: cols[0].align });

        // 2. Item name & desc
        pdf.font("Helvetica-Bold").fontSize(rowFontSize).fillColor(C_TEXT);
        pdf.text(it.name, cols[1].x + 3, rowY + padY, { width: cols[1].w - 6, align: "left", lineBreak: false });

        // 3. HSN
        pdf.font("Helvetica").fontSize(rowFontSize).fillColor(C_MUTED);
        pdf.text(it.hsn, cols[2].x + 2, rowY + padY, { width: cols[2].w - 4, align: cols[2].align });

        // 4. Qty
        pdf.text(`${it.qty}${it.unit}`, cols[3].x + 2, rowY + padY, { width: cols[3].w - 4, align: cols[3].align });

        // 5. Rate
        pdf.text(Number(it.rate).toFixed(2), cols[4].x + 2, rowY + padY, { width: cols[4].w - 4, align: cols[4].align });

        // 6. Discount
        pdf.text(it.discount > 0 ? Number(it.discount).toFixed(2) : "-", cols[5].x + 2, rowY + padY, { width: cols[5].w - 4, align: cols[5].align });

        // 7. Tax
        pdf.text(it.taxRate > 0 ? `${it.taxRate}%` : "-", cols[6].x + 2, rowY + padY, { width: cols[6].w - 4, align: cols[6].align });

        // 8. Amount
        pdf.font("Helvetica-Bold").fontSize(rowFontSize).fillColor(C_TEXT);
        pdf.text(Number(it.amount).toFixed(2), cols[7].x + 2, rowY + padY, { width: cols[7].w - 4, align: cols[7].align });

        curY += targetRowH;
      });

      // 4. SIDE-BY-SIDE LOWER SECTION
      // Left Column (Width: 285 pt, x: MARGIN_X)
      // Right Column (Width: 235 pt, x: MARGIN_X + 304)
      const lowerY = Math.max(curY + 8, FOOTER_Y - LOWER_SECTION_H);
      const LEFT_W = 285;
      const RIGHT_X = MARGIN_X + 295;
      const RIGHT_W = CONTENT_W - 295; // 244.28

      // Calculations
      const subtotal = Number(doc?.subtotal || doc?.taxable_amount || normalizedItems.reduce((acc, it) => acc + (it.qty * it.rate), 0));
      const totalDiscount = Number(doc?.discount_amount || doc?.total_discount || 0);
      const cgst = Number(doc?.cgst_amount || 0);
      const sgst = Number(doc?.sgst_amount || 0);
      const igst = Number(doc?.igst_amount || 0);
      const totalTax = Number(doc?.total_tax || (cgst + sgst + igst));
      const roundOff = Number(doc?.round_off || 0);
      const grandTotal = Number(doc?.total_amount || doc?.total || (subtotal - totalDiscount + totalTax + roundOff));
      const paidAmount = doc?.paid_amount !== undefined ? Number(doc.paid_amount) : null;
      const balanceAmount = doc?.balance_amount !== undefined ? Number(doc.balance_amount) : (paidAmount !== null ? Math.max(0, grandTotal - paidAmount) : null);

      // --- LEFT SIDE: Amount in Words, Bank Details, Terms, Notes ---
      let leftBlockY = lowerY;

      // Amount in words
      pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 20).fillColor(C_LIGHT_GREEN).fill();
      pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 20).strokeColor(C_BORDER_STRONG).lineWidth(0.5).stroke();
      pdf.font("Helvetica-Bold").fontSize(6.5).fillColor(C_DARK_GREEN).text("AMOUNT IN WORDS:", MARGIN_X + 6, leftBlockY + 4, { width: LEFT_W - 12 });
      pdf.font("Helvetica").fontSize(7).fillColor(C_TEXT).text(amountInWordsINR(grandTotal), MARGIN_X + 6, leftBlockY + 11, { width: LEFT_W - 12, lineBreak: false });
      leftBlockY += 24;

      // Bank Details
      const bank = getBankDetails(doc);
      if (bank.bankName || bank.accountNumber) {
        pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("BANK DETAILS", MARGIN_X, leftBlockY);
        leftBlockY = pdf.y + 1;
        const bankLines = [];
        if (bank.bankName) bankLines.push(`Bank: ${bank.bankName}`);
        if (bank.accountNumber) bankLines.push(`A/C: ${bank.accountNumber}`);
        if (bank.ifsc) bankLines.push(`IFSC: ${bank.ifsc}`);
        if (bank.branch) bankLines.push(`Branch: ${bank.branch}`);
        if (bank.holder) bankLines.push(`Holder: ${bank.holder}`);
        pdf.font("Helvetica").fontSize(6.5).fillColor(C_TEXT).text(bankLines.join(" | "), MARGIN_X, leftBlockY, { width: LEFT_W });
        leftBlockY = pdf.y + 3;
      }

      // Terms & Conditions
      const terms = (doc?.terms_and_conditions || doc?.terms || company?.default_terms || "").trim();
      if (terms) {
        pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("TERMS & CONDITIONS", MARGIN_X, leftBlockY);
        leftBlockY = pdf.y + 1;
        pdf.font("Helvetica").fontSize(6).fillColor(C_MUTED).text(terms.substring(0, 200), MARGIN_X, leftBlockY, { width: LEFT_W });
        leftBlockY = pdf.y + 3;
      }

      // Notes
      const notes = (doc?.notes || doc?.customer_notes || company?.default_notes || "").trim();
      if (notes) {
        pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("NOTES", MARGIN_X, leftBlockY);
        leftBlockY = pdf.y + 1;
        pdf.font("Helvetica").fontSize(6).fillColor(C_MUTED).text(notes.substring(0, 150), MARGIN_X, leftBlockY, { width: LEFT_W });
        leftBlockY = pdf.y + 2;
      }

      // --- RIGHT SIDE: Summary Box & Authorized Signatory ---
      let rightBlockY = lowerY;

      // Summary lines
      const summaryItems = [
        { label: "Subtotal", val: `₹${subtotal.toFixed(2)}` },
      ];
      if (totalDiscount > 0) {
        summaryItems.push({ label: "Discount", val: `-₹${totalDiscount.toFixed(2)}` });
      }
      if (cgst > 0) {
        summaryItems.push({ label: "CGST", val: `₹${cgst.toFixed(2)}` });
      }
      if (sgst > 0) {
        summaryItems.push({ label: "SGST", val: `₹${sgst.toFixed(2)}` });
      }
      if (igst > 0) {
        summaryItems.push({ label: "IGST", val: `₹${igst.toFixed(2)}` });
      } else if (totalTax > 0 && cgst === 0 && sgst === 0) {
        summaryItems.push({ label: "Total Tax", val: `₹${totalTax.toFixed(2)}` });
      }
      if (roundOff !== 0) {
        summaryItems.push({ label: "Round Off", val: `₹${roundOff.toFixed(2)}` });
      }

      // Render summary box
      summaryItems.forEach((row) => {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(row.label, RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(row.val, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 12;
      });

      // Total Box
      pdf.rect(RIGHT_X, rightBlockY, RIGHT_W, 20).fillColor(C_LIGHT_GREEN).fill();
      pdf.rect(RIGHT_X, rightBlockY, RIGHT_W, 20).strokeColor(C_GREEN).lineWidth(1).stroke();
      pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_DARK_GREEN).text("TOTAL AMOUNT", RIGHT_X + 8, rightBlockY + 5);
      pdf.font("Helvetica-Bold").fontSize(10).fillColor(C_DARK_GREEN).text(`₹${grandTotal.toFixed(2)}`, RIGHT_X + 100, rightBlockY + 4, { width: RIGHT_W - 108, align: "right" });
      rightBlockY += 24;

      if (paidAmount !== null && paidAmount > 0) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text("Amount Paid:", RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(`₹${paidAmount.toFixed(2)}`, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 11;
      }
      if (balanceAmount !== null) {
        pdf.font("Helvetica-Bold").fontSize(8).fillColor(C_TEXT).text("Balance Due:", RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(8).fillColor(C_TEXT).text(`₹${balanceAmount.toFixed(2)}`, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 13;
      }

      // Signatory Section
      rightBlockY += 4;
      pdf.font("Helvetica").fontSize(7.5).fillColor(C_TEXT).text(`For ${bizName}`, RIGHT_X, rightBlockY, { width: RIGHT_W, align: "right" });
      rightBlockY += 28; // space for signature stamp
      pdf.strokeColor(C_BORDER_STRONG).lineWidth(0.5).moveTo(RIGHT_X + 60, rightBlockY).lineTo(RIGHT_X + RIGHT_W, rightBlockY).stroke();
      rightBlockY += 2;
      pdf.font("Helvetica").fontSize(6.5).fillColor(C_MUTED).text("Authorized Signatory", RIGHT_X, rightBlockY, { width: RIGHT_W, align: "right" });

      // 5. FOOTER (Strictly NO KhataNex watermark/logo)
      pdf.font("Helvetica").fontSize(6.5).fillColor(C_LIGHT_MUTED).text("This is a computer-generated document.", MARGIN_X, FOOTER_Y, {
        width: CONTENT_W,
        align: "center",
      });

      pdf.end();

      stream.on("finish", () => {
        // Inspect generated page count
        const buffer = fs.readFileSync(outPath);
        const pageMatches = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
        const actualPageCount = pageMatches ? pageMatches.length : 1;
        resolve({ outPath, actualPageCount, sizeBytes: buffer.length });
      });

      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
};

async function test() {
  console.log("Testing Single-Page PDF Engine...");
  const dummyDoc = {
    invoice_number: "INV-TEST-001",
    invoice_date: new Date(),
    due_date: new Date(),
    from_business_name: "Apex Global Traders",
    from_address: "123 Business Boulevard, Sector 5, Kolkata, WB 700091",
    from_phone: "9876543210",
    from_email: "billing@apexglobal.com",
    from_gstin: "19ABCDE1234F1Z5",
    to_name: "Rajesh Sharma",
    to_business_name: "Sharma Retail Pvt Ltd",
    to_address: "45 Market Street, Park Circus, Kolkata 700017",
    to_phone: "9123456780",
    to_email: "rajesh@sharmaretail.com",
    to_gstin: "19XYZAB9876C1Z2",
    bank_name: "HDFC Bank",
    bank_account_number: "50200012345678",
    bank_ifsc_code: "HDFC0001234",
    bank_branch: "Salt Lake Sector 5",
    terms_and_conditions: "1. Goods once sold will not be taken back. 2. Interest @ 18% p.a. will be charged if payment is delayed beyond due date.",
    notes: "Thank you for your business! Please remit payment via NEFT/RTGS.",
  };

  // Test 1: 3 items
  const items3 = [
    { product_name: "Custom Manual Item 1", quantity: 2, rate: 1500, tax_rate: 18, total_amount: 3540 },
    { product_name: "Inventory Product A", quantity: 1, rate: 800, tax_rate: 12, total_amount: 896 },
    { product_name: "Consulting Service", quantity: 5, rate: 500, tax_rate: 18, total_amount: 2950 },
  ];
  dummyDoc.items = items3;
  dummyDoc.subtotal = 5800;
  dummyDoc.total_tax = 1586;
  dummyDoc.total_amount = 7386;

  const res1 = await renderSinglePageDocument({ doc: dummyDoc, items: items3, docType: "invoice" });
  console.log("Test 1 (3 items):", res1);
  if (res1.actualPageCount !== 1) throw new Error("Test 1 produced " + res1.actualPageCount + " pages!");

  // Test 2: Quotation with 8 items
  dummyDoc.quotation_number = "QT-TEST-002";
  dummyDoc.doc_type = "quotation";
  const items8 = Array.from({ length: 8 }).map((_, i) => ({
    product_name: `Quotation Line Item ${i + 1} - High Precision Component`,
    hsn_code: "8471",
    quantity: i + 1,
    rate: (i + 1) * 250,
    tax_rate: 18,
    total_amount: (i + 1) * 250 * 1.18,
  }));
  const res2 = await renderSinglePageDocument({ doc: dummyDoc, items: items8, docType: "quotation" });
  console.log("Test 2 (8 items Quotation):", res2);
  if (res2.actualPageCount !== 1) throw new Error("Test 2 produced " + res2.actualPageCount + " pages!");

  // Test 3: 15 items
  dummyDoc.invoice_number = "INV-TEST-015";
  dummyDoc.doc_type = "invoice";
  const items15 = Array.from({ length: 15 }).map((_, i) => ({
    product_name: `Bulk Item ${i + 1}`,
    quantity: 1,
    rate: 100,
    tax_rate: 5,
    total_amount: 105,
  }));
  const res3 = await renderSinglePageDocument({ doc: dummyDoc, items: items15, docType: "invoice" });
  console.log("Test 3 (15 items Invoice):", res3);
  if (res3.actualPageCount !== 1) throw new Error("Test 3 produced " + res3.actualPageCount + " pages!");

  console.log("\nALL SINGLE-PAGE TESTS PASSED: Exactly 1 A4 page verified!");
}

test().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

