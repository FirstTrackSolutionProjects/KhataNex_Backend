const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { getTenantContext, hasPermission, logAuditEvent } = require("../utils/tenantContext");
const { generateDocumentPdf } = require("../utils/generateDocumentPdf");
const { relativeUploadPath } = require("../utils/upload");

const cleanNumber = (val, fallback = 0) => {
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
};

const roundMoney = (val) => Math.round((cleanNumber(val) + Number.EPSILON) * 100) / 100;

const formatCurrentTime = () => {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

const formatCurrentDate = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Helper to build invoice numbering in format INV-YYYY-XXXXX
 */
async function generateInvoiceNumber(conn, invoiceDate = new Date()) {
  const dateObj = new Date(invoiceDate);
  const year = Number.isNaN(dateObj.getFullYear()) ? new Date().getFullYear() : dateObj.getFullYear();
  const prefix = `INV-${year}-`;

  const [rows] = await conn.query(
    "SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1 FOR UPDATE",
    [`${prefix}%`]
  );

  let nextSeq = 1;
  if (rows.length > 0 && rows[0].invoice_number) {
    const parts = rows[0].invoice_number.split("-");
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(lastNum)) {
      nextSeq = lastNum + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(5, "0")}`;
}

/**
 * Helper to build sale numbering in format SALE-YYYY-XXXXX
 */
async function generateSaleNumber(conn, saleDate = new Date()) {
  const dateObj = new Date(saleDate);
  const year = Number.isNaN(dateObj.getFullYear()) ? new Date().getFullYear() : dateObj.getFullYear();
  const prefix = `SALE-${year}-`;

  const [rows] = await conn.query(
    "SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1 FOR UPDATE",
    [`${prefix}%`]
  );

  let nextSeq = 1;
  if (rows.length > 0 && rows[0].sale_number) {
    const parts = rows[0].sale_number.split("-");
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(lastNum)) {
      nextSeq = lastNum + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(5, "0")}`;
}

/**
 * GET /api/sales
 * GET /api/sales/dashboard
 * Retrieves sales list with top-level metrics, search, and date filters
 */
const getSales = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "view")) {
    throw new ApiError(403, "Access denied: you do not have permission to view sales.");
  }

  let targetUserId = tenant.businessOwnerId;
  if (tenant.isSuperadmin && req.query.user_id) {
    targetUserId = Number(req.query.user_id);
  }

  const {
    start_date,
    end_date,
    period,
    payment_mode,
    payment_status,
    invoice_status,
    customer_id,
    search,
  } = req.query;

  const conditions = [];
  const params = [];

  // Scoped to business tenant (unless superadmin requesting all)
  if (!tenant.isSuperadmin || targetUserId) {
    conditions.push("s.user_id = ?");
    params.push(targetUserId);
  }

  // Date range filter
  if (start_date && end_date) {
    conditions.push("s.sale_date BETWEEN ? AND ?");
    params.push(start_date, end_date);
  } else if (period) {
    if (period === "today") {
      const todayStr = formatCurrentDate();
      conditions.push("s.sale_date = ?");
      params.push(todayStr);
    } else if (period === "this_week") {
      conditions.push("s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)");
    } else if (period === "this_month") {
      conditions.push("s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)");
    } else if (period === "this_year") {
      conditions.push("s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)");
    }
  }

  // Payment mode filter
  if (payment_mode && payment_mode !== "all") {
    conditions.push("s.payment_mode = ?");
    params.push(payment_mode);
  }

  // Payment status filter
  if (payment_status && payment_status !== "all") {
    conditions.push("s.payment_status = ?");
    params.push(payment_status);
  }

  // Invoice status filter
  if (invoice_status === "invoiced") {
    conditions.push("s.invoice_id IS NOT NULL");
  } else if (invoice_status === "uninvoiced") {
    conditions.push("s.invoice_id IS NULL");
  }

  // Customer filter
  if (customer_id) {
    conditions.push("s.customer_id = ?");
    params.push(Number(customer_id));
  }

  // Search filter (customer name, customer phone, product name, sale number)
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push("(s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.product_name LIKE ? OR s.sale_number LIKE ?)");
    params.push(term, term, term, term);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // 1. Fetch Summary Metrics
  const [metricsRows] = await pool.query(
    `SELECT
       COALESCE(SUM(s.amount), 0) AS total_sales_amount,
       COUNT(*) AS total_sales_count,
       COUNT(CASE WHEN s.invoice_id IS NOT NULL THEN 1 END) AS invoiced_sales_count,
       COUNT(CASE WHEN s.invoice_id IS NULL THEN 1 END) AS uninvoiced_sales_count,
       COALESCE(SUM(CASE WHEN s.invoice_id IS NULL THEN s.amount ELSE 0 END), 0) AS uninvoiced_sales_amount,
       COALESCE(SUM(CASE WHEN s.invoice_id IS NOT NULL THEN s.amount ELSE 0 END), 0) AS invoiced_sales_amount,
       COALESCE(SUM(s.paid_amount), 0) AS total_paid_amount,
       COALESCE(SUM(s.due_amount), 0) AS total_due_amount
     FROM sales s
     ${whereClause}`,
    params
  );

  const metrics = metricsRows[0] || {
    total_sales_amount: 0,
    total_sales_count: 0,
    invoiced_sales_count: 0,
    uninvoiced_sales_count: 0,
    uninvoiced_sales_amount: 0,
    invoiced_sales_amount: 0,
    total_paid_amount: 0,
    total_due_amount: 0,
  };

  // 2. Fetch Sales Records with Joined Invoice Details
  const [sales] = await pool.query(
    `SELECT
       s.*,
       inv.invoice_number,
       inv.pdf_path AS invoice_pdf_path,
       inv.document_status AS invoice_status,
       u.name AS creator_name,
       stk.quantity AS stock_current_quantity
     FROM sales s
     LEFT JOIN invoices inv ON s.invoice_id = inv.id
     LEFT JOIN users u ON s.created_by = u.id
     LEFT JOIN stock stk ON s.product_id = stk.id
     ${whereClause}
     ORDER BY s.sale_date DESC, s.sale_time DESC, s.id DESC`,
    params
  );

  // 3. Attach sale_items to each sale
  if (sales.length > 0) {
    const saleIds = sales.map((s) => s.id);
    const [allItems] = await pool.query(
      `SELECT * FROM sale_items WHERE sale_id IN (${saleIds.map(() => "?").join(",")}) ORDER BY id ASC`,
      saleIds
    );

    const itemsBySaleId = new Map();
    for (const it of allItems) {
      if (!itemsBySaleId.has(it.sale_id)) {
        itemsBySaleId.set(it.sale_id, []);
      }
      itemsBySaleId.get(it.sale_id).push(it);
    }

    for (const s of sales) {
      const items = itemsBySaleId.get(s.id) || [];
      s.items = items;
      if (items.length === 1) {
        s.items_summary = items[0].product_name;
      } else if (items.length > 1) {
        s.items_summary = `${items[0].product_name} (+${items.length - 1} more)`;
      } else {
        s.items_summary = s.product_name;
      }
    }
  }

  res.json({
    success: true,
    metrics: {
      total_sales_amount: roundMoney(metrics.total_sales_amount),
      total_sales_count: Number(metrics.total_sales_count || 0),
      invoiced_sales_count: Number(metrics.invoiced_sales_count || 0),
      uninvoiced_sales_count: Number(metrics.uninvoiced_sales_count || 0),
      uninvoiced_sales_amount: roundMoney(metrics.uninvoiced_sales_amount),
      invoiced_sales_amount: roundMoney(metrics.invoiced_sales_amount),
      total_paid_amount: roundMoney(metrics.total_paid_amount),
      total_due_amount: roundMoney(metrics.total_due_amount),
    },
    sales,
  });
});

