const path = require("path");

const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const {
  generateDocumentPdf,
} = require("../utils/generateDocumentPdf");
const { sendMail } = require("../utils/mailer");
const {
  relativeUploadPath,
} = require("../utils/upload");

const DOC_TYPES = [
  "invoice",
  "quotation",
];

const RECEIPT_TYPES = [
  "invoice",
  "multiple_invoices",
  "advance",
  "other",
];

const DOC_PREFIXES = {
  invoice: "",
  quotation: "QT-",
  money_receipt: "MR-",
};

const getYear = (date = new Date()) =>
  date.getFullYear();

const cleanNumber = (value, fallback = 0) => {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
};

const roundMoney = (value) =>
  Math.round(
    (cleanNumber(value) + Number.EPSILON) * 100
  ) / 100;

/*
 * ============================================================
 * USER / CUSTOMER / BANK HELPERS
 * ============================================================
 */

const getUserProfile = async (userId) => {
  const [rows] = await pool.query(
    `SELECT
      id,
      name,
      email,
      phone,
      business_name,
      business_type,
      gstin,
      pan,
      website,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
      country,
      currency,
      tax_type,
      tcs_enabled,
      tds_enabled,
      payment_terms,
      logo_path,
      signature_path
     FROM users
     WHERE id = ?`,
    [userId]
  );

  if (!rows.length) {
    throw new ApiError(
      404,
      "User profile not found."
    );
  }

  return rows[0];
};

const getCustomer = async (customerId) => {
  if (!customerId) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT *
     FROM customers
     WHERE id = ?`,
    [customerId]
  );

  return rows[0] || null;
};

const getBankAccount = async (
  bankAccountId,
  userId
) => {
  if (!bankAccountId) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT *
     FROM banking
     WHERE id = ?
       AND created_by = ?`,
    [bankAccountId, userId]
  );

  if (!rows.length) {
    throw new ApiError(
      400,
      "Selected bank account was not found."
    );
  }

  return rows[0];
};

const getDefaultBankAccount = async (
  userId
) => {
  const [rows] = await pool.query(
    `SELECT *
     FROM banking
     WHERE created_by = ?
     ORDER BY id ASC
     LIMIT 1`,
    [userId]
  );

  return rows[0] || null;
};

const buildFromSnapshot = (user) => ({
  from_name:
    user?.name || null,

  from_business_name:
    user?.business_name || null,

  from_email:
    user?.email || null,

  from_phone:
    user?.phone || null,

  from_gstin:
    user?.gstin || null,

  from_pan:
    user?.pan || null,

  from_website:
    user?.website || null,

  from_address_line1:
    user?.address_line1 || null,

  from_address_line2:
    user?.address_line2 || null,

  from_city:
    user?.city || null,

  from_state:
    user?.state || null,

  from_pincode:
    user?.pincode || null,

  from_country:
    user?.country || "India",

  from_logo_path:
    user?.logo_path || null,

  from_signature_path:
    user?.signature_path || null,
});

const buildBankSnapshot = (bank) => ({
  bank_name:
    bank?.bank_name || null,

  bank_branch:
    bank?.branch ||
    bank?.bank_branch ||
    null,

  bank_account_holder_name:
    bank?.account_holder_name ||
    bank?.bank_account_holder_name ||
    null,

  bank_account_number:
    bank?.account_number ||
    bank?.bank_account_number ||
    null,

  bank_account_type:
    bank?.account_type ||
    bank?.bank_account_type ||
    null,

  bank_ifsc_code:
    bank?.ifsc_code ||
    bank?.bank_ifsc_code ||
    null,
});

/*
 * ============================================================
 * DOCUMENT NUMBER
 * ============================================================
 */

const createDocumentNumber = async (
  conn,
  docType,
  date = new Date()
) => {
  const year = getYear(date);

  await conn.query(
    `INSERT INTO document_sequences
      (year, doc_type, last_number)
     VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE
       last_number = last_number`,
    [
      year,
      docType,
    ]
  );

  const [rows] = await conn.query(
    `SELECT last_number
     FROM document_sequences
     WHERE year = ?
       AND doc_type = ?
     FOR UPDATE`,
    [
      year,
      docType,
    ]
  );

  const nextNumber =
    Number(rows[0]?.last_number || 0) + 1;

  await conn.query(
    `UPDATE document_sequences
     SET last_number = ?
     WHERE year = ?
       AND doc_type = ?`,
    [
      nextNumber,
      year,
      docType,
    ]
  );

  const padded =
    String(nextNumber).padStart(5, "0");

  return `#${DOC_PREFIXES[docType]}${year}-${padded}`;
};

const createMoneyReceiptNumber = async (
  conn,
  date = new Date()
) => {
  return createDocumentNumber(
    conn,
    "money_receipt",
    date
  );
};

/*
 * ============================================================
 * CREATE INVOICE / QUOTATION
 * ============================================================
 */

