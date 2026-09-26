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
    pdf.image(
      absolutePath,
      x,
      y,
      options
    );

    return true;
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

      const bank = getBankDetails(doc);

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
        margin: 36,
        autoFirstPage: true,
      });

      const stream = fs.createWriteStream(outPath);

      pdf.pipe(stream);

      const PAGE_LEFT = 36;
      const PAGE_RIGHT = 559;
      const PAGE_TOP = 36;
      const PAGE_BOTTOM = 806;
      const CONTENT_WIDTH = PAGE_RIGHT - PAGE_LEFT;

      const GREEN = "#16A34A";
      const DARK_GREEN = "#166534";
      const LIGHT_GREEN = "#F0FDF4";
      const BORDER = "#D1D5DB";
      const TEXT = "#111827";
      const MUTED = "#6B7280";
      const WHITE = "#FFFFFF";

      const placeOfSupply =
        doc?.place_of_supply ||
        doc?.place_of_supply_state ||
        doc?.to_billing_state ||
        "";

      const fromPan = doc?.from_pan || company?.pan || "";
      const toPan = doc?.to_pan || customer?.pan || "";

      /*
       * ----------------------------------------------------
       * PAGE HEADER / FOOTER
       * ----------------------------------------------------
       */

      const drawFooter = () => {
        const footerY = PAGE_BOTTOM - 24;

        pdf
          .moveTo(PAGE_LEFT, footerY - 8)
          .lineTo(PAGE_RIGHT, footerY - 8)
          .lineWidth(0.6)
          .strokeColor(BORDER)
          .stroke();

        const footerText = [
          companyName,
          companyAddress,
          doc?.from_phone,
          doc?.from_email,
          doc?.from_website,
        ]
          .filter(Boolean)
          .join("  |  ");

        pdf
          .font("Helvetica")
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(
            footerText,
            PAGE_LEFT,
            footerY,
            {
              width: CONTENT_WIDTH,
              align: "center",
              lineBreak: false,
              ellipsis: true,
            }
          );
      };

      const drawPageHeader = () => {
        pdf
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            invoiceNumber,
            PAGE_LEFT,
            PAGE_TOP - 4
          );

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            "TAX INVOICE",
            450,
            PAGE_TOP - 4,
            {
              width: 109,
              align: "right",
            }
          );
      };

      /*
       * ----------------------------------------------------
       * TOP HEADER
       * ----------------------------------------------------
       */

      let y = 42;

      const logoDrawn = drawImageIfExists(
        pdf,
        logoPath,
        PAGE_LEFT,
        y,
        {
          fit: [105, 55],
          align: "left",
          valign: "center",
        }
      );

      const companyTextX =
        logoDrawn ? 155 : PAGE_LEFT;

      pdf
        .font("Helvetica-Bold")
        .fontSize(16)
        .fillColor(DARK_GREEN)
        .text(
          companyName,
          companyTextX,
          y + 2,
          {
            width: 245,
            lineBreak: false,
            ellipsis: true,
          }
        );

      if (doc?.from_website) {
        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            doc.from_website,
            companyTextX,
            y + 22,
            {
              width: 245,
              lineBreak: false,
              ellipsis: true,
            }
          );
      }

      pdf
        .font("Helvetica-Bold")
        .fontSize(19)
        .fillColor(TEXT)
        .text(
          "TAX INVOICE",
          390,
          y + 1,
          {
            width: 169,
            align: "right",
          }
        );

      pdf
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(
          `Invoice No: ${invoiceNumber}`,
          390,
          y + 27,
          {
            width: 169,
            align: "right",
          }
        )
        .text(
          `Date: ${formatDate(doc?.invoice_date)}`,
          390,
          y + 41,
          {
            width: 169,
            align: "right",
          }
        );

      if (placeOfSupply) {
        pdf.text(
          `Place of Supply: ${placeOfSupply}`,
          390,
          y + 55,
          {
            width: 169,
            align: "right",
          }
        );
      }

      y = 116;

      pdf
        .moveTo(PAGE_LEFT, y)
        .lineTo(PAGE_RIGHT, y)
        .lineWidth(1.5)
        .strokeColor(GREEN)
        .stroke();

      /*
       * ----------------------------------------------------
       * FROM / BILL TO
       * ----------------------------------------------------
       */

      y += 18;

      const detailsTop = y;
      const detailsGap = 14;
      const detailsWidth = (CONTENT_WIDTH - detailsGap) / 2;
      const leftX = PAGE_LEFT;
      const rightX = PAGE_LEFT + detailsWidth + detailsGap;

      const drawDetailBox = ({
        x,
        title,
        name,
        details,
      }) => {
        const boxTop = detailsTop;
        const padding = 10;
        const titleHeight = 14;
        const nameHeight = 16;
        const detailFontSize = 8;
        const detailLineGap = 3;
        const innerWidth = detailsWidth - padding * 2;

        let contentHeight =
          titleHeight +
          nameHeight +
          5;

        details.forEach((line) => {
          if (!line) return;

          contentHeight +=
            pdf.heightOfString(String(line), {
              width: innerWidth,
              font: "Helvetica",
              fontSize: detailFontSize,
              lineGap: 1,
            }) +
            detailLineGap;
        });

        const boxHeight = Math.max(
          92,
          contentHeight + padding * 2
        );

        pdf
          .roundedRect(
            x,
            boxTop,
            detailsWidth,
            boxHeight,
            5
          )
          .lineWidth(0.7)
          .strokeColor(BORDER)
          .stroke();

        pdf
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor(DARK_GREEN)
          .text(
            title,
            x + padding,
            boxTop + padding,
            {
              width: innerWidth,
              lineBreak: false,
            }
          );

        pdf
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(TEXT)
          .text(
            name || "-",
            x + padding,
            boxTop + padding + titleHeight + 2,
            {
              width: innerWidth,
              lineBreak: false,
              ellipsis: true,
            }
          );

        let detailY =
          boxTop +
          padding +
          titleHeight +
          nameHeight +
          7;

        details.forEach((line) => {
          if (!line) return;

          const lineHeight =
            pdf.heightOfString(String(line), {
              width: innerWidth,
              font: "Helvetica",
              fontSize: detailFontSize,
              lineGap: 1,
            });

          pdf
            .font("Helvetica")
            .fontSize(detailFontSize)
            .fillColor(TEXT)
            .text(
              String(line),
              x + padding,
              detailY,
              {
                width: innerWidth,
                lineGap: 1,
              }
            );

          detailY +=
            lineHeight +
            detailLineGap;
        });

        return boxHeight;
      };

      const fromDetails = [
        companyAddress,
        doc?.from_gstin
          ? `GSTIN: ${doc.from_gstin}`
          : null,
        fromPan
          ? `PAN: ${fromPan}`
          : null,
        doc?.from_phone
          ? `Mobile: ${doc.from_phone}`
          : null,
        doc?.from_email
          ? `Email: ${doc.from_email}`
          : null,
      ].filter(Boolean);

      const customerDetails = [
        customerBusiness,
        customerAddress,
        doc?.to_gstin || customer?.gstin
          ? `GSTIN: ${
              doc?.to_gstin ||
              customer?.gstin
            }`
          : null,
        toPan
          ? `PAN: ${toPan}`
          : null,
        doc?.to_phone || customer?.phone
          ? `Mobile: ${
              doc?.to_phone ||
              customer?.phone
            }`
          : null,
        doc?.to_email || customer?.email
          ? `Email: ${
              doc?.to_email ||
              customer?.email
            }`
          : null,
      ].filter(Boolean);

      const fromBoxHeight = drawDetailBox({
        x: leftX,
        title: "FROM",
        name: companyName,
        details: fromDetails,
      });

      const billToBoxHeight = drawDetailBox({
        x: rightX,
        title: "BILL TO",
        name: customerName,
        details: customerDetails,
      });

      y =
        detailsTop +
        Math.max(
          fromBoxHeight,
          billToBoxHeight
        ) +
        16;

      /*
       * ----------------------------------------------------
       * ITEMS TABLE
       * ----------------------------------------------------
       */

      const tableX = PAGE_LEFT;
      const tableWidth = CONTENT_WIDTH;

      /*
       * Fixed column geometry.
       * Header and every value use these exact
       * same x positions and widths.
       */
      const columns = [
        {
          label: "SL",
          width: 27,
          align: "center",
        },
        {
          label: "Description",
          width: 142,
          align: "left",
        },
        {
          label: "HSN/SAC",
          width: 55,
          align: "center",
        },
        {
          label: "Qty",
          width: 38,
          align: "center",
        },
        {
          label: "Rate",
          width: 60,
          align: "right",
        },
        {
          label: "Taxable Value",
          width: 78,
          align: "right",
        },
        {
          label: "GST %",
          width: 48,
          align: "center",
        },
        {
          label: "Amount",
          width: 75,
          align: "right",
        },
      ];

      const columnTotal =
        columns.reduce(
          (sum, column) => sum + column.width,
          0
        );

      if (columnTotal !== tableWidth) {
        throw new Error(
          `Invoice table columns total ${columnTotal}, expected ${tableWidth}.`
        );
      }

      const headerHeight = 30;
      const rowHeight = 28;

      const drawColumnLines = (top, bottom) => {
        let x = tableX;

        pdf
          .moveTo(tableX, top)
          .lineTo(tableX, bottom)
          .lineWidth(0.5)
          .strokeColor(BORDER)
          .stroke();

        columns.forEach((column) => {
          x += column.width;

          pdf
            .moveTo(x, top)
            .lineTo(x, bottom)
            .lineWidth(0.5)
            .strokeColor(BORDER)
            .stroke();
        });
      };

      const drawTableHeader = () => {
        const headerTop = y;

        pdf
          .rect(
            tableX,
            headerTop,
            tableWidth,
            headerHeight
          )
          .fill(GREEN);

        let x = tableX;

        columns.forEach((column) => {
          pdf
            .font("Helvetica-Bold")
            .fontSize(7.2)
            .fillColor(WHITE)
            .text(
              column.label,
              x + 3,
              headerTop + 10,
              {
                width: column.width - 6,
                height: headerHeight - 10,
                align: column.align,
                lineBreak: false,
                ellipsis: true,
              }
            );

          x += column.width;
        });

        y += headerHeight;
      };

      drawTableHeader();

      const safeItems =
        Array.isArray(items) ? items : [];

      safeItems.forEach(
        (item, index) => {
          if (y + rowHeight > PAGE_BOTTOM - 80) {
            drawFooter();

            pdf.addPage({
              size: "A4",
              margin: 36,
            });

            drawPageHeader();

            y = 55;

            drawTableHeader();
          }

          const quantity =
            Number(item.quantity || 1);

          const rate =
            Number(item.price || 0);

          const itemAmount =
            Number(
              item.amount ??
              quantity * rate
            );

          const itemDiscount =
            Number(
              item.discount_amount || 0
            );

          const taxableValue =
            Number(
              item.taxable_amount ??
              item.taxable_value ??
              itemAmount - itemDiscount
            );

          const invoiceGstRate =
            Number(doc?.cgst_rate || 0) +
            Number(doc?.sgst_rate || 0) +
            Number(doc?.igst_rate || 0);

          const gstRate =
            Number(item.tax_rate || 0) ||
            invoiceGstRate;

          const lineAmount =
            Number(
              item.line_total ??
              taxableValue
            );

          if (index % 2 === 0) {
            pdf
              .rect(
                tableX,
                y,
                tableWidth,
                rowHeight
              )
              .fill(LIGHT_GREEN);
          }

          const cells = [
            String(index + 1),
            item.product_name ||
              item.description ||
              "Item",
            item.hsn_code ||
              item.hsn ||
              "-",
            String(quantity),
            money(rate),
            money(taxableValue),
            `${gstRate}%`,
            money(lineAmount),
          ];

          let x = tableX;

          columns.forEach(
            (column, cellIndex) => {
              const fontSize =
                cellIndex === 1
                  ? 7.2
                  : 7.5;

              const textY =
                y +
                Math.max(
                  7,
                  (rowHeight - fontSize) / 2 - 1
                );

              pdf
                .font("Helvetica")
                .fontSize(fontSize)
                .fillColor(TEXT)
                .text(
                  cells[cellIndex],
                  x + 4,
                  textY,
                  {
                    width: column.width - 8,
                    height: rowHeight - 8,
                    align: column.align,
                    lineBreak: false,
                    ellipsis: true,
                  }
                );

              x += column.width;
            }
          );

          pdf
            .moveTo(
              tableX,
              y + rowHeight
            )
            .lineTo(
              tableX + tableWidth,
              y + rowHeight
            )
            .lineWidth(0.4)
            .strokeColor(BORDER)
            .stroke();

          y += rowHeight;
        }
      );

      drawColumnLines(
        y -
          safeItems.length *
            rowHeight -
          headerHeight,
        y
      );

      pdf
        .moveTo(tableX, y)
        .lineTo(
          tableX + tableWidth,
          y
        )
        .lineWidth(0.7)
        .strokeColor(BORDER)
        .stroke();

      y += 18;

      /*
       * ----------------------------------------------------
       * SUMMARY / TAX BOX
       * ----------------------------------------------------
       */

      const summaryStartY = y;

      const leftSummaryWidth = 285;
      const rightSummaryX = 360;
      const rightSummaryWidth = 199;

      /*
       * Amount in words
       */

      pdf
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .fillColor(DARK_GREEN)
        .text(
          "Amount in Words",
          PAGE_LEFT,
          summaryStartY
        );

      const total =
        Number(
          doc?.total_amount || 0
        );

      pdf
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(TEXT)
        .text(
          amountInWordsINR(total),
          PAGE_LEFT,
          summaryStartY + 15,
          {
            width: leftSummaryWidth,
          }
        );

      /*
       * Tax summary
       */

      let summaryY = summaryStartY;

      const summaryRow = (
        label,
        value,
        negative = false
      ) => {
        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(TEXT)
          .text(
            label,
            rightSummaryX,
            summaryY,
            {
              width: 115,
            }
          )
          .text(
            `${negative ? "-" : ""}${money(
              Math.abs(Number(value || 0))
            )}`,
            rightSummaryX + 115,
            summaryY,
            {
              width: 84,
              align: "right",
            }
          );

        summaryY += 15;
      };

      summaryRow(
        "Subtotal",
        doc?.subtotal
      );

      if (
        Number(doc?.discount_amount || 0) >
        0
      ) {
        summaryRow(
          "Discount",
          doc.discount_amount,
          true
        );
      }

      if (
        Number(doc?.cgst_amount || 0) >
        0
      ) {
        summaryRow(
          `CGST (${doc?.cgst_rate || 0}%)`,
          doc.cgst_amount
        );
      }

      if (
        Number(doc?.sgst_amount || 0) >
        0
      ) {
        summaryRow(
          `SGST (${doc?.sgst_rate || 0}%)`,
          doc.sgst_amount
        );
      }

      if (
        Number(doc?.igst_amount || 0) >
        0
      ) {
        summaryRow(
          `IGST (${doc?.igst_rate || 0}%)`,
          doc.igst_amount
        );
      }

      if (
        Number(doc?.tcs_amount || 0) >
        0
      ) {
        summaryRow(
          `TCS (${doc?.tcs_rate || 0}%)`,
          doc.tcs_amount
        );
      }

      if (
        Number(doc?.tds_amount || 0) >
        0
      ) {
        summaryRow(
          `TDS (${doc?.tds_rate || 0}%)`,
          doc.tds_amount,
          true
        );
      }

      if (
        Number(doc?.round_off || 0) !== 0
      ) {
        summaryRow(
          "Round Off",
          doc.round_off
        );
      }

      summaryY += 3;

      pdf
        .rect(
          rightSummaryX,
          summaryY,
          rightSummaryWidth,
          32
        )
        .fill(GREEN);

      pdf
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .fillColor(WHITE)
        .text(
          "GRAND TOTAL",
          rightSummaryX + 10,
          summaryY + 10
        )
        .text(
          money(total),
          rightSummaryX + 105,
          summaryY + 10,
          {
            width: 84,
            align: "right",
          }
        );

      y =
        Math.max(
          summaryY + 45,
          summaryStartY + 55
        );

      /*
       * ----------------------------------------------------
       * BANK + NOTES + TERMS
       * ----------------------------------------------------
       */

      const bankLines = [
        bank.bankName
          ? `Bank: ${bank.bankName}`
          : null,
        bank.branch
          ? `Branch: ${bank.branch}`
          : null,
        bank.holder
          ? `A/c Holder: ${bank.holder}`
          : null,
        bank.accountNumber
          ? `A/c No: ${bank.accountNumber}`
          : null,
        bank.accountType
          ? `Type: ${bank.accountType}`
          : null,
        bank.ifsc
          ? `IFSC: ${bank.ifsc}`
          : null,
      ].filter(Boolean);

      const notes =
        doc?.notes || "";

      const terms =
        doc?.terms_conditions || "";

      const hasBank =
        bankLines.length > 0;

      /*
       * If lower content would run into footer,
       * start a fresh page.
       */

      const estimatedLowerHeight =
        (hasBank ? 75 : 0) +
        (notes ? 55 : 0) +
        (terms ? 65 : 0) +
        90;

      if (
        y + estimatedLowerHeight >
        PAGE_BOTTOM - 5
      ) {
        drawFooter();
        pdf.addPage({
          size: "A4",
          margin: 36,
        });
        drawPageHeader();
        y = 65;
      }

      /*
       * BANK
       */

      if (hasBank) {
        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text(
            "BANK / PAYMENT DETAILS",
            PAGE_LEFT,
            y
          );

        y += 15;

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(TEXT)
          .text(
            bankLines.join("   |   "),
            PAGE_LEFT,
            y,
            {
              width: CONTENT_WIDTH,
            }
          );

        y += 30;
      }

      /*
       * NOTES
       */

      if (notes) {
        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text(
            "Notes",
            PAGE_LEFT,
            y
          );

        y += 14;

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(TEXT)
          .text(
            notes,
            PAGE_LEFT,
            y,
            {
              width: CONTENT_WIDTH,
            }
          );

        y += Math.max(
          28,
          pdf.heightOfString(
            notes,
            {
              width: CONTENT_WIDTH,
            }
          ) + 10
        );
      }

      /*
       * TERMS
       */

      if (terms) {
        if (
          y + 65 >
          PAGE_BOTTOM - 95
        ) {
          drawFooter();
          pdf.addPage({
            size: "A4",
            margin: 36,
          });
          drawPageHeader();
          y = 65;
        }

        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text(
            "Terms & Conditions",
            PAGE_LEFT,
            y
          );

        y += 14;

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(TEXT)
          .text(
            terms,
            PAGE_LEFT,
            y,
            {
              width: CONTENT_WIDTH,
            }
          );

        y += Math.max(
          28,
          pdf.heightOfString(
            terms,
            {
              width: CONTENT_WIDTH,
            }
          ) + 10
        );
      }

      /*
       * ----------------------------------------------------
       * SIGNATURE
       * ----------------------------------------------------
       */

      const signatureY =
        Math.min(
          Math.max(y + 10, 675),
          PAGE_BOTTOM - 75
        );

      if (signaturePath) {
        drawImageIfExists(
          pdf,
          signaturePath,
          415,
          signatureY,
          {
            fit: [105, 45],
            align: "center",
            valign: "center",
          }
        );
      }

      pdf
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(TEXT)
        .text(
          "Authorized Signature",
          395,
          signatureY + 52,
          {
            width: 140,
            align: "center",
          }
        );

      pdf
        .moveTo(395, signatureY + 48)
        .lineTo(535, signatureY + 48)
        .lineWidth(0.6)
        .strokeColor(BORDER)
        .stroke();

      /*
       * ----------------------------------------------------
       * FOOTER
       * ----------------------------------------------------
       */

      drawFooter();

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
  });
};