/**
 * GET /api/sales/:id
 * Retrieve a single sale by ID with its line items
 */
const getSaleById = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  const saleId = Number(req.params.id);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "view")) {
    throw new ApiError(403, "Access denied: you do not have permission to view sales.");
  }

  const [rows] = await pool.query(
    `SELECT
       s.*,
       inv.invoice_number,
       inv.pdf_path AS invoice_pdf_path,
       inv.document_status AS invoice_status,
       u.name AS creator_name,
       stk.quantity AS stock_current_quantity
     FROM sales s
     LEFT JOIN invoices inv ON s.invoice_id = inv.id
     LEFT JOIN users u ON s.created_by = u.id
     LEFT JOIN stock stk ON s.product_id = stk.id
     WHERE s.id = ?`,
    [saleId]
  );

  if (!rows.length) {
    throw new ApiError(404, "Sale not found.");
  }

  const sale = rows[0];

  // Scoped authorization
  if (!tenant.isSuperadmin && sale.user_id !== tenant.businessOwnerId) {
    throw new ApiError(403, "Access denied: you do not have permission to view this sale.");
  }

  const [items] = await pool.query(
    "SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC",
    [saleId]
  );
  sale.items = items;
  if (items.length === 1) {
    sale.items_summary = items[0].product_name;
  } else if (items.length > 1) {
    sale.items_summary = `${items[0].product_name} (+${items.length - 1} more)`;
  } else {
    sale.items_summary = sale.product_name;
  }

  res.json({ success: true, sale });
});

/**
 * Helper to generate official production invoice and PDF for sales
 */