const createDocument =
  asyncHandler(async (req, res) => {
    const body =
      req.body || {};

    const docType =
      DOC_TYPES.includes(
        body.doc_type
      )
        ? body.doc_type
        : "invoice";

    const safeItems =
      Array.isArray(body.items)
        ? body.items
        : [];

    const user =
      await getUserProfile(
        req.user.id
      );

    const customer =
      await getCustomer(
        body.customer_id
      );

    const manualCustomer =
      body.manual_customer || {};

    const customerForDocument =
      customer || {
        name:
          manualCustomer.name ||
          null,

        display_name:
          manualCustomer.display_name ||
          manualCustomer.name ||
          null,

        business_name:
          manualCustomer.business_name ||
          null,

        email:
          manualCustomer.email ||
          null,

        phone:
          manualCustomer.phone ||
          null,

        gstin:
          manualCustomer.gstin ||
          null,

        pan:
          manualCustomer.pan ||
          null,

        billing_state:
          manualCustomer.billing_state ||
          null,

        billing_district:
          manualCustomer.billing_district ||
          null,

        billing_city:
          manualCustomer.billing_city ||
          null,

        billing_pincode:
          manualCustomer.billing_pincode ||
          null,

        billing_landmark:
          manualCustomer.billing_landmark ||
          null,

        shipping_state:
          manualCustomer.shipping_state ||
          null,

        shipping_district:
          manualCustomer.shipping_district ||
          null,

        shipping_city:
          manualCustomer.shipping_city ||
          null,

        shipping_pincode:
          manualCustomer.shipping_pincode ||
          null,

        shipping_landmark:
          manualCustomer.shipping_landmark ||
          null,
      };

    /*
     * Bank information ALWAYS comes from
     * the Banking section.
     */
    const bank =
      body.bank_account_id
        ? await getBankAccount(
            body.bank_account_id,
            req.user.id
          )
        : await getDefaultBankAccount(
            req.user.id
          );

    const documentDate =
      body.invoice_date
        ? new Date(
            body.invoice_date
          )
        : new Date();

    if (
      Number.isNaN(
        documentDate.getTime()
      )
    ) {
      throw new ApiError(
        400,
        "Invalid document date."
      );
    }

    const documentStatus = [
      "draft",
      "issued",
      "cancelled",
    ].includes(
      body.document_status
    )
      ? body.document_status
      : "issued";

    const documentDiscountPercent =
      Math.max(
        cleanNumber(
          body.discount_percent,
          0
        ),
        0
      );

    const cgstRate =
      Math.max(
        cleanNumber(
          body.cgst_rate,
          0
        ),
        0
      );

    const sgstRate =
      Math.max(
        cleanNumber(
          body.sgst_rate,
          0
        ),
        0
      );

    const igstRate =
      Math.max(
        cleanNumber(
          body.igst_rate,
          0
        ),
        0
      );

    const tcsRate =
      Math.max(
        cleanNumber(
          body.tcs_rate,
          0
        ),
        0
      );

    const tdsRate =
      Math.max(
        cleanNumber(
          body.tds_rate,
          0
        ),
        0
      );

    let subtotal = 0;

    const calculatedItems =
      safeItems.map((rawItem) => {
        const requestedQuantity =
          cleanNumber(
            rawItem.quantity,
            1
          );

        const quantity =
          requestedQuantity > 0
            ? requestedQuantity
            : 1;

        const price =
          Math.max(
            cleanNumber(
              rawItem.price,
              0
            ),
            0
          );

        const amount =
          roundMoney(
            quantity * price
          );

        const itemDiscountPercent =
          Math.max(
            cleanNumber(
              rawItem.discount_percent,
              0
            ),
            0
          );

        const itemDiscountAmount =
          roundMoney(
            amount *
              itemDiscountPercent /
              100
          );

        const taxableAmount =
          roundMoney(
            amount -
              itemDiscountAmount
          );

        const itemTaxRate =
          Math.max(
            cleanNumber(
              rawItem.tax_rate,
              0
            ),
            0
          );

        const itemTaxAmount =
          roundMoney(
            taxableAmount *
              itemTaxRate /
              100
          );

        const lineTotal =
          roundMoney(
            taxableAmount +
              itemTaxAmount
          );

        subtotal += taxableAmount;

        return {
          product_name:
            rawItem.product_name ||
            rawItem.name ||
            "Item",

          hsn_code:
            rawItem.hsn_code ||
            rawItem.hsn ||
            null,

          quantity,
          price,
          amount,

          description:
            rawItem.description ||
            null,

          category:
            rawItem.category ||
            null,

          item_type:
            rawItem.item_type ===
            "service"
              ? "service"
              : "goods",

          unit:
            rawItem.unit ||
            null,

          discount_percent:
            itemDiscountPercent,

          discount_amount:
            itemDiscountAmount,

          tax_rate:
            itemTaxRate,

          tax_amount:
            itemTaxAmount,

          line_total:
            lineTotal,
        };
      });

    subtotal =
      roundMoney(subtotal);

    const discountAmount =
      roundMoney(
        subtotal *
          documentDiscountPercent /
          100
      );

    const taxableSubtotal =
      roundMoney(
        subtotal -
          discountAmount
      );

    const cgstAmount =
      roundMoney(
        taxableSubtotal *
          cgstRate /
          100
      );

    const sgstAmount =
      roundMoney(
        taxableSubtotal *
          sgstRate /
          100
      );

    const igstAmount =
      roundMoney(
        taxableSubtotal *
          igstRate /
          100
      );

    const tcsAmount =
      roundMoney(
        taxableSubtotal *
          tcsRate /
          100
      );

    const tdsAmount =
      roundMoney(
        taxableSubtotal *
          tdsRate /
          100
      );

    const beforeRoundOff =
      roundMoney(
        taxableSubtotal +
          cgstAmount +
          sgstAmount +
          igstAmount +
          tcsAmount -
          tdsAmount
      );

    const requestedRoundOff =
      cleanNumber(
        body.round_off,
        0
      );

    const roundOff =
      roundMoney(
        requestedRoundOff
      );

    const totalAmount =
      roundMoney(
        beforeRoundOff +
          roundOff
      );

    const totals = {
      subtotal,

      discountPercent:
        documentDiscountPercent,

      discountAmount,

      cgstRate,
      cgstAmount,

      sgstRate,
      sgstAmount,

      igstRate,
      igstAmount,

      tcsRate,
      tcsAmount,

      tdsRate,
      tdsAmount,

      roundOff,

      totalAmount,

      calculatedItems,
    };

    const fromSnapshot =
      buildFromSnapshot(user);

    const customerSnapshot = {
      to_name:
        customerForDocument?.display_name ||
        customerForDocument?.name ||
        null,

      to_business_name:
        customerForDocument?.business_name ||
        null,

      to_email:
        customerForDocument?.email ||
        null,

      to_phone:
        customerForDocument?.phone ||
        null,

      to_gstin:
        customerForDocument?.gstin ||
        null,

      to_pan:
        customerForDocument?.pan ||
        null,

      to_billing_state:
        customerForDocument?.billing_state ||
        customerForDocument?.business_state ||
        null,

      to_billing_district:
        customerForDocument?.billing_district ||
        customerForDocument?.business_district ||
        null,

      to_billing_city:
        customerForDocument?.billing_city ||
        customerForDocument?.business_city ||
        null,

      to_billing_pincode:
        customerForDocument?.billing_pincode ||
        customerForDocument?.business_pincode ||
        null,

      to_billing_landmark:
        customerForDocument?.billing_landmark ||
        customerForDocument?.business_landmark ||
        null,

      to_shipping_state:
        customerForDocument?.shipping_state ||
        customerForDocument?.billing_state ||
        customerForDocument?.business_state ||
        null,

      to_shipping_district:
        customerForDocument?.shipping_district ||
        customerForDocument?.billing_district ||
        customerForDocument?.business_district ||
        null,

      to_shipping_city:
        customerForDocument?.shipping_city ||
        customerForDocument?.billing_city ||
        customerForDocument?.business_city ||
        null,

      to_shipping_pincode:
        customerForDocument?.shipping_pincode ||
        customerForDocument?.billing_pincode ||
        customerForDocument?.business_pincode ||
        null,

      to_shipping_landmark:
        customerForDocument?.shipping_landmark ||
        customerForDocument?.billing_landmark ||
        customerForDocument?.business_landmark ||
        null,
    };

    const bankSnapshot =
      buildBankSnapshot(bank);

    const conn =
      await pool.getConnection();

    let docId;
    let docNumber;

    try {
      await conn.beginTransaction();

      docNumber =
        await createDocumentNumber(
          conn,
          docType,
          documentDate
        );

      /*
       * ========================================================
       * INVOICE
       * ========================================================
       */

      if (
        docType === "invoice"
      ) {
        const invoiceValues = [
          docType,
          docNumber,
          customer?.id || null,
          documentDate,
          totals.subtotal,
          totals.totalAmount,
          documentStatus,
          body.due_date || null,
          body.valid_until || null,
          totals.discountPercent,
          totals.discountAmount,
          totals.cgstRate,
          totals.cgstAmount,
          totals.sgstRate,
          totals.sgstAmount,
          totals.igstRate,
          totals.igstAmount,
          totals.tcsRate,
          totals.tcsAmount,
          totals.tdsRate,
          totals.tdsAmount,
          totals.roundOff,
          user.currency || "INR",
          body.payment_terms ||
            user.payment_terms ||
            null,
          body.notes || null,
          body.terms_conditions ||
            null,
          bank?.id || null,
          body.quotation_converted_invoice_id ||
            null,

          fromSnapshot.from_name,
          fromSnapshot.from_business_name,
          fromSnapshot.from_email,
          fromSnapshot.from_phone,
          fromSnapshot.from_gstin,
          fromSnapshot.from_pan,
          fromSnapshot.from_website,
          fromSnapshot.from_address_line1,
          fromSnapshot.from_address_line2,
          fromSnapshot.from_city,
          fromSnapshot.from_state,
          fromSnapshot.from_pincode,
          fromSnapshot.from_country,
          fromSnapshot.from_logo_path,
          fromSnapshot.from_signature_path,

          customerSnapshot.to_name,
          customerSnapshot.to_business_name,
          customerSnapshot.to_email,
          customerSnapshot.to_phone,
          customerSnapshot.to_gstin,
          customerSnapshot.to_pan,
          customerSnapshot.to_billing_state,
          customerSnapshot.to_billing_district,
          customerSnapshot.to_billing_city,
          customerSnapshot.to_billing_pincode,
          customerSnapshot.to_billing_landmark,
          customerSnapshot.to_shipping_state,
          customerSnapshot.to_shipping_district,
          customerSnapshot.to_shipping_city,
          customerSnapshot.to_shipping_pincode,
          customerSnapshot.to_shipping_landmark,

          bankSnapshot.bank_name,
          bankSnapshot.bank_branch,
          bankSnapshot.bank_account_holder_name,
          bankSnapshot.bank_account_number,
          bankSnapshot.bank_account_type,
          bankSnapshot.bank_ifsc_code,

          req.user.id,
        ];

        const invoicePlaceholders =
          invoiceValues
            .map(() => "?")
            .join(", ");

        const [result] =
          await conn.query(
            `INSERT INTO invoices (
              doc_type,
              invoice_number,
              customer_id,
              invoice_date,
              subtotal,
              total_amount,
              document_status,
              due_date,
              valid_until,
              discount_percent,
              discount_amount,
              cgst_rate,
              cgst_amount,
              sgst_rate,
              sgst_amount,
              igst_rate,
              igst_amount,
              tcs_rate,
              tcs_amount,
              tds_rate,
              tds_amount,
              round_off,
              currency,
              payment_terms,
              notes,
              terms_conditions,
              bank_account_id,
              quotation_converted_invoice_id,
              from_name,
              from_business_name,
              from_email,
              from_phone,
              from_gstin,
              from_pan,
              from_website,
              from_address_line1,
              from_address_line2,
              from_city,
              from_state,
              from_pincode,
              from_country,
              from_logo_path,
              from_signature_path,
              to_name,
              to_business_name,
              to_email,
              to_phone,
              to_gstin,
              to_pan,
              to_billing_state,
              to_billing_district,
              to_billing_city,
              to_billing_pincode,
              to_billing_landmark,
              to_shipping_state,
              to_shipping_district,
              to_shipping_city,
              to_shipping_pincode,
              to_shipping_landmark,
              bank_name,
              bank_branch,
              bank_account_holder_name,
              bank_account_number,
              bank_account_type,
              bank_ifsc_code,
              created_by
            )
            VALUES (${invoicePlaceholders})`,
            invoiceValues
          );

        docId =
          result.insertId;

        for (
          const item of
            totals.calculatedItems
        ) {
          await conn.query(
            `INSERT INTO invoice_items (
              invoice_id,
              product_name,
              hsn_code,
              quantity,
              price,
              amount,
              description,
              category,
              item_type,
              unit,
              discount_percent,
              discount_amount,
              tax_rate,
              tax_amount,
              line_total
            )
            VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            )`,
            [
              docId,
              item.product_name,
              item.hsn_code,
              item.quantity || 1,
              item.price,
              item.amount,
              item.description,
              item.category,
              item.item_type,
              item.unit,
              item.discount_percent,
              item.discount_amount,
              item.tax_rate,
              item.tax_amount,
              item.line_total,
            ]
          );
        }
      }

      /*
       * ========================================================
       * QUOTATION
       * ========================================================
       */

      if (
        docType === "quotation"
      ) {
        const quotationValues = [
          docNumber,
          customer?.id || null,
          documentDate,
          totals.subtotal,
          totals.totalAmount,
          documentStatus,
          body.valid_until || null,
          totals.discountPercent,
          totals.discountAmount,
          totals.cgstRate,
          totals.cgstAmount,
          totals.sgstRate,
          totals.sgstAmount,
          totals.igstRate,
          totals.igstAmount,
          totals.tcsRate,
          totals.tcsAmount,
          totals.tdsRate,
          totals.tdsAmount,
          totals.roundOff,
          user.currency || "INR",
          body.payment_terms ||
            user.payment_terms ||
            null,
          body.notes || null,
          body.terms_conditions ||
            null,

          fromSnapshot.from_name,
          fromSnapshot.from_business_name,
          fromSnapshot.from_email,
          fromSnapshot.from_phone,
          fromSnapshot.from_gstin,
          fromSnapshot.from_pan,
          fromSnapshot.from_website,
          fromSnapshot.from_address_line1,
          fromSnapshot.from_address_line2,
          fromSnapshot.from_city,
          fromSnapshot.from_state,
          fromSnapshot.from_pincode,
          fromSnapshot.from_country,
          fromSnapshot.from_logo_path,
          fromSnapshot.from_signature_path,

          customerSnapshot.to_name,
          customerSnapshot.to_business_name,
          customerSnapshot.to_email,
          customerSnapshot.to_phone,
          customerSnapshot.to_gstin,
          customerSnapshot.to_pan,
          customerSnapshot.to_billing_state,
          customerSnapshot.to_billing_district,
          customerSnapshot.to_billing_city,
          customerSnapshot.to_billing_pincode,
          customerSnapshot.to_billing_landmark,
          customerSnapshot.to_shipping_state,
          customerSnapshot.to_shipping_district,
          customerSnapshot.to_shipping_city,
          customerSnapshot.to_shipping_pincode,
          customerSnapshot.to_shipping_landmark,

          bankSnapshot.bank_name,
          bankSnapshot.bank_branch,
          bankSnapshot.bank_account_holder_name,
          bankSnapshot.bank_account_number,
          bankSnapshot.bank_account_type,
          bankSnapshot.bank_ifsc_code,

          req.user.id,
        ];

        const quotationPlaceholders =
          quotationValues
            .map(() => "?")
            .join(", ");

        const [result] =
          await conn.query(
            `INSERT INTO quotations (
              quotation_number,
              customer_id,
              quotation_date,
              subtotal,
              total_amount,
              document_status,
              valid_until,
              discount_percent,
              discount_amount,
              cgst_rate,
              cgst_amount,
              sgst_rate,
              sgst_amount,
              igst_rate,
              igst_amount,
              tcs_rate,
              tcs_amount,
              tds_rate,
              tds_amount,
              round_off,
              currency,
              payment_terms,
              notes,
              terms_conditions,
              from_name,
              from_business_name,
              from_email,
              from_phone,
              from_gstin,
              from_pan,
              from_website,
              from_address_line1,
              from_address_line2,
              from_city,
              from_state,
              from_pincode,
              from_country,
              from_logo_path,
              from_signature_path,
              to_name,
              to_business_name,
              to_email,
              to_phone,
              to_gstin,
              to_pan,
              to_billing_state,
              to_billing_district,
              to_billing_city,
              to_billing_pincode,
              to_billing_landmark,
              to_shipping_state,
              to_shipping_district,
              to_shipping_city,
              to_shipping_pincode,
              to_shipping_landmark,
              bank_name,
              bank_branch,
              bank_account_holder_name,
              bank_account_number,
              bank_account_type,
              bank_ifsc_code,
              created_by
            )
            VALUES (${quotationPlaceholders})`,
            quotationValues
          );

        docId =
          result.insertId;

        for (
          const item of
            totals.calculatedItems
        ) {
          await conn.query(
            `INSERT INTO quotation_items (
              quotation_id,
              product_name,
              hsn_code,
              quantity,
              price,
              amount,
              description,
              category,
              item_type,
              unit,
              discount_percent,
              discount_amount,
              tax_rate,
              tax_amount,
              line_total
            )
            VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            )`,
            [
              docId,
              item.product_name,
              item.hsn_code,
              item.quantity || 1,
              item.price,
              item.amount,
              item.description,
              item.category,
              item.item_type,
              item.unit,
              item.discount_percent,
              item.discount_amount,
              item.tax_rate,
              item.tax_amount,
              item.line_total,
            ]
          );
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    /*
     * ========================================================
     * FETCH CREATED DOCUMENT
     * ========================================================
     */

    let doc;
    let itemRows;

    if (
      docType === "quotation"
    ) {
      const [docRows] =
        await pool.query(
          `SELECT *
           FROM quotations
           WHERE id = ?`,
          [docId]
        );

      doc =
        docRows[0];

      if (!doc) {
        throw new ApiError(
          404,
          "Quotation not found after creation."
        );
      }

      doc.doc_type =
        "quotation";

      doc.invoice_number =
        doc.quotation_number;

      doc.invoice_date =
        doc.quotation_date;

      const [rows] =
        await pool.query(
          `SELECT *
           FROM quotation_items
           WHERE quotation_id = ?
           ORDER BY id ASC`,
          [docId]
        );

      itemRows = rows;
    } else {
      const [docRows] =
        await pool.query(
          `SELECT *
           FROM invoices
           WHERE id = ?
             AND doc_type = 'invoice'`,
          [docId]
        );

      doc =
        docRows[0];

      if (!doc) {
        throw new ApiError(
          404,
          "Invoice not found after creation."
        );
      }

      const [rows] =
        await pool.query(
          `SELECT *
           FROM invoice_items
           WHERE invoice_id = ?
           ORDER BY id ASC`,
          [docId]
        );

      itemRows = rows;
    }

    /*
     * ========================================================
     * COMPANY SNAPSHOT FOR PDF
     * ========================================================
     */

    const company = {
      company_name:
        doc.from_business_name ||
        doc.from_name ||
        "",

      business_name:
        doc.from_business_name ||
        "",

      name:
        doc.from_name ||
        "",

      email:
        doc.from_email ||
        "",

      phone:
        doc.from_phone ||
        "",

      gstin:
        doc.from_gstin ||
        "",

      pan:
        doc.from_pan ||
        "",

      website:
        doc.from_website ||
        "",

      address_line1:
        doc.from_address_line1 ||
        "",

      address_line2:
        doc.from_address_line2 ||
        "",

      city:
        doc.from_city ||
        "",

      state:
        doc.from_state ||
        "",

      pincode:
        doc.from_pincode ||
        "",

      country:
        doc.from_country ||
        "India",

      logo_path:
        doc.from_logo_path ||
        null,

      signature_path:
        doc.from_signature_path ||
        null,
    };

    let absPdfPath = null;
    let pdfRelPath = null;

    /*
     * ========================================================
     * GENERATE PDF
     * ========================================================
     */

    try {
      const pdfDoc = {
        ...doc,

        doc_type:
          docType,

        invoice_number:
          docType === "quotation"
            ? doc.quotation_number
            : doc.invoice_number,

        invoice_date:
          docType === "quotation"
            ? doc.quotation_date
            : doc.invoice_date,
      };

      absPdfPath =
        await generateDocumentPdf({
          doc: pdfDoc,
          customer:
            customerForDocument,
          items: itemRows,
          company,
        });

      pdfRelPath =
        relativeUploadPath(
          absPdfPath
        ).replace(
          /#/g,
          "%23"
        );

      if (
        docType === "quotation"
      ) {
        await pool.query(
          `UPDATE quotations
           SET pdf_path = ?
           WHERE id = ?`,
          [
            pdfRelPath,
            docId,
          ]
        );
      } else {
        await pool.query(
          `UPDATE invoices
           SET pdf_path = ?
           WHERE id = ?`,
          [
            pdfRelPath,
            docId,
          ]
        );
      }
    } catch (err) {
      console.error(
        "Document PDF generation failed:",
        err
      );
    }

    /*
     * ========================================================
     * EMAIL
     * ========================================================
     */

    let emailResult = {
      sent: false,
      error:
        "No customer email on file.",
    };

    const customerEmail =
      customerForDocument?.email ||
      doc.to_email ||
      null;

    if (
      customerEmail &&
      absPdfPath
    ) {
      emailResult =
        await sendMail({
          to: customerEmail,

          subject:
            `${docNumber} from ${
              user.business_name ||
              company.company_name
            }`,

          text:
            `Dear ${
              customerForDocument?.name ||
              customerForDocument?.display_name ||
              doc.to_name ||
              "Customer"
            },\n\n` +
            `Please find attached your ${docType} ${docNumber}.\n\n` +
            `Thank you.\n\n` +
            `${
              user.business_name ||
              company.company_name
            }`,

          attachments: [
            {
              filename:
                `${docNumber.replace(
                  "#",
                  ""
                )}.pdf`,

              path:
                absPdfPath,
            },
          ],
        });

      if (
        docType === "invoice"
      ) {
        await pool.query(
          `UPDATE invoices
           SET email_status = ?
           WHERE id = ?`,
          [
            emailResult.sent
              ? "sent"
              : "failed",

            docId,
          ]
        );
      }
    }

    /*
     * ========================================================
     * FINAL RESPONSE
     * ========================================================
     */

    let finalDocument;

    if (
      docType === "quotation"
    ) {
      const [finalRows] =
        await pool.query(
          `SELECT *
           FROM quotations
           WHERE id = ?`,
          [docId]
        );

      finalDocument = {
        ...finalRows[0],

        doc_type:
          "quotation",

        invoice_number:
          finalRows[0]
            .quotation_number,

        invoice_date:
          finalRows[0]
            .quotation_date,
      };
    } else {
      const [finalRows] =
        await pool.query(
          `SELECT *
           FROM invoices
           WHERE id = ?
             AND doc_type = 'invoice'`,
          [docId]
        );

      finalDocument =
        finalRows[0];
    }

    res.status(201).json({
      success: true,

      document:
        finalDocument,

      items:
        itemRows,

      download_url:
        pdfRelPath || null,

      email:
        emailResult,
    });
  });

/*
 * ============================================================
 * CREATE MONEY RECEIPT
 * ============================================================
 */

const createMoneyReceipt =
  asyncHandler(async (req, res) => {
    const body =
      req.body || {};

    const againstType =
      RECEIPT_TYPES.includes(
        body.against_type
      )
        ? body.against_type
        : "invoice";

    const paymentMode =
      [
        "cash",
        "upi",
        "bank_transfer",
        "cheque",
        "card",
        "other",
      ].includes(
        body.payment_mode
      )
        ? body.payment_mode
        : "cash";

    const amountReceived =
      roundMoney(
        cleanNumber(
          body.amount_received,
          0
        )
      );

    if (
      amountReceived <= 0
    ) {
      throw new ApiError(
        400,
        "Amount received must be greater than zero."
      );
    }

    const user =
      await getUserProfile(
        req.user.id
      );

    const customer =
      await getCustomer(
        body.customer_id
      );

    /*
     * Bank information ALWAYS comes
     * from the Banking section.
     */
    const bank =
      body.bank_account_id
        ? await getBankAccount(
            body.bank_account_id,
            req.user.id
          )
        : await getDefaultBankAccount(
            req.user.id
          );

    const receiptDate =
      body.receipt_date
        ? new Date(
            body.receipt_date
          )
        : new Date();

    if (
      Number.isNaN(
        receiptDate.getTime()
      )
    ) {
      throw new ApiError(
        400,
        "Invalid receipt date."
      );
    }

    const allocations =
      Array.isArray(
        body.allocations
      )
        ? body.allocations
        : [];

    /*
     * ========================================================
     * PRE-VALIDATE ALLOCATION TOTAL
     * ========================================================
     */

    let allocationTotal = 0;

    const normalizedAllocations =
      allocations.map(
        (allocation) => {
          const invoiceId =
            Number(
              allocation.invoice_id
            );

          const amountApplied =
            roundMoney(
              Math.max(
                cleanNumber(
                  allocation.amount_applied,
                  0
                ),
                0
              )
            );

          allocationTotal =
            roundMoney(
              allocationTotal +
                amountApplied
            );

          return {
            invoice_id:
              invoiceId,

            amount_applied:
              amountApplied,
          };
        }
      );

    if (
      againstType === "invoice" ||
      againstType ===
        "multiple_invoices"
    ) {
      if (
        !normalizedAllocations.length
      ) {
        throw new ApiError(
          400,
          "At least one invoice allocation is required."
        );
      }

      if (
        allocationTotal >
        amountReceived + 0.01
      ) {
        throw new ApiError(
          400,
          "Invoice allocation total cannot exceed the amount received."
        );
      }
    }

    /*
     * For advance / other, allocations are ignored.
     * This prevents accidental invoice allocation from
     * being inserted for those receipt types.
     */
    const effectiveAllocations =
      (
        againstType === "invoice" ||
        againstType ===
          "multiple_invoices"
      )
        ? normalizedAllocations
        : [];

    const conn =
      await pool.getConnection();

    let receiptId;
    let receiptNumber;

    try {
      await conn.beginTransaction();

      receiptNumber =
        await createMoneyReceiptNumber(
          conn,
          receiptDate
        );

      const bankSnapshot =
        buildBankSnapshot(
          bank
        );

      const fromSnapshot =
        buildFromSnapshot(
          user
        );

      const receiptValues = [
        receiptNumber,

        body.document_status ||
          "issued",

        receiptDate,

        customer?.id ||
          null,

        customer?.display_name ||
          customer?.name ||
          body.received_from_name ||
          null,

        customer?.email ||
          body.received_from_email ||
          null,

        customer?.phone ||
          body.received_from_phone ||
          null,

        againstType,

        amountReceived,

        paymentMode,

        body.transaction_reference ||
          null,

        bank?.id ||
          null,

        bankSnapshot.bank_name,
        bankSnapshot.bank_branch,
        bankSnapshot.bank_account_holder_name,
        bankSnapshot.bank_account_number,
        bankSnapshot.bank_ifsc_code,

        body.description ||
          null,

        body.notes ||
          null,

        user.currency ||
          "INR",

        req.user.id,

        fromSnapshot.from_name,
        fromSnapshot.from_business_name,
        fromSnapshot.from_email,
        fromSnapshot.from_phone,
        fromSnapshot.from_gstin,
        fromSnapshot.from_pan,
        fromSnapshot.from_website,
        fromSnapshot.from_address_line1,
        fromSnapshot.from_address_line2,
        fromSnapshot.from_city,
        fromSnapshot.from_state,
        fromSnapshot.from_pincode,
        fromSnapshot.from_country,
        fromSnapshot.from_logo_path,
        fromSnapshot.from_signature_path,

        customer?.business_name ||
          null,

        customer?.gstin ||
          null,

        customer?.pan ||
          null,

        customer?.billing_state ||
          customer?.business_state ||
          null,

        customer?.billing_district ||
          customer?.business_district ||
          null,

        customer?.billing_city ||
          customer?.business_city ||
          null,

        customer?.billing_pincode ||
          customer?.business_pincode ||
          null,

        customer?.billing_landmark ||
          customer?.business_landmark ||
          null,
      ];

      const receiptPlaceholders =
        receiptValues
          .map(() => "?")
          .join(", ");

      const [result] =
        await conn.query(
          `INSERT INTO money_receipts (
            receipt_number,
            document_status,
            receipt_date,
            customer_id,
            received_from_name,
            received_from_email,
            received_from_phone,
            against_type,
            amount_received,
            payment_mode,
            transaction_reference,
            bank_account_id,
            bank_name,
            bank_branch,
            bank_account_holder_name,
            bank_account_number,
            bank_ifsc_code,
            description,
            notes,
            currency,
            created_by,
            from_name,
            from_business_name,
            from_email,
            from_phone,
            from_gstin,
            from_pan,
            from_website,
            from_address_line1,
            from_address_line2,
            from_city,
            from_state,
            from_pincode,
            from_country,
            from_logo_path,
            from_signature_path,
            to_business_name,
            to_gstin,
            to_pan,
            to_billing_state,
            to_billing_district,
            to_billing_city,
            to_billing_pincode,
            to_billing_landmark
          )
          VALUES (${receiptPlaceholders})`,
          receiptValues
        );

      receiptId =
        result.insertId;

      /*
       * ======================================================
       * VALIDATE AND INSERT EACH ALLOCATION
       * ======================================================
       *
       * outstanding =
       * invoice total
       * - all previous money receipt allocations
       *
       * We also track allocations inserted by THIS receipt
       * so the same invoice cannot be over-allocated by
       * multiple rows in the same request.
       */

      const allocationsUsedThisReceipt =
        new Map();

      let runningAllocationTotal = 0;

      for (
        const allocation of
          effectiveAllocations
      ) {
        const invoiceId =
          Number(
            allocation.invoice_id
          );

        const amountApplied =
          roundMoney(
            allocation.amount_applied
          );

        if (
          !invoiceId ||
          amountApplied <= 0
        ) {
          throw new ApiError(
            400,
            "Invalid invoice allocation."
          );
        }

        /*
         * Lock the invoice row while checking
         * its outstanding amount.
         */
        const [
          invoiceRows,
        ] = await conn.query(
          `SELECT
             id,
             customer_id,
             total_amount,
             document_status
           FROM invoices
           WHERE id = ?
             AND doc_type = 'invoice'
           FOR UPDATE`,
          [invoiceId]
        );

        if (
          !invoiceRows.length
        ) {
          throw new ApiError(
            404,
            `Invoice ${invoiceId} was not found.`
          );
        }

        const invoice =
          invoiceRows[0];

        /*
         * If a normal user is creating the receipt,
         * the invoice must belong to that same user.
         *
         * Superadmin is allowed to work with all invoices,
         * matching the existing document visibility behavior.
         */
        if (
          req.user.role === "user"
        ) {
          const [
            ownerRows,
          ] = await conn.query(
            `SELECT created_by
             FROM invoices
             WHERE id = ?
             LIMIT 1`,
            [invoiceId]
          );

          if (
            !ownerRows.length ||
            Number(
              ownerRows[0]
                .created_by
            ) !==
              Number(
                req.user.id
              )
          ) {
            throw new ApiError(
              403,
              `Invoice ${invoiceId} does not belong to your account.`
            );
          }
        }

        /*
         * Customer safety check.
         */
        if (
          customer?.id &&
          invoice.customer_id &&
          Number(
            invoice.customer_id
          ) !==
            Number(
              customer.id
            )
        ) {
          throw new ApiError(
            400,
            `Invoice ${invoiceId} does not belong to this customer.`
          );
        }

        /*
         * Only issued/draft invoices are considered here.
         * A cancelled invoice should not receive payment.
         */
        if (
          invoice.document_status ===
          "cancelled"
        ) {
          throw new ApiError(
            400,
            `Invoice ${invoiceId} is cancelled and cannot receive a payment.`
          );
        }

        /*
         * Existing allocation total.
         */
        const [
          allocationRows,
        ] = await conn.query(
          `SELECT
             COALESCE(
               SUM(amount_applied),
               0
             ) AS allocated_amount
           FROM money_receipt_allocations
           WHERE invoice_id = ?`,
          [invoiceId]
        );

        const previouslyAllocated =
          roundMoney(
            allocationRows[0]
              ?.allocated_amount || 0
          );

        /*
         * Allocation already entered for this same
         * invoice in the current receipt.
         */
        const currentReceiptAllocated =
          roundMoney(
            allocationsUsedThisReceipt.get(
              invoiceId
            ) || 0
          );

        const invoiceTotal =
          roundMoney(
            invoice.total_amount || 0
          );

        const outstanding =
          roundMoney(
            invoiceTotal -
              previouslyAllocated -
              currentReceiptAllocated
          );

        if (
          outstanding <= 0.01
        ) {
          throw new ApiError(
            400,
            `Invoice ${invoiceId} is already fully paid.`
          );
        }

        /*
         * THIS is the critical protection:
         *
         * amount_applied <= invoice outstanding
         */
        if (
          amountApplied >
          outstanding + 0.01
        ) {
          throw new ApiError(
            400,
            `Amount applied to invoice ${invoiceId} cannot exceed its outstanding balance of ₹${roundMoney(outstanding)}.`
          );
        }

        /*
         * Also make absolutely sure the whole receipt
         * never allocates more than amount received.
         */
        const nextAllocationTotal =
          roundMoney(
            runningAllocationTotal +
              amountApplied
          );

        if (
          nextAllocationTotal >
          amountReceived + 0.01
        ) {
          throw new ApiError(
            400,
            "Invoice allocation total cannot exceed the amount received."
          );
        }

        await conn.query(
          `INSERT INTO money_receipt_allocations (
            money_receipt_id,
            invoice_id,
            amount_applied
          )
          VALUES (?, ?, ?)`,
          [
            receiptId,
            invoiceId,
            amountApplied,
          ]
        );

        allocationsUsedThisReceipt.set(
          invoiceId,
          roundMoney(
            currentReceiptAllocated +
              amountApplied
          )
        );

        runningAllocationTotal =
          nextAllocationTotal;
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    /*
     * ========================================================
     * FETCH RECEIPT
     * ========================================================
     */

    const [
      receiptRows,
    ] = await pool.query(
      `SELECT *
       FROM money_receipts
       WHERE id = ?`,
      [receiptId]
    );

    const receipt =
      receiptRows[0];

    const [
      allocationRows,
    ] = await pool.query(
      `SELECT
        mra.*,
        i.invoice_number,
        i.total_amount
       FROM money_receipt_allocations mra
       JOIN invoices i
         ON i.id = mra.invoice_id
       WHERE mra.money_receipt_id = ?
       ORDER BY mra.id ASC`,
      [receiptId]
    );

    /*
     * ========================================================
     * COMPANY SNAPSHOT
     * ========================================================
     */

    const company = {
      company_name:
        receipt.from_business_name ||
        receipt.from_name ||
        "",

      business_name:
        receipt.from_business_name ||
        "",

      name:
        receipt.from_name ||
        "",

      email:
        receipt.from_email ||
        "",

      phone:
        receipt.from_phone ||
        "",

      gstin:
        receipt.from_gstin ||
        "",

      pan:
        receipt.from_pan ||
        "",

      website:
        receipt.from_website ||
        "",

      address_line1:
        receipt.from_address_line1 ||
        "",

      address_line2:
        receipt.from_address_line2 ||
        "",

      city:
        receipt.from_city ||
        "",

      state:
        receipt.from_state ||
        "",

      pincode:
        receipt.from_pincode ||
        "",

      country:
        receipt.from_country ||
        "India",

      logo_path:
        receipt.from_logo_path ||
        null,

      signature_path:
        receipt.from_signature_path ||
        null,
    };

    let absPdfPath = null;
    let pdfRelPath = null;

    /*
     * ========================================================
     * MONEY RECEIPT PDF
     * ========================================================
     */

    try {
      absPdfPath =
        await generateDocumentPdf({
          doc: {
            ...receipt,

            doc_type:
              "money_receipt",

            invoice_number:
              receipt.receipt_number,

            invoice_date:
              receipt.receipt_date,

            total_amount:
              receipt.amount_received,

            subtotal:
              receipt.amount_received,
          },

          customer,

          items: [],

          company,

          receipt,
        });

      pdfRelPath =
        relativeUploadPath(
          absPdfPath
        ).replace(
          /#/g,
          "%23"
        );

      await pool.query(
        `UPDATE money_receipts
         SET pdf_path = ?
         WHERE id = ?`,
        [
          pdfRelPath,
          receiptId,
        ]
      );
    } catch (err) {
      console.error("MONEY RECEIPT PDF ERROR:", err?.stack || err); throw err;
    }

    const [
      finalRows,
    ] = await pool.query(
      `SELECT *
       FROM money_receipts
       WHERE id = ?`,
      [receiptId]
    );

    res.status(201).json({
      success: true,

      receipt:
        finalRows[0],

      allocations:
        allocationRows,

      download_url:
        pdfRelPath
          ? `${
              process.env.BASE_URL ||
              ""
            }${pdfRelPath}`
          : null,
    });
  });

/*
 * ============================================================
 * LIST DOCUMENTS
 * ============================================================
 */

const listDocuments =
  asyncHandler(async (req, res) => {
    const {
      doc_type,
      customer_id,
      from,
      to,
      document_status,
    } = req.query;

    const rows = [];

    /*
     * ========================================================
     * INVOICES
     * ========================================================
     */

    if (
      !doc_type ||
      doc_type === "invoice"
    ) {
      let invoiceSql = `
        SELECT
          i.*,
          COALESCE(
            i.to_name,
            c.name
          ) AS customer_name,
          COALESCE(
            i.to_email,
            c.email
          ) AS customer_email,
          COALESCE(
            i.to_phone,
            c.phone
          ) AS customer_phone,
          u.name AS created_by_name
        FROM invoices i
        LEFT JOIN customers c
          ON c.id = i.customer_id
        LEFT JOIN users u
          ON u.id = i.created_by
        WHERE i.doc_type = 'invoice'
      `;

      const invoiceParams = [];

      if (
        req.user.role === "user"
      ) {
        invoiceSql +=
          " AND i.created_by = ?";

        invoiceParams.push(
          req.user.id
        );
      }

      if (customer_id) {
        invoiceSql +=
          " AND i.customer_id = ?";

        invoiceParams.push(
          customer_id
        );
      }

      if (document_status) {
        invoiceSql +=
          " AND i.document_status = ?";

        invoiceParams.push(
          document_status
        );
      }

      if (from) {
        invoiceSql +=
          " AND i.invoice_date >= ?";

        invoiceParams.push(
          from
        );
      }

      if (to) {
        invoiceSql +=
          " AND i.invoice_date <= ?";

        invoiceParams.push(
          to
        );
      }

      const [
        invoiceRows,
      ] = await pool.query(
        invoiceSql,
        invoiceParams
      );

      rows.push(
        ...invoiceRows
      );
    }

    /*
     * ========================================================
     * QUOTATIONS
     * ========================================================
     */

    if (
      !doc_type ||
      doc_type === "quotation"
    ) {
      let quotationSql = `
        SELECT
          q.*,
          'quotation' AS doc_type,
          q.quotation_number AS invoice_number,
          q.quotation_date AS invoice_date,
          COALESCE(
            q.to_name,
            c.name
          ) AS customer_name,
          COALESCE(
            q.to_email,
            c.email
          ) AS customer_email,
          COALESCE(
            q.to_phone,
            c.phone
          ) AS customer_phone,
          u.name AS created_by_name
        FROM quotations q
        LEFT JOIN customers c
          ON c.id = q.customer_id
        LEFT JOIN users u
          ON u.id = q.created_by
        WHERE 1 = 1
      `;

      const quotationParams = [];

      if (
        req.user.role === "user"
      ) {
        quotationSql +=
          " AND q.created_by = ?";

        quotationParams.push(
          req.user.id
        );
      }

      if (customer_id) {
        quotationSql +=
          " AND q.customer_id = ?";

        quotationParams.push(
          customer_id
        );
      }

      if (document_status) {
        quotationSql +=
          " AND q.document_status = ?";

        quotationParams.push(
          document_status
        );
      }

      if (from) {
        quotationSql +=
          " AND q.quotation_date >= ?";

        quotationParams.push(
          from
        );
      }

      if (to) {
        quotationSql +=
          " AND q.quotation_date <= ?";

        quotationParams.push(
          to
        );
      }

      const [
        quotationRows,
      ] = await pool.query(
        quotationSql,
        quotationParams
      );

      rows.push(
        ...quotationRows
      );
    }

    rows.sort((a, b) => {
      const dateA =
        new Date(
          a.invoice_date ||
          a.quotation_date ||
          0
        ).getTime();

      const dateB =
        new Date(
          b.invoice_date ||
          b.quotation_date ||
          0
        ).getTime();

      if (
        dateB !== dateA
      ) {
        return dateB - dateA;
      }

      return (
        Number(b.id || 0) -
        Number(a.id || 0)
      );
    });

    res.json({
      success: true,

      count:
        rows.length,

      documents:
        rows,
    });
  });

/*
 * ============================================================
 * LIST MONEY RECEIPTS
 * ============================================================
 */

const listMoneyReceipts =
  asyncHandler(async (req, res) => {
    const {
      customer_id,
      from,
      to,
      document_status,
    } = req.query;

    let sql = `
      SELECT
        mr.*,
        COALESCE(
          mr.received_from_name,
          c.name
        ) AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone,
        u.name AS created_by_name
      FROM money_receipts mr
      LEFT JOIN customers c
        ON c.id = mr.customer_id
      LEFT JOIN users u
        ON u.id = mr.created_by
      WHERE 1 = 1
    `;

    const params = [];

    if (
      req.user.role === "user"
    ) {
      sql +=
        " AND mr.created_by = ?";

      params.push(
        req.user.id
      );
    }

    if (customer_id) {
      sql +=
        " AND mr.customer_id = ?";

      params.push(
        customer_id
      );
    }

    if (document_status) {
      sql +=
        " AND mr.document_status = ?";

      params.push(
        document_status
      );
    }

    if (from) {
      sql +=
        " AND mr.receipt_date >= ?";

      params.push(
        from
      );
    }

    if (to) {
      sql +=
        " AND mr.receipt_date <= ?";

      params.push(
        to
      );
    }

    sql +=
      " ORDER BY mr.receipt_date DESC, mr.id DESC";

    const [rows] =
      await pool.query(
        sql,
        params
      );

    res.json({
      success: true,

      count:
        rows.length,

      receipts:
        rows,
    });
  });

/*
 * ============================================================
 * GET DOCUMENT
 * ============================================================
 */

const getDocument =
  asyncHandler(async (req, res) => {
    const id =
      req.params.id;

    const requestedType =
      req.query.doc_type;

    let document;
    let items;

    /*
     * ========================================================
     * QUOTATION
     * ========================================================
     */

    if (
      requestedType ===
      "quotation"
    ) {
      const [rows] =
        await pool.query(
          `SELECT
            q.*,
            'quotation' AS doc_type,
            q.quotation_number AS invoice_number,
            q.quotation_date AS invoice_date,
            c.name AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email
           FROM quotations q
           LEFT JOIN customers c
             ON c.id = q.customer_id
           WHERE q.id = ?`,
          [id]
        );

      if (!rows.length) {
        throw new ApiError(
          404,
          "Quotation not found."
        );
      }

      if (
        req.user.role === "user" &&
        Number(
          rows[0].created_by
        ) !==
          Number(
            req.user.id
          )
      ) {
        throw new ApiError(
          403,
          "You are not allowed to access this quotation."
        );
      }

      document =
        rows[0];

      const [
        itemRows,
      ] = await pool.query(
        `SELECT *
         FROM quotation_items
         WHERE quotation_id = ?
         ORDER BY id ASC`,
        [id]
      );

      items =
        itemRows;
    }

    /*
     * ========================================================
     * INVOICE
     * ========================================================
     */

    else {
      const [rows] =
        await pool.query(
          `SELECT
            i.*,
            c.name AS customer_name,
            c.phone AS customer_phone,
            c.email AS customer_email
           FROM invoices i
           LEFT JOIN customers c
             ON c.id = i.customer_id
           WHERE i.id = ?
             AND i.doc_type = 'invoice'`,
          [id]
        );

      if (!rows.length) {
        throw new ApiError(
          404,
          "Invoice not found."
        );
      }

      if (
        req.user.role === "user" &&
        Number(
          rows[0].created_by
        ) !==
          Number(
            req.user.id
          )
      ) {
        throw new ApiError(
          403,
          "You are not allowed to access this invoice."
        );
      }

      document =
        rows[0];

      const [
        itemRows,
      ] = await pool.query(
        `SELECT *
         FROM invoice_items
         WHERE invoice_id = ?
         ORDER BY id ASC`,
        [id]
      );

      items =
        itemRows;
    }

    res.json({
      success: true,

      document,

      items,
    });
  });

/*
 * ============================================================
 * GET MONEY RECEIPT
 * ============================================================
 */

const getMoneyReceipt =
  asyncHandler(async (req, res) => {
    const [rows] =
      await pool.query(
        `SELECT
          mr.*,
          c.name AS customer_name,
          c.phone AS customer_phone,
          c.email AS customer_email
         FROM money_receipts mr
         LEFT JOIN customers c
           ON c.id = mr.customer_id
         WHERE mr.id = ?`,
        [req.params.id]
      );

    if (!rows.length) {
      throw new ApiError(
        404,
        "Money receipt not found."
      );
    }

    if (
      req.user.role === "user" &&
      Number(
        rows[0].created_by
      ) !==
        Number(
          req.user.id
        )
    ) {
      throw new ApiError(
        403,
        "You are not allowed to access this money receipt."
      );
    }

    const [
      allocations,
    ] = await pool.query(
      `SELECT
        mra.*,
        i.invoice_number,
        i.total_amount
       FROM money_receipt_allocations mra
       JOIN invoices i
         ON i.id = mra.invoice_id
       WHERE mra.money_receipt_id = ?
       ORDER BY mra.id ASC`,
      [req.params.id]
    );

    res.json({
      success: true,

      receipt:
        rows[0],

      allocations,
    });
  });

/*
 * ============================================================
 * RESEND DOCUMENT EMAIL
 * ============================================================
 */

const resendDocumentEmail =
  asyncHandler(async (req, res) => {
    const requestedType =
      req.query.doc_type;

    let rows;

    if (
      requestedType ===
      "quotation"
    ) {
      [rows] =
        await pool.query(
          `SELECT
            q.*,
            'quotation' AS doc_type,
            q.quotation_number AS invoice_number,
            q.quotation_date AS invoice_date,
            COALESCE(
              q.to_name,
              c.name
            ) AS customer_name,
            COALESCE(
              q.to_email,
              c.email
            ) AS customer_email
           FROM quotations q
           LEFT JOIN customers c
             ON c.id = q.customer_id
           WHERE q.id = ?`,
          [req.params.id]
        );
    } else {
      [rows] =
        await pool.query(
          `SELECT
            i.*,
            COALESCE(
              i.to_name,
              c.name
            ) AS customer_name,
            COALESCE(
              i.to_email,
              c.email
            ) AS customer_email
           FROM invoices i
           LEFT JOIN customers c
             ON c.id = i.customer_id
           WHERE i.id = ?
             AND i.doc_type = 'invoice'`,
          [req.params.id]
        );
    }

    if (!rows.length) {
      throw new ApiError(
        404,
        "Document not found."
      );
    }

    const doc =
      rows[0];

    if (
      req.user.role === "user" &&
      Number(
        doc.created_by
      ) !==
        Number(
          req.user.id
        )
    ) {
      throw new ApiError(
        403,
        "You are not allowed to access this document."
      );
    }

    if (!doc.pdf_path) {
      throw new ApiError(
        400,
        "This document has no generated PDF to attach."
      );
    }

    if (
      !doc.customer_email
    ) {
      throw new ApiError(
        400,
        "This customer has no email on file."
      );
    }

    /*
     * Stored pdf_path may contain URL-encoded #.
     * Decode it before resolving the filesystem path.
     */
    const decodedPdfPath =
      decodeURIComponent(
        doc.pdf_path
      );

    const absPdfPath =
      path.join(
        __dirname,
        "..",
        decodedPdfPath.replace(
          /^\/uploads/,
          "uploads"
        )
      );

    const user =
      await getUserProfile(
        doc.created_by
      );

    const emailResult =
      await sendMail({
        to:
          doc.customer_email,

        subject:
          `${doc.invoice_number} from ${
            user.business_name ||
            "Business"
          }`,

        text:
          `Dear ${
            doc.customer_name ||
            "Customer"
          },\n\n` +
          `Please find attached ${doc.invoice_number}.\n\n` +
          `${
            user.business_name ||
            "Business"
          }`,

        attachments: [
          {
            filename:
              `${doc.invoice_number.replace(
                "#",
                ""
              )}.pdf`,

            path:
              absPdfPath,
          },
        ],
      });

    if (
      requestedType !==
      "quotation"
    ) {
      await pool.query(
        `UPDATE invoices
         SET email_status = ?
         WHERE id = ?`,
        [
          emailResult.sent
            ? "sent"
            : "failed",

          doc.id,
        ]
      );
    }

    res.json({
      success: true,

      email:
        emailResult,
    });
  });

module.exports = {
  createDocument,
  createMoneyReceipt,
  listDocuments,
  listMoneyReceipts,
  getDocument,
  getMoneyReceipt,
  resendDocumentEmail,
};