const generateQuotationPdf = ({
  doc,
  customer,
  items,
  company,
}) => {
  return new Promise(
    (resolve, reject) => {
      try {
        const quotationNumber =
          doc?.invoice_number ||
          "#QT-QUOTATION";

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
            .join(", ");

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
            .join(", ");

        const logoPath =
          doc?.from_logo_path ||
          company?.logo_path ||
          null;

        const signaturePath =
          doc?.from_signature_path ||
          company?.signature_path ||
          null;

        const bank =
          getBankDetails(doc);

        const outPath = path.join(
          UPLOAD_ROOT,
          "invoices",
          `${quotationNumber}.pdf`
        );

        fs.mkdirSync(
          path.dirname(outPath),
          {
            recursive: true,
          }
        );

        const pdf =
          new PDFDocument({
            size: "A4",
            margin: 40,
          });

        const stream =
          fs.createWriteStream(
            outPath
          );

        pdf.pipe(stream);

        /*
         * ----------------------------------------------------
         * HEADER
         * ----------------------------------------------------
         */

        drawImageIfExists(
          pdf,
          logoPath,
          40,
          38,
          {
            fit: [85, 60],
            align: "left",
            valign: "center",
          }
        );

        pdf
          .font("Helvetica-Bold")
          .fontSize(20)
          .fillColor(TEXT)
          .text(
            companyName,
            135,
            42,
            {
              width: 275,
            }
          );

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            companyAddress || "",
            135,
            68,
            {
              width: 275,
            }
          );

        if (doc?.from_phone) {
          pdf.text(
            `Phone: ${doc.from_phone}`,
            135,
            88
          );
        }

        if (doc?.from_email) {
          pdf.text(
            `Email: ${doc.from_email}`,
            135,
            101
          );
        }

        pdf
          .font("Helvetica-Bold")
          .fontSize(26)
          .fillColor(GREEN)
          .text(
            "QUOTATION",
            390,
            43,
            {
              width: 165,
              align: "right",
            }
          );

        pdf
          .font("Helvetica")
          .fontSize(9)
          .fillColor(TEXT)
          .text(
            `No: ${quotationNumber}`,
            390,
            80,
            {
              width: 165,
              align: "right",
            }
          )
          .text(
            `Date: ${formatDate(
              doc?.invoice_date
            )}`,
            390,
            95,
            {
              width: 165,
              align: "right",
            }
          );

        pdf
          .moveTo(40, 130)
          .lineTo(555, 130)
          .lineWidth(2)
          .strokeColor(GREEN)
          .stroke();

        /*
         * ----------------------------------------------------
         * CUSTOMER
         * ----------------------------------------------------
         */

        pdf
          .roundedRect(
            40,
            150,
            515,
            90,
            7
          )
          .fillColor(
            LIGHT_GREEN
          )
          .fill();

        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text(
            "QUOTED TO",
            55,
            166
          );

        pdf
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor(TEXT)
          .text(
            customerName,
            55,
            184
          );

        if (customerBusiness) {
          pdf
            .font("Helvetica")
            .fontSize(9)
            .text(
              customerBusiness,
              55,
              202
            );
        }

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            customerAddress || "",
            55,
            218,
            {
              width: 275,
            }
          );

        if (
          doc?.to_phone ||
          customer?.phone
        ) {
          pdf.text(
            `Phone: ${doc?.to_phone ||
            customer?.phone
            }`,
            350,
            184
          );
        }

        if (
          doc?.to_email ||
          customer?.email
        ) {
          pdf.text(
            `Email: ${doc?.to_email ||
            customer?.email
            }`,
            350,
            201,
            {
              width: 190,
            }
          );
        }

        if (
          doc?.to_gstin ||
          customer?.gstin
        ) {
          pdf.text(
            `GSTIN: ${doc?.to_gstin ||
            customer?.gstin
            }`,
            350,
            218
          );
        }

        /*
         * ----------------------------------------------------
         * ITEMS
         * ----------------------------------------------------
         */

        let y = 265;

        pdf
          .rect(
            40,
            y,
            515,
            28
          )
          .fill(GREEN);

        pdf
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor(WHITE)
          .text(
            "#",
            48,
            y + 9
          )
          .text(
            "DESCRIPTION",
            75,
            y + 9,
            {
              width: 225,
            }
          )
          .text(
            "QTY",
            315,
            y + 9,
            {
              width: 40,
              align: "center",
            }
          )
          .text(
            "RATE",
            365,
            y + 9,
            {
              width: 85,
              align: "right",
            }
          )
          .text(
            "AMOUNT",
            465,
            y + 9,
            {
              width: 85,
              align: "right",
            }
          );

        y += 28;

        let subtotal = 0;

        (
          items || []
        ).forEach(
          (item, index) => {
            const amount =
              Number(
                item.line_total ??
                item.amount ??
                Number(
                  item.quantity || 1
                ) *
                Number(
                  item.price || 0
                )
              );

            subtotal += amount;

            if (
              index % 2 === 0
            ) {
              pdf
                .rect(
                  40,
                  y,
                  515,
                  28
                )
                .fill(
                  ROW_GREEN
                );
            }

            pdf
              .font("Helvetica")
              .fontSize(8.5)
              .fillColor(TEXT)
              .text(
                index + 1,
                48,
                y + 9
              )
              .text(
                item.product_name ||
                "Item",
                75,
                y + 9,
                {
                  width: 225,
                  ellipsis: true,
                }
              )
              .text(
                item.quantity || 1,
                315,
                y + 9,
                {
                  width: 40,
                  align: "center",
                }
              )
              .text(
                money(item.price),
                365,
                y + 9,
                {
                  width: 85,
                  align: "right",
                }
              )
              .text(
                money(amount),
                465,
                y + 9,
                {
                  width: 85,
                  align: "right",
                }
              );

            y += 28;
          }
        );

        /*
         * ----------------------------------------------------
         * TOTALS
         * ----------------------------------------------------
         */

        y += 15;

        const discount = Number(
          doc?.discount_amount || 0
        );

        const total = Number(
          doc?.total_amount ??
          subtotal - discount
        );

        pdf
          .font("Helvetica")
          .fontSize(9)
          .fillColor(TEXT)
          .text(
            "Subtotal",
            370,
            y
          )
          .text(
            money(subtotal),
            455,
            y,
            {
              width: 90,
              align: "right",
            }
          );

        y += 17;

        if (discount > 0) {
          pdf
            .text(
              "Discount",
              370,
              y
            )
            .text(
              `-${money(discount)}`,
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.cgst_amount || 0
          ) > 0
        ) {
          pdf
            .text(
              `CGST (${doc.cgst_rate || 0
              }%)`,
              370,
              y
            )
            .text(
              money(
                doc.cgst_amount
              ),
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.sgst_amount || 0
          ) > 0
        ) {
          pdf
            .text(
              `SGST (${doc.sgst_rate || 0
              }%)`,
              370,
              y
            )
            .text(
              money(
                doc.sgst_amount
              ),
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.igst_amount || 0
          ) > 0
        ) {
          pdf
            .text(
              `IGST (${doc.igst_rate || 0
              }%)`,
              370,
              y
            )
            .text(
              money(
                doc.igst_amount
              ),
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.tcs_amount || 0
          ) > 0
        ) {
          pdf
            .text(
              `TCS (${doc.tcs_rate || 0
              }%)`,
              370,
              y
            )
            .text(
              money(
                doc.tcs_amount
              ),
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.tds_amount || 0
          ) > 0
        ) {
          pdf
            .text(
              `TDS (${doc.tds_rate || 0
              }%)`,
              370,
              y
            )
            .text(
              `-${money(
                doc.tds_amount
              )}`,
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        if (
          Number(
            doc?.round_off || 0
          ) !== 0
        ) {
          pdf
            .text(
              "Round Off",
              370,
              y
            )
            .text(
              money(
                doc.round_off
              ),
              455,
              y,
              {
                width: 90,
                align: "right",
              }
            );

          y += 17;
        }

        pdf
          .roundedRect(
            350,
            y + 8,
            205,
            38,
            6
          )
          .fillColor(GREEN)
          .fill();

        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(WHITE)
          .text(
            "TOTAL",
            365,
            y + 21
          )
          .text(
            money(total),
            455,
            y + 21,
            {
              width: 90,
              align: "right",
            }
          );

        y += 65;

        /*
         * ----------------------------------------------------
         * AMOUNT IN WORDS
         * ----------------------------------------------------
         */

        pdf
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor(DARK_GREEN)
          .text(
            "AMOUNT IN WORDS",
            40,
            y
          );

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(TEXT)
          .text(
            amountInWordsINR(
              total
            ),
            40,
            y + 14,
            {
              width: 515,
            }
          );

        y += 42;

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
            .roundedRect(
              40,
              y,
              515,
              55,
              6
            )
            .fillColor(
              LIGHT_GREEN
            )
            .fill();

          pdf
            .font("Helvetica-Bold")
            .fontSize(8.5)
            .fillColor(DARK_GREEN)
            .text(
              "BANK DETAILS",
              55,
              y + 10
            );

          const bankText = [
            bank.bankName
              ? `Bank: ${bank.bankName}`
              : null,

            bank.branch
              ? `Branch: ${bank.branch}`
              : null,

            bank.holder
              ? `A/c Holder: ${bank.holder}`
              : null,

            bank.accountNumber
              ? `A/c No: ${bank.accountNumber}`
              : null,

            bank.accountType
              ? `Type: ${bank.accountType}`
              : null,

            bank.ifsc
              ? `IFSC: ${bank.ifsc}`
              : null,
          ]
            .filter(Boolean)
            .join("   |   ");

          pdf
            .font("Helvetica")
            .fontSize(7.5)
            .fillColor(TEXT)
            .text(
              bankText,
              55,
              y + 27,
              {
                width: 485,
              }
            );

          y += 70;
        }

        /*
         * ----------------------------------------------------
         * TERMS
         * ----------------------------------------------------
         */

        pdf
          .roundedRect(
            40,
            y,
            515,
            68,
            6
          )
          .fillColor(
            LIGHT_GREEN
          )
          .fill();

        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(DARK_GREEN)
          .text(
            "TERMS & CONDITIONS",
            55,
            y + 12
          );

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor(TEXT)
          .text(
            doc?.terms_conditions ||
            "This quotation is valid for the period mentioned above. Prices are subject to the agreed scope and applicable taxes.",
            55,
            y + 28,
            {
              width: 485,
              height: 35,
            }
          );

        y += 82;

        /*
         * ----------------------------------------------------
         * NOTES
         * ----------------------------------------------------
         */

        if (doc?.notes) {
          pdf
            .font("Helvetica-Bold")
            .fontSize(9)
            .fillColor(DARK_GREEN)
            .text(
              "ADDITIONAL NOTES",
              40,
              y
            );

          pdf
            .font("Helvetica")
            .fontSize(8)
            .fillColor(TEXT)
            .text(
              doc.notes,
              40,
              y + 15,
              {
                width: 515,
              }
            );

          y += 42;
        }

        /*
         * ----------------------------------------------------
         * SIGNATURE
         * ----------------------------------------------------
         */

        const signatureY =
          Math.max(
            y + 18,
            690
          );

        if (signaturePath) {
          drawImageIfExists(
            pdf,
            signaturePath,
            420,
            signatureY,
            {
              fit: [110, 45],
              align: "center",
              valign: "center",
            }
          );
        }

        pdf
          .moveTo(
            400,
            signatureY + 50
          )
          .lineTo(
            555,
            signatureY + 50
          )
          .lineWidth(1)
          .strokeColor(BORDER)
          .stroke();

        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            "Authorized Signature",
            400,
            signatureY + 58,
            {
              width: 155,
              align: "center",
            }
          );

        pdf
          .font("Helvetica")
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(
            companyName,
            40,
            800,
            {
              width: 515,
              align: "center",
            }
          );

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
          .fontSize(15)
          .fillColor(DARK_GREEN)
          .text(
            companyName,
            620,
            32,
            {
              width: 250,
              align: "right",
            }
          );

        pdf
          .font("Helvetica")
          .fontSize(9)
          .fillColor(MUTED)
          .text(
            companyAddress,
            620,
            55,
            {
              width: 250,
              align: "right",
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

        pdf
          .font("Helvetica")
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(
            "Thank you for your business.",
            34,
            486,
            {
              width: 854,
              align: "center",
            }
          );

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
};