async function createSalesTaxInvoice({
  conn,
  tenant,
  saleId = null,
  customerData,
  items,
  invoiceDate,
  notes,
  gstRate = 0,
}) {
  const [userRows] = await conn.query("SELECT * FROM users WHERE id = ?", [tenant.businessOwnerId]);
  const user = userRows[0];
  if (!user) throw new ApiError(404, "Tenant user not found.");

  const docNumber = await generateInvoiceNumber(conn, invoiceDate);

  let subtotal = 0;
  let totalCalculatedTax = 0;

  const calculatedItems = items.map((it) => {
    const qty = cleanNumber(it.quantity, 1);
    const rate = cleanNumber(it.unit_price || it.price, 0);
    const disc = cleanNumber(it.discount, 0);
    const taxable = roundMoney(qty * rate - disc);
    const taxRate = cleanNumber(it.tax_rate !== undefined ? it.tax_rate : gstRate, 0);
    const taxAmount = roundMoney((taxable * taxRate) / 100);
    const lineTotal = roundMoney(taxable + taxAmount);

    subtotal += taxable;
    totalCalculatedTax += taxAmount;

    return {
      product_id: it.product_id || null,
      product_name: it.product_name || "Item",
      quantity: qty,
      price: rate,
      unit: it.unit || "pcs",
      discount_amount: disc,
      taxable_amount: taxable,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      line_total: lineTotal,
    };
  });

  subtotal = roundMoney(subtotal);
  totalCalculatedTax = roundMoney(totalCalculatedTax);

  // Determine State / Place of Supply for GST (Intra vs Inter state)
  const sellerState = String(user.state || "").trim().toLowerCase();
  const buyerState = String(customerData.billing_state || customerData.state || "").trim().toLowerCase();
  const isInterState = sellerState && buyerState && sellerState !== buyerState;

  let cgstRate = 0;
  let cgstAmount = 0;
  let sgstRate = 0;
  let sgstAmount = 0;
  let igstRate = 0;
  let igstAmount = 0;
  const effectiveGstRate =
    cleanNumber(gstRate, 0) ||
    (subtotal > 0 && totalCalculatedTax > 0 ? roundMoney((totalCalculatedTax / subtotal) * 100) : 0);

  if (totalCalculatedTax > 0 || effectiveGstRate > 0) {
    if (isInterState) {
      igstRate = effectiveGstRate;
      igstAmount = totalCalculatedTax;
    } else {
      cgstRate = effectiveGstRate / 2;
      cgstAmount = roundMoney(totalCalculatedTax / 2);
      sgstRate = effectiveGstRate / 2;
      sgstAmount = roundMoney(totalCalculatedTax - cgstAmount);
    }
  }

  const totalAmount = roundMoney(subtotal + cgstAmount + sgstAmount + igstAmount);

  // Insert into invoices
  const [invResult] = await conn.query(
    `INSERT INTO invoices (
       doc_type, invoice_number, customer_id, invoice_date, subtotal, total_amount,
       document_status, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount,
       currency, notes,
       from_name, from_business_name, from_email, from_phone, from_gstin, from_pan,
       from_address_line1, from_city, from_state, from_pincode, from_country,
       from_logo_path, from_signature_path,
       to_name, to_business_name, to_email, to_phone, to_gstin,
       to_billing_state, to_billing_city, to_billing_pincode,
       sale_id, created_by
     ) VALUES (
       'invoice', ?, ?, ?, ?, ?,
       'issued', ?, ?, ?, ?, ?, ?,
       'INR', ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, 'India',
       ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?
     )`,
    [
      docNumber,
      customerData.customer_id || null,
      invoiceDate || formatCurrentDate(),
      subtotal,
      totalAmount,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      notes || null,
      user.name || null,
      user.business_name || null,
      user.email || null,
      user.phone || null,
      user.gstin || null,
      user.pan || null,
      user.address_line1 || user.address || null,
      user.city || null,
      user.state || null,
      user.pincode || null,
      user.logo_path || null,
      user.signature_path || null,
      customerData.customer_name || null,
      customerData.business_name || null,
      customerData.customer_email || null,
      customerData.customer_phone || null,
      customerData.customer_gstin || null,
      customerData.billing_state || customerData.state || null,
      customerData.billing_city || customerData.city || null,
      customerData.billing_pincode || customerData.pincode || null,
      saleId || null,
      tenant.businessOwnerId,
    ]
  );

  const invoiceId = invResult.insertId;

  // Insert line items
  for (const item of calculatedItems) {
    await conn.query(
      `INSERT INTO invoice_items (
         invoice_id, product_id, product_name, quantity, price, amount,
         unit, discount_amount, tax_rate, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        item.product_id,
        item.product_name,
        item.quantity,
        item.price,
        item.taxable_amount,
        item.unit,
        item.discount_amount,
        item.tax_rate,
        item.tax_amount,
        item.line_total,
      ]
    );
  }

  // Generate PDF using production renderer
  try {
    const [fetchedInvoiceRows] = await conn.query("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
    const doc = fetchedInvoiceRows[0];
    const [itemRows] = await conn.query("SELECT * FROM invoice_items WHERE invoice_id = ?", [invoiceId]);

    const company = {
      company_name: doc.from_business_name || doc.from_name || "KhataNex",
      business_name: doc.from_business_name || "",
      name: doc.from_name || "",
      email: doc.from_email || "",
      phone: doc.from_phone || "",
      gstin: doc.from_gstin || "",
      pan: doc.from_pan || "",
      address_line1: doc.from_address_line1 || "",
      city: doc.from_city || "",
      state: doc.from_state || "",
      pincode: doc.from_pincode || "",
      country: doc.from_country || "India",
      logo_path: doc.from_logo_path || null,
      signature_path: doc.from_signature_path || null,
      watermark_enabled: user.watermark_enabled !== 0 ? 1 : 0,
    };

    const absPdfPath = await generateDocumentPdf({
      doc,
      customer: {
        name: doc.to_name,
        display_name: doc.to_name,
        phone: doc.to_phone,
        email: doc.to_email,
        gstin: doc.to_gstin,
        billing_state: doc.to_billing_state,
        billing_city: doc.to_billing_city,
        billing_pincode: doc.to_billing_pincode,
      },
      items: itemRows,
      company,
    });

    const pdfRelPath = relativeUploadPath(absPdfPath);
    await conn.query("UPDATE invoices SET pdf_path = ? WHERE id = ?", [pdfRelPath, invoiceId]);
    doc.pdf_path = pdfRelPath;

    return { invoiceId, invoiceNumber: docNumber, pdfPath: pdfRelPath, invoice: doc };
  } catch (pdfErr) {
    console.error("PDF generation warning for sales invoice:", pdfErr);
    return { invoiceId, invoiceNumber: docNumber, pdfPath: null };
  }
}

/**
 * POST /api/sales
 * Create a new sale with support for multiple line items, inventory decrement,
 * payment recording (cash/bank), and optional invoice generation.
 */
const createSale = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "create")) {
    throw new ApiError(403, "Access denied: you do not have permission to record sales.");
  }

  const {
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_gstin,
    billing_state,
    state,
    items,
    // Legacy single item fields
    product_id,
    product_name,
    category,
    quantity = 1,
    unit = "pcs",
    unit_price = 0,
    discount = 0,
    tax_rate = 0,
    item_type = "goods",
    hsn_code,
    // Payment details
    payment_mode = "cash",
    paid_amount,
    bank_id,
    sale_date,
    sale_time,
    notes,
    create_invoice = false,
    gst_rate = 0,
  } = req.body;

  // 1. Prepare and normalize item list (supporting multi-item or single item fallback)
  let rawItems = [];
  if (Array.isArray(items) && items.length > 0) {
    rawItems = items;
  } else if (product_name || product_id) {
    rawItems = [
      {
        product_id,
        product_name,
        category,
        quantity,
        unit,
        unit_price,
        discount,
        tax_rate: tax_rate || gst_rate,
        item_type: item_type || "goods",
        hsn_code,
      },
    ];
  }

  if (rawItems.length === 0) {
    throw new ApiError(400, "Please provide at least one product or service item for the sale.");
  }

  // 2. Customer details handling (Existing vs Walk-in)
  let resolvedCustomerId = customer_id ? Number(customer_id) : null;
  let finalCustomerName = String(customer_name || "").trim();
  let custPhone = customer_phone ? String(customer_phone).trim() : null;
  let custEmail = customer_email ? String(customer_email).trim() : null;
  let custAddress = customer_address ? String(customer_address).trim() : null;
  let custGstin = customer_gstin ? String(customer_gstin).trim() : null;
  let custState = billing_state || state ? String(billing_state || state).trim() : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (resolvedCustomerId) {
      const [custRows] = await conn.query(
        "SELECT * FROM customers WHERE id = ? AND created_by = ?",
        [resolvedCustomerId, tenant.businessOwnerId]
      );
      if (custRows.length > 0) {
        const c = custRows[0];
        finalCustomerName = finalCustomerName || c.name || c.business_name || "Customer";
        custPhone = custPhone || c.phone;
        custEmail = custEmail || c.email;
        custAddress = custAddress || c.address_line1 || c.billing_city || c.address;
        custGstin = custGstin || c.gstin;
        custState = custState || c.billing_state || c.state;
      } else {
        throw new ApiError(404, "Selected customer not found.");
      }
    } else {
      if (!finalCustomerName) {
        finalCustomerName = "Walk-in Customer";
      }
    }

    const finalSaleDate = sale_date || formatCurrentDate();
    const finalSaleTime = sale_time || formatCurrentTime();
    const saleNumber = await generateSaleNumber(conn, finalSaleDate);

    // 3. Process each line item, validate stock, and calculate amounts
    let calculatedSubtotal = 0;
    let calculatedTotalTax = 0;
    let totalQuantity = 0;
    let totalDiscount = 0;

    const validatedItems = [];

    for (const raw of rawItems) {
      const itName = String(raw.product_name || raw.name || "").trim();
      if (!itName) {
        throw new ApiError(400, "Every item must have a valid name.");
      }

      const itQty = cleanNumber(raw.quantity, 1);
      if (itQty <= 0) {
        throw new ApiError(400, `Quantity for "${itName}" must be greater than zero.`);
      }

      const itPrice = cleanNumber(raw.unit_price !== undefined ? raw.unit_price : raw.price, 0);
      if (itPrice < 0) {
        throw new ApiError(400, `Unit price for "${itName}" cannot be negative.`);
      }

      const itDisc = cleanNumber(raw.discount, 0);
      const itTaxRate = cleanNumber(raw.tax_rate !== undefined ? raw.tax_rate : gst_rate, 0);
      const itType = raw.item_type === "service" || raw.type === "service" ? "service" : "goods";
      const itUnit = raw.unit || "pcs";
      const itHsn = raw.hsn_code || raw.hsn || null;
      const itCat = raw.category || null;
      let itProdId = raw.product_id ? Number(raw.product_id) : null;

      // Inventory check & decrement (Goods only, Services do not reduce inventory)
      if (itType === "goods" && itProdId) {
        const [stockRows] = await conn.query(
          "SELECT id, product_name, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
          [itProdId, tenant.businessOwnerId]
        );
        if (stockRows.length > 0) {
          const stockItem = stockRows[0];
          const availableStock = Number(stockItem.quantity || 0);
          if (availableStock < itQty) {
            throw new ApiError(
              400,
              `Insufficient stock for "${stockItem.product_name}". Requested: ${itQty}, Available: ${availableStock}`
            );
          }

          // Decrement stock
          await conn.query(
            "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
            [itQty, itProdId, tenant.businessOwnerId]
          );
        } else {
          itProdId = null;
        }
      }

      const taxableAmount = roundMoney(itQty * itPrice - itDisc);
      const taxAmount = roundMoney((taxableAmount * itTaxRate) / 100);
      const lineTotal = roundMoney(taxableAmount + taxAmount);

      calculatedSubtotal += taxableAmount;
      calculatedTotalTax += taxAmount;
      totalQuantity += itQty;
      totalDiscount += itDisc;

      validatedItems.push({
        product_id: itProdId,
        product_name: itName,
        category: itCat,
        quantity: itQty,
        unit: itUnit,
        unit_price: itPrice,
        discount: itDisc,
        tax_rate: itTaxRate,
        tax_amount: taxAmount,
        total_amount: lineTotal,
        item_type: itType,
        hsn_code: itHsn,
      });
    }

    calculatedSubtotal = roundMoney(calculatedSubtotal);
    calculatedTotalTax = roundMoney(calculatedTotalTax);
    const calculatedTotalAmount = roundMoney(calculatedSubtotal + calculatedTotalTax);

    // 4. Payment calculations
    const cleanPaidAmount = paid_amount !== undefined && paid_amount !== null && paid_amount !== ""
      ? cleanNumber(paid_amount, calculatedTotalAmount)
      : calculatedTotalAmount;

    const numPaid = Math.max(0, roundMoney(cleanPaidAmount));
    const dueAmount = Math.max(0, roundMoney(calculatedTotalAmount - numPaid));

    let paymentStatus = "paid";
    if (numPaid >= calculatedTotalAmount) {
      paymentStatus = "paid";
    } else if (numPaid > 0 && numPaid < calculatedTotalAmount) {
      paymentStatus = "partial";
    } else {
      paymentStatus = "unpaid";
    }

    const primaryItem = validatedItems[0];
    const itemsSummary =
      validatedItems.length === 1
        ? primaryItem.product_name
        : `${primaryItem.product_name} (+${validatedItems.length - 1} more)`;

    // 5. Insert into sales table
    const [saleResult] = await conn.query(
      `INSERT INTO sales (
         user_id, sale_number, customer_id, customer_name, customer_phone, customer_email,
         customer_address, customer_gstin, product_id, product_name, category,
         quantity, unit, unit_price, discount, subtotal, tax_amount, payment_mode, bank_id,
         amount, paid_amount, due_amount, payment_status,
         sale_date, sale_time, notes, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenant.businessOwnerId,
        saleNumber,
        resolvedCustomerId,
        finalCustomerName,
        custPhone,
        custEmail,
        custAddress,
        custGstin,
        primaryItem.product_id,
        itemsSummary,
        primaryItem.category,
        totalQuantity,
        primaryItem.unit,
        primaryItem.unit_price,
        totalDiscount,
        calculatedSubtotal,
        calculatedTotalTax,
        payment_mode || "cash",
        bank_id ? Number(bank_id) : null,
        calculatedTotalAmount,
        numPaid,
        dueAmount,
        paymentStatus,
        finalSaleDate,
        finalSaleTime,
        notes || null,
        tenant.actorId,
      ]
    );

    const saleId = saleResult.insertId;

    // 6. Insert line items into sale_items
    for (const it of validatedItems) {
      await conn.query(
        `INSERT INTO sale_items (
           sale_id, product_id, product_name, category, quantity, unit,
           unit_price, discount, tax_rate, tax_amount, total_amount,
           item_type, hsn_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          saleId,
          it.product_id,
          it.product_name,
          it.category,
          it.quantity,
          it.unit,
          it.unit_price,
          it.discount,
          it.tax_rate,
          it.tax_amount,
          it.total_amount,
          it.item_type,
          it.hsn_code,
        ]
      );
    }

    // 7. Payment Ledger Integration: Record payment if paid_amount > 0
    let paymentId = null;
    if (numPaid > 0) {
      const paymentDate = finalSaleDate;
      const normalizedPaymentMode = (payment_mode && String(payment_mode).trim().toLowerCase() === "cash") ? "cash" : "online";

      const [payResult] = await conn.query(
        `INSERT INTO payments (
           payment_category, party_name, customer_id, purpose, amount,
           payment_mode, payment_date, product_id, product_name, quantity,
           unit_price, sale_id, created_by
         ) VALUES (
           'product_sale', ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?
         )`,
        [
          finalCustomerName,
          resolvedCustomerId,
          `Product Sale - ${saleNumber}`,
          numPaid,
          normalizedPaymentMode,
          paymentDate,
          primaryItem.product_id,
          itemsSummary,
          totalQuantity,
          primaryItem.unit_price,
          saleId,
          tenant.businessOwnerId,
        ]
      );
      paymentId = payResult.insertId;
      await conn.query("UPDATE sales SET payment_id = ? WHERE id = ?", [paymentId, saleId]);
    }

    // 8. If requested, generate official production invoice
    let generatedInvoice = null;
    if (create_invoice) {
      generatedInvoice = await createSalesTaxInvoice({
        conn,
        tenant,
        saleId,
        customerData: {
          customer_id: resolvedCustomerId,
          customer_name: finalCustomerName,
          customer_phone: custPhone,
          customer_email: custEmail,
          customer_address: custAddress,
          customer_gstin: custGstin,
          state: custState,
          billing_state: custState,
        },
        items: validatedItems,
        invoiceDate: finalSaleDate,
        notes: notes || `Generated from Sale ${saleNumber}`,
        gstRate: cleanNumber(gst_rate, validatedItems[0]?.tax_rate || 0),
      });

      // Link invoice_id to sale
      await conn.query("UPDATE sales SET invoice_id = ? WHERE id = ?", [generatedInvoice.invoiceId, saleId]);
    }

    await conn.commit();

    // Fetch created sale record with joined details
    const [fetchedRows] = await pool.query(
      `SELECT
         s.*,
         inv.invoice_number,
         inv.pdf_path AS invoice_pdf_path,
         inv.document_status AS invoice_status,
         u.name AS creator_name
       FROM sales s
       LEFT JOIN invoices inv ON s.invoice_id = inv.id
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = ?`,
      [saleId]
    );

    const createdSale = fetchedRows[0];
    createdSale.items = validatedItems;
    createdSale.items_summary = itemsSummary;

    logAuditEvent(req, {
      action: "create_sale",
      target_type: "sale",
      target_id: saleId,
      metadata: {
        amount: calculatedTotalAmount,
        paid_amount: numPaid,
        sale_number: saleNumber,
        invoice_id: generatedInvoice?.invoiceId,
        payment_id: paymentId,
      },
    });

    res.status(201).json({
      success: true,
      message: `Sale ${saleNumber} recorded successfully.`,
      sale: createdSale,
      invoice: generatedInvoice,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/**
 * POST /api/sales/:id/create-invoice
 * One-click action to create an official tax invoice from an existing un-invoiced sale
 */
const createInvoiceForSale = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  const saleId = Number(req.params.id);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "create")) {
    throw new ApiError(403, "Access denied: you do not have permission to generate invoices from sales.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [sales] = await conn.query("SELECT * FROM sales WHERE id = ? FOR UPDATE", [saleId]);
    if (!sales.length) {
      throw new ApiError(404, "Sale not found.");
    }

    const sale = sales[0];
    if (!tenant.isSuperadmin && sale.user_id !== tenant.businessOwnerId) {
      throw new ApiError(403, "Access denied for this sale.");
    }

    // Idempotent: If invoice is already linked, return existing invoice without duplicating!
    if (sale.invoice_id) {
      const [invRows] = await conn.query("SELECT * FROM invoices WHERE id = ?", [sale.invoice_id]);
      if (invRows.length > 0) {
        await conn.commit();
        return res.json({
          success: true,
          message: `Invoice ${invRows[0].invoice_number} is already generated for this sale.`,
          is_existing: true,
          invoice: {
            invoiceId: invRows[0].id,
            invoiceNumber: invRows[0].invoice_number,
            pdfPath: invRows[0].pdf_path,
            invoice: invRows[0],
          },
        });
      }
    }

    // Fetch line items for this sale
    const [items] = await conn.query("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC", [saleId]);
    const invoiceItems = items.length > 0
      ? items.map((it) => ({
          product_id: it.product_id,
          product_name: it.product_name,
          quantity: it.quantity,
          unit: it.unit || "pcs",
          unit_price: it.unit_price,
          discount: it.discount || 0,
          tax_rate: it.tax_rate || 0,
        }))
      : [
          {
            product_id: sale.product_id,
            product_name: sale.product_name,
            quantity: sale.quantity,
            unit: sale.unit || "pcs",
            unit_price: sale.unit_price,
            discount: sale.discount || 0,
            tax_rate: 0,
          },
        ];

    const generatedInvoice = await createSalesTaxInvoice({
      conn,
      tenant,
      saleId,
      customerData: {
        customer_id: sale.customer_id,
        customer_name: sale.customer_name,
        customer_phone: sale.customer_phone,
        customer_email: sale.customer_email,
        customer_address: sale.customer_address,
        customer_gstin: sale.customer_gstin,
        billing_state: req.body.billing_state || req.body.state,
      },
      items: invoiceItems,
      invoiceDate: req.body.invoice_date || sale.sale_date,
      notes: req.body.notes || `Generated from Sale #${sale.sale_number || sale.id}`,
      gstRate: cleanNumber(req.body.gst_rate, 0),
    });

    // Link invoice_id to sale
    await conn.query("UPDATE sales SET invoice_id = ? WHERE id = ?", [generatedInvoice.invoiceId, saleId]);

    await conn.commit();

    logAuditEvent(req, {
      action: "create_invoice_for_sale",
      target_type: "invoice",
      target_id: generatedInvoice.invoiceId,
      metadata: { sale_id: saleId, invoice_number: generatedInvoice.invoiceNumber },
    });

    res.status(201).json({
      success: true,
      message: `Invoice ${generatedInvoice.invoiceNumber} generated successfully.`,
      invoice: generatedInvoice,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/**
 * PUT /api/sales/:id
 * Update an existing sale
 */
const updateSale = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  const saleId = Number(req.params.id);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "edit")) {
    throw new ApiError(403, "Access denied: you do not have permission to edit sales.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query("SELECT * FROM sales WHERE id = ? FOR UPDATE", [saleId]);
    if (!rows.length) {
      throw new ApiError(404, "Sale not found.");
    }

    const sale = rows[0];
    if (!tenant.isSuperadmin && sale.user_id !== tenant.businessOwnerId) {
      throw new ApiError(403, "Access denied: you do not have permission to modify this sale.");
    }

    const {
      customer_name,
      customer_phone,
      customer_email,
      customer_address,
      customer_gstin,
      category,
      payment_mode,
      paid_amount,
      sale_date,
      sale_time,
      notes,
    } = req.body;

    let updatedPaidAmount = sale.paid_amount;
    let updatedDueAmount = sale.due_amount;
    let updatedPaymentStatus = sale.payment_status;

    if (paid_amount !== undefined && paid_amount !== null) {
      updatedPaidAmount = Math.max(0, cleanNumber(paid_amount, sale.amount));
      updatedDueAmount = Math.max(0, roundMoney(sale.amount - updatedPaidAmount));
      if (updatedPaidAmount >= sale.amount) {
        updatedPaymentStatus = "paid";
      } else if (updatedPaidAmount > 0) {
        updatedPaymentStatus = "partial";
      } else {
        updatedPaymentStatus = "unpaid";
      }

      // Update linked payment record if exists
      if (sale.payment_id) {
        await conn.query(
          "UPDATE payments SET amount = ?, payment_mode = ? WHERE id = ? AND created_by = ?",
          [
            updatedPaidAmount,
            (payment_mode || sale.payment_mode) === "cash" ? "cash" : "online",
            sale.payment_id,
            tenant.businessOwnerId,
          ]
        );
      }
    }

    await conn.query(
      `UPDATE sales SET
         customer_name = COALESCE(?, customer_name),
         customer_phone = COALESCE(?, customer_phone),
         customer_email = COALESCE(?, customer_email),
         customer_address = COALESCE(?, customer_address),
         customer_gstin = COALESCE(?, customer_gstin),
         category = COALESCE(?, category),
         payment_mode = COALESCE(?, payment_mode),
         paid_amount = ?,
         due_amount = ?,
         payment_status = ?,
         sale_date = COALESCE(?, sale_date),
         sale_time = COALESCE(?, sale_time),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
      [
        customer_name || null,
        customer_phone || null,
        customer_email || null,
        customer_address || null,
        customer_gstin || null,
        category || null,
        payment_mode || null,
        updatedPaidAmount,
        updatedDueAmount,
        updatedPaymentStatus,
        sale_date || null,
        sale_time || null,
        notes || null,
        saleId,
      ]
    );

    await conn.commit();

    const [updatedRows] = await pool.query(
      `SELECT s.*, inv.invoice_number, inv.pdf_path AS invoice_pdf_path
       FROM sales s
       LEFT JOIN invoices inv ON s.invoice_id = inv.id
       WHERE s.id = ?`,
      [saleId]
    );

    res.json({
      success: true,
      message: "Sale updated successfully.",
      sale: updatedRows[0],
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/**
 * DELETE /api/sales/:id
 * Delete a sale, restoring stock for physical goods and removing linked payments
 */
const deleteSale = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  const saleId = Number(req.params.id);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "delete")) {
    throw new ApiError(403, "Access denied: you do not have permission to delete sales.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query("SELECT * FROM sales WHERE id = ? FOR UPDATE", [saleId]);
    if (!rows.length) {
      throw new ApiError(404, "Sale not found.");
    }

    const sale = rows[0];
    if (!tenant.isSuperadmin && sale.user_id !== tenant.businessOwnerId) {
      throw new ApiError(403, "Access denied: you do not have permission to delete this sale.");
    }

    // 1. If sale has an invoice that is issued, warn or prevent accidental deletion
    if (sale.invoice_id) {
      const [invRows] = await conn.query("SELECT id, invoice_number, document_status FROM invoices WHERE id = ?", [sale.invoice_id]);
      if (invRows.length > 0 && invRows[0].document_status === "issued") {
        throw new ApiError(
          400,
          `Cannot delete sale #${sale.id} because it is linked to active tax invoice "${invRows[0].invoice_number}". Please cancel or delete the invoice first.`
        );
      }
    }

    // 2. Restore inventory for all goods items in sale_items (services do not restore inventory)
    const [saleItems] = await conn.query("SELECT * FROM sale_items WHERE sale_id = ?", [saleId]);
    if (saleItems.length > 0) {
      for (const it of saleItems) {
        if (it.item_type !== "service" && it.product_id && Number(it.quantity) > 0) {
          await conn.query(
            "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
            [it.quantity, it.product_id, sale.user_id]
          );
        }
      }
    } else if (sale.product_id && Number(sale.quantity) > 0) {
      // Fallback for legacy single item sale
      await conn.query(
        "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
        [sale.quantity, sale.product_id, sale.user_id]
      );
    }

    // 3. Delete linked payment from payments table
    if (sale.payment_id) {
      await conn.query("DELETE FROM payments WHERE id = ? AND created_by = ?", [sale.payment_id, sale.user_id]);
    }
    await conn.query("DELETE FROM payments WHERE sale_id = ? AND created_by = ?", [saleId, sale.user_id]);

    // 4. Delete sale (sale_items are CASCADE deleted via FK fk_sale_items_sale)
    await conn.query("DELETE FROM sales WHERE id = ?", [saleId]);

    await conn.commit();

    logAuditEvent(req, {
      action: "delete_sale",
      target_type: "sale",
      target_id: saleId,
    });

    res.json({
      success: true,
      message: `Sale #${saleId} deleted successfully and inventory restored.`,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/**
 * POST /api/sales/generate-invoice
 * Batch generate an official tax invoice from one or more un-invoiced sales
 */
const generateInvoiceFromSales = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);

  if (tenant.isEmployee && !hasPermission(req.user, "sales", "create")) {
    throw new ApiError(403, "Access denied: you do not have permission to generate invoices from sales.");
  }

  const { sale_ids, gst_rate = 0, invoice_date, notes } = req.body;

  if (!Array.isArray(sale_ids) || sale_ids.length === 0) {
    throw new ApiError(400, "Please select at least one sale to generate an invoice.");
  }

  const sanitizedIds = sale_ids.map((id) => Number(id)).filter((id) => !Number.isNaN(id) && id > 0);
  if (sanitizedIds.length === 0) {
    throw new ApiError(400, "Invalid sale IDs provided.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Fetch all selected sales under lock
    const [sales] = await conn.query(
      `SELECT * FROM sales WHERE id IN (${sanitizedIds.map(() => "?").join(",")}) FOR UPDATE`,
      sanitizedIds
    );

    if (sales.length !== sanitizedIds.length) {
      throw new ApiError(404, "One or more selected sales could not be found.");
    }

    // 2. Validate tenant ownership and un-invoiced status
    for (const sale of sales) {
      if (!tenant.isSuperadmin && sale.user_id !== tenant.businessOwnerId) {
        throw new ApiError(403, `Access denied for sale #${sale.id}.`);
      }
      if (sale.invoice_id) {
        throw new ApiError(400, `Sale #${sale.id} has already been invoiced.`);
      }
    }

    // 3. Validate customer consistency across all sales
    const firstSale = sales[0];
    const firstCustomerName = String(firstSale.customer_name).trim().toLowerCase();
    const firstCustomerPhone = String(firstSale.customer_phone || "").trim();

    for (let i = 1; i < sales.length; i++) {
      const s = sales[i];
      const sName = String(s.customer_name).trim().toLowerCase();
      const sPhone = String(s.customer_phone || "").trim();

      const sameCustomer =
        (firstSale.customer_id && s.customer_id && firstSale.customer_id === s.customer_id) ||
        (firstCustomerName === sName && (!firstCustomerPhone || !sPhone || firstCustomerPhone === sPhone));

      if (!sameCustomer) {
        throw new ApiError(
          400,
          `Cannot combine sales for different customers into a single invoice. Sale #${firstSale.id} is for "${firstSale.customer_name}", but Sale #${s.id} is for "${s.customer_name}".`
        );
      }
    }

    // 4. Fetch line items for all sales
    const [allItems] = await conn.query(
      `SELECT * FROM sale_items WHERE sale_id IN (${sanitizedIds.map(() => "?").join(",")})`,
      sanitizedIds
    );

    let invoiceItems = [];
    if (allItems.length > 0) {
      invoiceItems = allItems.map((it) => ({
        product_id: it.product_id,
        product_name: it.product_name,
        quantity: it.quantity,
        unit: it.unit || "pcs",
        unit_price: it.unit_price,
        discount: it.discount || 0,
        tax_rate: it.tax_rate !== undefined ? it.tax_rate : cleanNumber(gst_rate, 0),
      }));
    } else {
      invoiceItems = sales.map((s) => ({
        product_id: s.product_id,
        product_name: s.product_name,
        quantity: s.quantity,
        unit: s.unit || "pcs",
        unit_price: s.unit_price,
        discount: s.discount || 0,
        tax_rate: cleanNumber(gst_rate, 0),
      }));
    }

    // 5. Generate production invoice (with skip_inventory_decrement since stock was already decremented on sale creation)
    const generatedInvoice = await createSalesTaxInvoice({
      conn,
      tenant,
      saleId: sanitizedIds[0],
      customerData: {
        customer_id: firstSale.customer_id,
        customer_name: firstSale.customer_name,
        customer_phone: firstSale.customer_phone,
        customer_email: firstSale.customer_email,
        customer_address: firstSale.customer_address,
        customer_gstin: firstSale.customer_gstin,
        state: req.body.state || req.body.billing_state,
        billing_state: req.body.state || req.body.billing_state,
      },
      items: invoiceItems,
      invoiceDate: invoice_date || formatCurrentDate(),
      notes: notes || `Generated for Sales: ${sanitizedIds.map((id) => `#${id}`).join(", ")}`,
      gstRate: cleanNumber(gst_rate, 0),
    });

    // 6. Link invoice_id to all selected sales
    await conn.query(
      `UPDATE sales SET invoice_id = ? WHERE id IN (${sanitizedIds.map(() => "?").join(",")})`,
      [generatedInvoice.invoiceId, ...sanitizedIds]
    );

    await conn.commit();

    logAuditEvent(req, {
      action: "generate_invoice_from_sales",
      target_type: "invoice",
      target_id: generatedInvoice.invoiceId,
      metadata: { sale_ids: sanitizedIds, invoice_number: generatedInvoice.invoiceNumber },
    });

    res.status(201).json({
      success: true,
      message: `Invoice ${generatedInvoice.invoiceNumber} successfully created for ${sanitizedIds.length} sale(s).`,
      invoice: generatedInvoice,
      invoiced_sale_ids: sanitizedIds,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = {
  getSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
  createInvoiceForSale,
  generateInvoiceFromSales,
};
