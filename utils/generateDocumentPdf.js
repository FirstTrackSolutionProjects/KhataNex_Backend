const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { UPLOAD_ROOT } = require("./upload");

/*
 * ============================================================
 * COLORS
 * ============================================================
 */

const GREEN = "#16A34A";
const DARK_GREEN = "#166534";
const LIGHT_GREEN = "#F0FDF4";
const ROW_GREEN = "#F7FCF8";
const BORDER = "#D1D5DB";
const TEXT = "#111827";
const MUTED = "#6B7280";
const WHITE = "#FFFFFF";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

const money = (value) =>
  `Rs. ${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const resolveUploadPath = (filePath) => {
  if (!filePath) {
    return null;
  }

  let normalized = String(filePath).replace(
    /\\/g,
    "/"
  );

  normalized = normalized.replace(
    /^\/+/,
    ""
  );

  if (
    normalized.startsWith("uploads/")
  ) {
    normalized = normalized.substring(
      "uploads/".length
    );
  }

  return path.join(
    UPLOAD_ROOT,
    normalized
  );
};

const safeDate = (value) => {
  if (!value) {
    return new Date();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? new Date()
    : date;
};

const formatDate = (value) =>
  safeDate(value).toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }
  );

/*
 * ============================================================
 * NUMBER TO WORDS
 * ============================================================
 */

const numberToWordsBelow100 = (
  number
) => {
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

  if (number < 20) {
    return ones[number];
  }

  return (
    tens[Math.floor(number / 10)] +
    (number % 10
      ? ` ${ones[number % 10]}`
      : "")
  );
};

const numberToWordsIndian = (
  value
) => {
  const number = Math.floor(
    Number(value || 0)
  );

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return "Zero";
  }

  if (number < 100) {
    return numberToWordsBelow100(
      number
    );
  }

  if (number < 1000) {
    return (
      `${numberToWordsBelow100(
        Math.floor(number / 100)
      )} Hundred` +
      (number % 100
        ? ` ${numberToWordsIndian(
          number % 100
        )}`
        : "")
    );
  }

  if (number < 100000) {
    return (
      `${numberToWordsIndian(
        Math.floor(number / 1000)
      )} Thousand` +
      (number % 1000
        ? ` ${numberToWordsIndian(
          number % 1000
        )}`
        : "")
    );
  }

  if (number < 10000000) {
    return (
      `${numberToWordsIndian(
        Math.floor(number / 100000)
      )} Lakh` +
      (number % 100000
        ? ` ${numberToWordsIndian(
          number % 100000
        )}`
        : "")
    );
  }

  return (
    `${numberToWordsIndian(
      Math.floor(number / 10000000)
    )} Crore` +
    (number % 10000000
      ? ` ${numberToWordsIndian(
        number % 10000000
      )}`
      : "")
  );
};

const amountInWordsINR = (
  value
) => {
  const amount = Number(value || 0);

  const rupees = Math.floor(amount);

  const paise = Math.round(
    (amount - rupees) * 100
  );

  let result =
    `Rupees ${numberToWordsIndian(
      rupees
    )}`;

  if (paise > 0) {
    result +=
      ` and ${numberToWordsIndian(
        paise
      )} Paise`;
  }

  return `${result} Only`;
};

/*
 * ============================================================
 * IMAGE HELPERS
 * ============================================================
 */


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
  const absolutePath =
    resolveUploadPath(filePath);

  if (
    !absolutePath ||
    !fs.existsSync(absolutePath)
  ) {
    return false;
  }

  try {
    const img = pdf.openImage(absolutePath);
    let renderWidth = img.width;
    let renderHeight = img.height;
    if (options.fit && Array.isArray(options.fit)) {
      const [maxW, maxH] = options.fit;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      renderWidth = img.width * scale;
      renderHeight = img.height * scale;
    } else if (options.width && options.height) {
      renderWidth = options.width;
      renderHeight = options.height;
    } else if (options.width) {
      renderWidth = options.width;
      renderHeight = (img.height / img.width) * options.width;
    }

    pdf.image(
      img,
      x,
      y,
      options
    );

    return { drawn: true, width: renderWidth, height: renderHeight };
  } catch (_) {
    return false;
  }
};

/*
 * ============================================================
 * ADDRESS HELPERS
 * ============================================================
 */

const addressFromCompany = (
  company = {}
) => {
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

const addressFromCustomer = (
  customer = {}
) => {
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
 * BANK DETAILS
 * ============================================================
 */

const getBankDetails = (
  doc = {}
) => {
  return {
    bankName:
      doc.bank_name ||
      null,

    branch:
      doc.bank_branch ||
      doc.branch ||
      null,

    holder:
      doc.bank_account_holder_name ||
      doc.account_holder_name ||
      null,

    accountNumber:
      doc.bank_account_number ||
      doc.account_number ||
      null,

    accountType:
      doc.bank_account_type ||
      doc.account_type ||
      null,

    ifsc:
      doc.bank_ifsc_code ||
      doc.ifsc_code ||
      null,
  };
};

/*
 * ============================================================
 * STRICT SINGLE-PAGE A4 DOCUMENT ENGINE (INVOICES & QUOTATIONS)
 * ============================================================
 * - Exactly one A4 page (595.28 x 841.89 pt)
 * - Predominantly white background, crisp dark text, restrained green accents
 * - No dark grey blocks
 * - Only user's business profile logo (never KhataNex watermark/logo)
 * - Side-by-side lower section: Bank/Terms/Notes on LEFT, Totals/Signature on RIGHT
 * - Auto-scaling row heights to guarantee zero page overflows
 */

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
        size: "A4", // 595.28 x 841.89 pt
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        bufferPages: true,
      });

      const stream = fs.createWriteStream(outPath);
      pdf.pipe(stream);

      // Page dimensions
      const PAGE_W = 595.28;
      const PAGE_H = 841.89;
      const MARGIN_X = 28;
      const MARGIN_TOP = 24;
      const CONTENT_W = PAGE_W - (MARGIN_X * 2); // 539.28 pt
      const FOOTER_Y = PAGE_H - 22;

      // Exact color palette
      const C_WHITE = "#FFFFFF";
      const C_GREEN = "#198754";
      const C_DARK_GREEN = "#146C43";
      const C_TEXT = "#212529";
      const C_MUTED = "#666666";
      const C_BORDER = "#D9E2DC";
      const C_TH_BG = "#EAF4EE";
      const C_ROW_ALT = "#F8FAF9";

      // 1. White background
      pdf.rect(0, 0, PAGE_W, PAGE_H).fillColor(C_WHITE).fill();

      // 2. Centered watermark (behind content)
      if (resolveWatermarkEnabled(doc, company)) {
        pdf.save();
        pdf.translate(297.64, 420.95);
        pdf.rotate(-35, { origin: [0, 0] });
        pdf.fillColor(C_GREEN);
        pdf.fillOpacity(0.06);
        pdf.font("Helvetica-Bold").fontSize(54);
        pdf.text("KHATANEX", -150, -27, { width: 300, align: "center", lineBreak: false });
        pdf.restore();
        pdf.fillOpacity(1.0);
      }

      // Business & Customer Details
      const bizName = doc?.from_business_name || company?.business_name || company?.company_name || doc?.from_name || "Business Name";
      const bizAddress = doc?.from_address || addressFromCompany(company) || "";
      const bizPhone = doc?.from_phone || company?.phone || "";
      const bizEmail = doc?.from_email || company?.email || "";
      const bizGstin = doc?.from_gstin || company?.gstin || "";
      const bizPan = doc?.from_pan || company?.pan || "";
      const bizLogo = doc?.from_logo_path || doc?.business_logo || company?.logo_path || company?.business_logo || null;
      const bizSig = doc?.from_signature_path || doc?.signature_image || company?.signature_path || company?.signature_image || null;

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
      const custState = doc?.to_billing_state || customer?.billing_state || customer?.state || "";

      // Shipping details (for invoice)
      const shipName = doc?.ship_to_name || doc?.consignee_name || (custBiz ? `${custBiz}` : custName);
      const shipAddress = [
        doc?.ship_to_address || doc?.to_shipping_address || customer?.shipping_address,
        doc?.ship_to_city || customer?.shipping_city,
        doc?.ship_to_state || customer?.shipping_state,
        doc?.ship_to_pincode || customer?.shipping_pincode,
      ].filter(Boolean).join(", ");

      // Document Meta
      const docTitle = isQuotation
        ? (doc?.quotation_title || "QUOTATION")
        : (doc?.invoice_title || (doc?.is_tax_invoice !== false ? "TAX INVOICE" : "INVOICE"));
      const docDate = formatDate(isQuotation ? (doc?.quotation_date || doc?.created_at) : (doc?.invoice_date || doc?.created_at));
      const dueDateLabel = isQuotation ? "Valid Until" : "Due Date";
      const dueDateVal = (isQuotation ? doc?.valid_until : doc?.due_date) ? formatDate(isQuotation ? doc?.valid_until : doc?.due_date) : null;
      const placeOfSupply = doc?.place_of_supply || custState || null;
      const reverseCharge = doc?.reverse_charge !== undefined ? (doc.reverse_charge ? "Yes" : "No") : null;

      // 3. HEADER SECTION
      let curY = MARGIN_TOP;

      // Left: Company Info (and Logo if exists)
      let leftY = curY;
      if (bizLogo) {
        const drawn = drawImageIfExists(pdf, bizLogo, MARGIN_X, curY, { fit: [110, 36] });
        if (drawn && drawn.height) {
          leftY = curY + drawn.height + 4;
        }
      }

      pdf.font("Helvetica-Bold").fontSize(12).fillColor(C_TEXT).text(bizName, MARGIN_X, leftY, { width: 290 });
      leftY = pdf.y + 2;

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
      if (reverseCharge) {
        pdf.font("Helvetica").fontSize(8).fillColor(C_MUTED).text(`Reverse Charge: ${reverseCharge}`, rightX, rightY, { width: rightW, align: "right" });
        rightY = pdf.y + 2;
      }

      // Divider below header
      curY = Math.max(leftY, rightY) + 5;
      pdf.strokeColor(C_BORDER).lineWidth(0.75).moveTo(MARGIN_X, curY).lineTo(MARGIN_X + CONTENT_W, curY).stroke();
      curY += 5;

      // 4. PARTIES SECTION (Side-by-Side)
      const partyBoxW = (CONTENT_W - 12) / 2; // 263.64 pt
      const partyRightX = MARGIN_X + partyBoxW + 12;

      let billLeftY = curY;
      let billRightY = curY;

      if (isQuotation) {
        // QUOTATION: PREPARED FOR & PREPARED BY
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN).text("PREPARED FOR", MARGIN_X, billLeftY);
        billLeftY = pdf.y + 2;

        const custTitle = custBiz ? `${custBiz} (${custName})` : custName;
        pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_TEXT).text(custTitle, MARGIN_X, billLeftY, { width: partyBoxW });
        billLeftY = pdf.y + 1;

        if (custAddress) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custAddress, MARGIN_X, billLeftY, { width: partyBoxW });
          billLeftY = pdf.y + 1;
        }
        const custContact = [];
        if (custPhone) custContact.push(`Phone: ${custPhone}`);
        if (custEmail) custContact.push(`Email: ${custEmail}`);
        if (custContact.length > 0) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custContact.join(" | "), MARGIN_X, billLeftY, { width: partyBoxW });
          billLeftY = pdf.y + 1;
        }

        // Right side: Prepared By
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN).text("PREPARED BY", partyRightX, billRightY);
        billRightY = pdf.y + 2;
        pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_TEXT).text(bizName, partyRightX, billRightY, { width: partyBoxW });
        billRightY = pdf.y + 1;
        if (bizAddress) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(bizAddress, partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
        }
        if (bizEmail || bizPhone) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text([bizPhone, bizEmail].filter(Boolean).join(" | "), partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
        }
      } else {
        // INVOICE: BILL TO & SHIP TO
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN).text("BILL TO", MARGIN_X, billLeftY);
        billLeftY = pdf.y + 2;

        const custTitle = custBiz ? `${custBiz} (${custName})` : custName;
        pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_TEXT).text(custTitle, MARGIN_X, billLeftY, { width: partyBoxW });
        billLeftY = pdf.y + 1;

        if (custAddress) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custAddress, MARGIN_X, billLeftY, { width: partyBoxW });
          billLeftY = pdf.y + 1;
        }
        const custContact = [];
        if (custPhone) custContact.push(`Phone: ${custPhone}`);
        if (custEmail) custContact.push(`Email: ${custEmail}`);
        if (custContact.length > 0) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(custContact.join(" | "), MARGIN_X, billLeftY, { width: partyBoxW });
          billLeftY = pdf.y + 1;
        }
        const custTax = [];
        if (custGstin) custTax.push(`GSTIN: ${custGstin}`);
        if (custPan) custTax.push(`PAN: ${custPan}`);
        if (custTax.length > 0) {
          pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(custTax.join(" | "), MARGIN_X, billLeftY, { width: partyBoxW });
          billLeftY = pdf.y + 1;
        }

        // Right side: Ship To
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN).text("SHIP TO", partyRightX, billRightY);
        billRightY = pdf.y + 2;

        if (shipAddress) {
          pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_TEXT).text(shipName, partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(shipAddress, partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
        } else {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text("Same as Bill To Address", partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
        }
        const dispatchBits = [];
        if (placeOfSupply) dispatchBits.push(`Place of Supply: ${placeOfSupply}`);
        if (doc?.po_number) dispatchBits.push(`PO #: ${doc.po_number}`);
        if (doc?.vehicle_number) dispatchBits.push(`Vehicle: ${doc.vehicle_number}`);
        if (dispatchBits.length > 0) {
          pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(dispatchBits.join(" | "), partyRightX, billRightY, { width: partyBoxW });
          billRightY = pdf.y + 1;
        }
      }

      // Divider below parties
      curY = Math.max(billLeftY, billRightY) + 5;
      pdf.strokeColor(C_BORDER).lineWidth(0.75).moveTo(MARGIN_X, curY).lineTo(MARGIN_X + CONTENT_W, curY).stroke();
      curY += 7;

      // 5. ITEMS TABLE
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
        const taxable = Math.max(0, (qty * rate) - discount);
        return { name, desc, hsn, qty, unit, rate, discount, taxRate, taxable, amount };
      });

      const LOWER_SECTION_H = isQuotation ? 148 : 142;
      const TABLE_MAX_BOTTOM = FOOTER_Y - LOWER_SECTION_H - 8;
      const availableTableH = Math.max(80, TABLE_MAX_BOTTOM - curY);

      // Columns summing strictly to CONTENT_W = 539.28 pt
      const cols = [
        { label: "#", x: MARGIN_X, w: 22, align: "center" },
        { label: "Item Description", x: MARGIN_X + 22, w: 172, align: "left" },
        { label: "HSN/SAC", x: MARGIN_X + 194, w: 42, align: "center" },
        { label: "Qty", x: MARGIN_X + 236, w: 34, align: "center" },
        { label: "Unit", x: MARGIN_X + 270, w: 30, align: "center" },
        { label: "Rate (₹)", x: MARGIN_X + 300, w: 50, align: "right" },
        { label: "Disc", x: MARGIN_X + 350, w: 38, align: "right" },
        { label: "Taxable", x: MARGIN_X + 388, w: 52, align: "right" },
        { label: "GST %", x: MARGIN_X + 440, w: 38, align: "right" },
        { label: "Total (₹)", x: MARGIN_X + 478, w: CONTENT_W - 478, align: "right" },
      ];

      const TH_H = 18;
      pdf.rect(MARGIN_X, curY, CONTENT_W, TH_H).fillColor(C_TH_BG).fill();
      pdf.rect(MARGIN_X, curY, CONTENT_W, TH_H).strokeColor(C_BORDER).lineWidth(0.5).stroke();

      pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_DARK_GREEN);
      cols.forEach((col) => {
        pdf.text(col.label, col.x + 2, curY + 5, { width: col.w - 4, align: col.align });
      });
      curY += TH_H;

      const itemCount = Math.max(1, normalizedItems.length);
      const remainingForRows = availableTableH - TH_H;
      const targetRowH = Math.min(22, Math.max(13, Math.floor(remainingForRows / itemCount)));
      const isCompact = targetRowH < 17;
      const rowFontSize = isCompact ? 6.5 : 7.5;

      normalizedItems.forEach((it, idx) => {
        const rowY = curY;
        const isAlt = idx % 2 === 1;

        if (isAlt) {
          pdf.rect(MARGIN_X, rowY, CONTENT_W, targetRowH).fillColor(C_ROW_ALT).fill();
        }
        pdf.rect(MARGIN_X, rowY, CONTENT_W, targetRowH).strokeColor(C_BORDER).lineWidth(0.5).stroke();

        pdf.font("Helvetica").fontSize(rowFontSize).fillColor(C_TEXT);
        const padY = isCompact ? 2.5 : 4.5;

        // 1. Index
        pdf.text(String(idx + 1), cols[0].x + 1, rowY + padY, { width: cols[0].w - 2, align: cols[0].align });

        // 2. Name
        pdf.font("Helvetica-Bold").fontSize(rowFontSize).fillColor(C_TEXT);
        pdf.text(it.name, cols[1].x + 2, rowY + padY, { width: cols[1].w - 4, align: "left", lineBreak: false });

        // 3. HSN
        pdf.font("Helvetica").fontSize(rowFontSize).fillColor(C_MUTED);
        pdf.text(it.hsn, cols[2].x + 1, rowY + padY, { width: cols[2].w - 2, align: cols[2].align });

        // 4. Qty
        pdf.text(String(it.qty), cols[3].x + 1, rowY + padY, { width: cols[3].w - 2, align: cols[3].align });

        // 5. Unit
        pdf.text(it.unit ? it.unit.trim() : "pcs", cols[4].x + 1, rowY + padY, { width: cols[4].w - 2, align: cols[4].align });

        // 6. Rate
        pdf.text(Number(it.rate).toFixed(2), cols[5].x + 1, rowY + padY, { width: cols[5].w - 2, align: cols[5].align });

        // 7. Disc
        pdf.text(it.discount > 0 ? Number(it.discount).toFixed(2) : "-", cols[6].x + 1, rowY + padY, { width: cols[6].w - 2, align: cols[6].align });

        // 8. Taxable
        pdf.text(Number(it.taxable).toFixed(2), cols[7].x + 1, rowY + padY, { width: cols[7].w - 2, align: cols[7].align });

        // 9. GST %
        pdf.text(it.taxRate > 0 ? `${it.taxRate}%` : "-", cols[8].x + 1, rowY + padY, { width: cols[8].w - 2, align: cols[8].align });

        // 10. Amount
        pdf.font("Helvetica-Bold").fontSize(rowFontSize).fillColor(C_TEXT);
        pdf.text(Number(it.amount).toFixed(2), cols[9].x + 1, rowY + padY, { width: cols[9].w - 2, align: cols[9].align });

        curY += targetRowH;
      });

      // 6. SIDE-BY-SIDE LOWER SECTION
      const lowerY = Math.max(curY + 7, FOOTER_Y - LOWER_SECTION_H);
      const LEFT_W = 285;
      const RIGHT_X = MARGIN_X + 295;
      const RIGHT_W = CONTENT_W - 295; // 244.28 pt

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

      // --- LEFT SIDE: Amount in Words, Bank / Terms / Notes, or Quotation Acceptance ---
      let leftBlockY = lowerY;

      // Amount in Words Box
      pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 20).fillColor(C_TH_BG).fill();
      pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 20).strokeColor(C_BORDER).lineWidth(0.5).stroke();
      pdf.font("Helvetica-Bold").fontSize(6.5).fillColor(C_DARK_GREEN).text("AMOUNT IN WORDS:", MARGIN_X + 6, leftBlockY + 4, { width: LEFT_W - 12 });
      pdf.font("Helvetica").fontSize(7).fillColor(C_TEXT).text(amountInWordsINR(grandTotal), MARGIN_X + 6, leftBlockY + 11, { width: LEFT_W - 12, lineBreak: false });
      leftBlockY += 24;

      if (isQuotation) {
        // Quotation Terms / Notes / Acceptance Box
        const qTerms = (doc?.terms_and_conditions || doc?.terms || doc?.scope_of_work || "Standard business terms apply.").trim();
        pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("TERMS & CONDITIONS / SCOPE OF WORK", MARGIN_X, leftBlockY);
        leftBlockY = pdf.y + 1;
        pdf.font("Helvetica").fontSize(6).fillColor(C_MUTED).text(qTerms.substring(0, 160), MARGIN_X, leftBlockY, { width: LEFT_W });
        leftBlockY = pdf.y + 4;

        // Customer Acceptance Box
        pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 36).fillColor(C_WHITE).fill();
        pdf.rect(MARGIN_X, leftBlockY, LEFT_W, 36).strokeColor(C_BORDER).lineWidth(0.5).stroke();
        pdf.font("Helvetica-Bold").fontSize(6.5).fillColor(C_DARK_GREEN).text("CUSTOMER ACCEPTANCE (Sign & Date to confirm)", MARGIN_X + 6, leftBlockY + 3);
        pdf.font("Helvetica").fontSize(6.5).fillColor(C_MUTED).text("Name: _______________________________   Date: ______________", MARGIN_X + 6, leftBlockY + 14);
        pdf.font("Helvetica").fontSize(6.5).fillColor(C_MUTED).text("Signature: ____________________________", MARGIN_X + 6, leftBlockY + 24);
        leftBlockY += 40;
      } else {
        // Invoice Bank Details
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

        const terms = (doc?.terms_and_conditions || doc?.terms || company?.default_terms || "").trim();
        if (terms) {
          pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("TERMS & CONDITIONS", MARGIN_X, leftBlockY);
          leftBlockY = pdf.y + 1;
          pdf.font("Helvetica").fontSize(6).fillColor(C_MUTED).text(terms.substring(0, 180), MARGIN_X, leftBlockY, { width: LEFT_W });
          leftBlockY = pdf.y + 3;
        }

        const notes = (doc?.notes || doc?.customer_notes || company?.default_notes || "").trim();
        if (notes) {
          pdf.font("Helvetica-Bold").fontSize(7).fillColor(C_DARK_GREEN).text("NOTES", MARGIN_X, leftBlockY);
          leftBlockY = pdf.y + 1;
          pdf.font("Helvetica").fontSize(6).fillColor(C_MUTED).text(notes.substring(0, 140), MARGIN_X, leftBlockY, { width: LEFT_W });
          leftBlockY = pdf.y + 2;
        }
      }

      // --- RIGHT SIDE: Summary Box & Authorized Signatory ---
      let rightBlockY = lowerY;

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

      summaryItems.forEach((row) => {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text(row.label, RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(row.val, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 11;
      });

      // Total Amount Banner (Filled with C_GREEN #198754, white text)
      pdf.rect(RIGHT_X, rightBlockY, RIGHT_W, 20).fillColor(C_GREEN).fill();
      pdf.font("Helvetica-Bold").fontSize(8.5).fillColor(C_WHITE).text("TOTAL AMOUNT", RIGHT_X + 8, rightBlockY + 5);
      pdf.font("Helvetica-Bold").fontSize(10).fillColor(C_WHITE).text(`₹${grandTotal.toFixed(2)}`, RIGHT_X + 100, rightBlockY + 4, { width: RIGHT_W - 108, align: "right" });
      rightBlockY += 23;

      if (paidAmount !== null && paidAmount > 0) {
        pdf.font("Helvetica").fontSize(7.5).fillColor(C_MUTED).text("Amount Paid:", RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(7.5).fillColor(C_TEXT).text(`₹${paidAmount.toFixed(2)}`, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 10;
      }
      if (balanceAmount !== null) {
        pdf.font("Helvetica-Bold").fontSize(8).fillColor(C_TEXT).text("Balance Due:", RIGHT_X, rightBlockY, { width: 120 });
        pdf.font("Helvetica-Bold").fontSize(8).fillColor(C_TEXT).text(`₹${balanceAmount.toFixed(2)}`, RIGHT_X + 120, rightBlockY, { width: RIGHT_W - 120, align: "right" });
        rightBlockY += 12;
      }

      // Authorized Signatory Section
      rightBlockY += 3;
      pdf.font("Helvetica").fontSize(7.5).fillColor(C_TEXT).text(`For ${bizName}`, RIGHT_X, rightBlockY, { width: RIGHT_W, align: "right" });
      rightBlockY += 11;

      let sigDrawn = false;
      if (bizSig) {
        const drawn = drawImageIfExists(pdf, bizSig, RIGHT_X + RIGHT_W - 80, rightBlockY, { fit: [80, 24] });
        if (drawn) {
          sigDrawn = true;
          rightBlockY += 26;
        }
      }
      if (!sigDrawn) {
        rightBlockY += 16;
      }

      pdf.strokeColor(C_BORDER).lineWidth(0.5).moveTo(RIGHT_X + 60, rightBlockY).lineTo(RIGHT_X + RIGHT_W, rightBlockY).stroke();
      rightBlockY += 2;
      pdf.font("Helvetica").fontSize(6.5).fillColor(C_MUTED).text("Authorized Signatory", RIGHT_X, rightBlockY, { width: RIGHT_W, align: "right" });

      // 7. FOOTER
      pdf.font("Helvetica").fontSize(6.5).fillColor(C_MUTED).text("This is a computer-generated document.", MARGIN_X, FOOTER_Y, {
        width: CONTENT_W,
        align: "center",
      });

      pdf.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
};

const generateInvoicePdf = ({ doc, customer, items, company }) => {
  return renderSinglePageDocument({ doc, customer, items, company, docType: "invoice" });
};

const generateQuotationPdf = ({ doc, customer, items, company }) => {
  return renderSinglePageDocument({ doc, customer, items, company, docType: "quotation" });
};

/*
 * ============================================================
 * MONEY RECEIPT PDF
 * ============================================================
 */

const generateMoneyReceiptPdf = ({
  doc,
  customer,
  company,
  receipt,
}) => {
  return new Promise(
    (resolve, reject) => {
      try {
        const receiptData =
          receipt || doc || {};

        const receivedFromName =
          receiptData.received_from_name ||
          customer?.name ||
          "-";

        const receiptNumber =
          receiptData.receipt_number ||
          doc?.invoice_number ||
          "#MR-RECEIPT";

        const receiptDate =
          receiptData.receipt_date ||
          doc?.invoice_date ||
          new Date();

        const amount = Number(
          receiptData.amount_received ??
          doc?.total_amount ??
          0
        );

        const companyName =
          receiptData.from_business_name ||
          company?.business_name ||
          company?.company_name ||
          receiptData.from_name ||
          "Business";

        const companyAddress =
          [
            receiptData.from_address_line1,
            receiptData.from_address_line2,
            receiptData.from_city,
            receiptData.from_state,
            receiptData.from_pincode,
            receiptData.from_country ||
            "India",
          ]
            .filter(Boolean)
            .join(", ");

        const customerName =
          receiptData.received_from_name ||
          doc?.to_name ||
          customer?.display_name ||
          customer?.name ||
          "Customer";

        const purpose =
          receiptData.description ||
          receiptData.purpose ||
          "Payment received";

        const paymentMode =
          receiptData.payment_mode ||
          "cash";

        const transactionReference =
          receiptData.transaction_reference ||
          "";

        const logoPath =
          receiptData.from_logo_path ||
          company?.logo_path ||
          null;

        const signaturePath =
          receiptData.from_signature_path ||
          receiptData.signature_path ||
          company?.signature_path ||
          null;

        const bank =
          getBankDetails(
            receiptData
          );

        const outPath = path.join(
          UPLOAD_ROOT,
          "invoices",
          `${receiptNumber}.pdf`
        );

        fs.mkdirSync(
          path.dirname(outPath),
          {
            recursive: true,
          }
        );

        const pdf =
          new PDFDocument({
            size: [922, 520],
            margin: 0,
          });

        const stream =
          fs.createWriteStream(
            outPath
          );

        pdf.pipe(stream);

        /*
         * ----------------------------------------------------
         * OUTER BORDER
         * ----------------------------------------------------
         */

        pdf
          .save()
          .lineWidth(2)
          .strokeColor(GREEN)
          .rect(
            14,
            14,
            894,
            492
          )
          .stroke()
          .restore();

        /*
         * ----------------------------------------------------
         * HEADER
         * ----------------------------------------------------
         */

        drawImageIfExists(
          pdf,
          logoPath,
          34,
          30,
          {
            fit: [100, 65],
            align: "left",
            valign: "center",
          }
        );

        pdf
          .font("Helvetica-Bold")
          .fontSize(30)
          .fillColor(GREEN)
          .text(
            "MONEY RECEIPT",
            245,
            34,
            {
              width: 430,
              align: "center",
            }
          );

        pdf
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor(DARK_GREEN);

        const compNameHeight = pdf.heightOfString(companyName, {
          width: 250,
        });

        pdf.text(
          companyName,
          620,
          32,
          {
            width: 250,
            align: "right",
          }
        );

        const compAddressTop = Math.max(32 + compNameHeight + 3, 52);

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            companyAddress,
            620,
            compAddressTop,
            {
              width: 250,
              align: "right",
              height: Math.max(140 - compAddressTop, 20),
              ellipsis: true,
            }
          );

        /*
         * ----------------------------------------------------
         * RECEIPT NUMBER / DATE
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(DARK_GREEN)
          .text(
            "NO.",
            34,
            117
          );

        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(TEXT)
          .text(
            receiptNumber,
            70,
            117
          );

        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(
            "Date",
            690,
            117
          );

        pdf
          .font("Helvetica")
          .fontSize(10)
          .text(
            formatDate(
              receiptDate
            ),
            730,
            117
          );

        pdf
          .moveTo(30, 143)
          .lineTo(892, 143)
          .lineWidth(3)
          .strokeColor(GREEN)
          .stroke();

        /*
         * ----------------------------------------------------
         * RECEIVED FROM
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(DARK_GREEN)
          .text("Received with thanks from:", 34, 315);

        pdf
          .font("Helvetica")
          .fontSize(11)
          .fillColor(TEXT)
          .text(receivedFromName || "-", 180, 315, {
            width: 330,
            ellipsis: true,
          });

        /*
         * ----------------------------------------------------
         * AMOUNT
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor(DARK_GREEN)
          .text(
            "Amount",
            34,
            207
          );

        pdf
          .font("Helvetica")
          .fontSize(11)
          .fillColor(TEXT)
          .text(
            money(amount),
            180,
            207
          );

        /*
         * ----------------------------------------------------
         * WORDS
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor(DARK_GREEN)
          .text(
            "In words",
            34,
            244
          );

        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(TEXT)
          .text(
            amountInWordsINR(
              amount
            ),
            180,
            244,
            {
              width: 775,
              ellipsis: true,
            }
          );

        /*
         * ----------------------------------------------------
         * PURPOSE / PAYMENT MODE
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor(DARK_GREEN)
          .text(
            "For",
            34,
            281
          );

        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(TEXT)
          .text(
            purpose,
            180,
            281,
            {
              width: 370,
              ellipsis: true,
            }
          );

        pdf
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(DARK_GREEN)
          .text("Payment Mode:", 495, 281, {
            width: 75,
          });

        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(TEXT)
          .text(String(paymentMode).toUpperCase(), 575, 281, {
            width: 120,
            ellipsis: true,
          });

        /*
         * ----------------------------------------------------
         * AMOUNT BOX
         * ----------------------------------------------------
         */

        pdf
          .roundedRect(
            34,
            362,
            405,
            75,
            10
          )
          .fillColor(LIGHT_GREEN)
          .fill();

        pdf
          .roundedRect(
            70,
            374,
            335,
            50,
            8
          )
          .fillColor(WHITE)
          .strokeColor(GREEN)
          .lineWidth(1.2)
          .fillAndStroke();

        pdf
          .font("Helvetica-Bold")
          .fontSize(15)
          .fillColor(DARK_GREEN)
          .text(
            "Amount =  Rs.  " +
              Number(amount).toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            92,
            390,
            {
              width: 290,
              height: 20,
              align: "left",
            }
          );

        /*
         * ----------------------------------------------------
         * BANK DETAILS
         * ----------------------------------------------------
         */

        if (
          bank.bankName ||
          bank.accountNumber ||
          bank.ifsc
        ) {
          pdf
            .font("Helvetica-Bold")
            .fontSize(8)
            .fillColor(DARK_GREEN)
            .text(
              "Bank:",
              495,
              330
            );

          pdf
            .font("Helvetica")
            .fontSize(8)
            .fillColor(TEXT)
            .text(
              bank.bankName ||
              "",
              575,
              330,
              {
                width: 280,
              }
            );

          if (bank.accountNumber) {
            pdf
              .font("Helvetica-Bold")
              .text(
                "A/c No:",
                495,
                345
              );

            pdf
              .font("Helvetica")
              .text(
                bank.accountNumber,
                575,
                345
              );
          }

          if (bank.ifsc) {
            pdf
              .font("Helvetica-Bold")
              .text(
                "IFSC:",
                495,
                360
              );

            pdf
              .font("Helvetica")
              .text(
                bank.ifsc,
                575,
                360
              );
          }
        }

        /*
         * ----------------------------------------------------
         * TRANSACTION REFERENCE
         * ----------------------------------------------------
         */

        if (
          transactionReference
        ) {
          pdf
            .font("Helvetica")
            .fontSize(8)
            .fillColor(MUTED)
            .text(
              `Reference: ${transactionReference}`,
              34,
              448,
              {
                width: 600,
                ellipsis: true,
              }
            );
        }

        /*
         * ----------------------------------------------------
         * SIGNATURE
         * ----------------------------------------------------
         */

        if (signaturePath) {
          drawImageIfExists(
            pdf,
            signaturePath,
            675,
            378,
            {
              fit: [175, 55],
              align: "center",
              valign: "center",
            }
          );
        }

        pdf
          .moveTo(675, 444)
          .lineTo(885, 444)
          .lineWidth(1)
          .strokeColor(GREEN)
          .stroke();

        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(DARK_GREEN)
          .text(
            "Authorized Signature",
            675,
            451,
            {
              width: 210,
              align: "center",
            }
          );

        /*
         * ----------------------------------------------------
         * FOOTER
         * ----------------------------------------------------
         */

        const isWatermarkEnabled = resolveWatermarkEnabled(receiptData, company);

        if (isWatermarkEnabled) {
          pdf
            .font("Helvetica")
            .fontSize(7.5)
            .fillColor(MUTED)
            .text(
              "Thank you for your business.",
              34,
              476,
              {
                width: 854,
                align: "center",
              }
            );

          drawKhataNexWatermark(pdf, 461, 491);
        } else {
          pdf
            .font("Helvetica")
            .fontSize(7.5)
            .fillColor(MUTED)
            .text(
              "Thank you for your business.",
              34,
              484,
              {
                width: 854,
                align: "center",
              }
            );
        }

        pdf.end();

        stream.on(
          "finish",
          () => resolve(outPath)
        );

        stream.on(
          "error",
          reject
        );
      } catch (error) {
        reject(error);
      }
    }
  );
};

/*
 * ============================================================
 * MAIN DOCUMENT ROUTER
 * ============================================================
 */

const generateDocumentPdf = ({
  doc,
  customer,
  items,
  company,
  receipt,
}) => {
  if (
    doc?.doc_type ===
    "money_receipt"
  ) {
    return generateMoneyReceiptPdf({
      doc,
      customer,
      company,
      receipt,
    });
  }

  if (
    doc?.doc_type ===
    "quotation"
  ) {
    return generateQuotationPdf({
      doc,
      customer,
      items,
      company,
    });
  }

  return generateInvoicePdf({
    doc,
    customer,
    items,
    company,
  });
};

/*
 * ============================================================
 * EXPORT
 * ============================================================
 */

module.exports = {
  generateDocumentPdf,
  generateInvoicePdf,
  generateQuotationPdf,
  renderSinglePageDocument,
  resolveWatermarkEnabled,
};