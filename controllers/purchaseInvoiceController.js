const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { relativeUploadPath } = require("../utils/upload");

const isValidItem = (item) => {
  if (!item || typeof item !== "object") return false;
  const name = String(item.item_name || item.product_name || "").trim();
  const hasProductId =
    item.product_id !== undefined &&
    item.product_id !== null &&
    item.product_id !== "" &&
    Number(item.product_id) > 0;
  const qty = Number(item.quantity || 0);
  const price = Number(item.price || 0);

  return Boolean(name || hasProductId || (qty > 0 && price > 0));
};

const normalizeItem = (item) => {
  const itemType =
    item.item_type === "service" || item.type === "service" ? "service" : "goods";

  const qty = Math.max(0, Number(item.quantity || 0));
  const price = Math.max(0, Number(item.price || 0));
  const discount = Math.max(0, Number(item.discount || 0));
  const gstRate = Number(item.gst_rate !== undefined && item.gst_rate !== "" ? item.gst_rate : 0);

  const taxableAmount = Math.max(0, qty * price - discount);
  const gstAmount = Math.round(((taxableAmount * gstRate) / 100) * 100) / 100;
  const totalAmount = Math.round((taxableAmount + gstAmount) * 100) / 100;

  return {
    product_id:
      item.product_id !== undefined &&
      item.product_id !== null &&
      item.product_id !== ""
        ? Number(item.product_id)
        : null,

    item_name:
      item.item_name || item.product_name
        ? String(item.item_name || item.product_name).trim()
        : null,

    quantity: qty,
    price: price,
    discount: discount,
    unit: itemType === "goods" ? item.unit || null : null,
    item_type: itemType,
    gst_rate: gstRate,
    taxable_amount: taxableAmount,
    gst_amount: gstAmount,
    total_amount: totalAmount,
    hsn_code: item.hsn_code ? String(item.hsn_code).trim() : null,
  };
};

const enrichBillWithCalculations = (bill, items) => {
  const enrichedItems = (items || []).map((it) => {
    const qty = Number(it.quantity || 0);
    const price = Number(it.price || 0);
    const discount = Number(it.discount || 0);
    const gstRate = Number(it.gst_rate || 0);
    const taxable = Math.max(0, qty * price - discount);
    const gstAmt = Math.round(((taxable * gstRate) / 100) * 100) / 100;
    const totalAmt = Math.round((taxable + gstAmt) * 100) / 100;

    return {
      ...it,
      taxable_amount: taxable,
      gst_amount: gstAmt,
      total_amount: totalAmt,
    };
  });

  let totalTaxable = 0;
  let totalGst = 0;
  let totalAmount = 0;

  for (const it of enrichedItems) {
    totalTaxable += it.taxable_amount;
    totalGst += it.gst_amount;
    totalAmount += it.total_amount;
  }

  totalTaxable = Math.round(totalTaxable * 100) / 100;
  totalGst = Math.round(totalGst * 100) / 100;
  totalAmount = Math.round(totalAmount * 100) / 100;

  const itemNames = enrichedItems.map((i) => i.item_name).filter(Boolean);

  return {
    ...bill,
    items: enrichedItems,
    item_names: itemNames.join(", "),
    item_list: itemNames,
    total_taxable_amount: totalTaxable,
    total_gst: totalGst,
    total_gst_amount: totalGst,
    total_amount: totalAmount,
    total: totalAmount,
  };
};

const addPurchaseInvoice = asyncHandler(async (req, res) => {
  const {
    seller_name,
    invoice_number,
    product_name,
    hsn_code,
    quantity,
    price,
    invoice_date,
  } = req.body;

  const filePath = req.file
    ? relativeUploadPath(req.file.path)
    : null;

  const [result] = await pool.query(
    `INSERT INTO purchase_invoices
      (seller_name, invoice_number, product_name, hsn_code,
       quantity, price, invoice_file, invoice_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?)`,
    [
      seller_name || null,
      invoice_number || null,
      product_name || null,
      hsn_code || null,
      quantity || 0,
      price || 0,
      filePath,
      invoice_date || null,
      req.user.id,
    ]
  );

  const [rows] = await pool.query(
    `SELECT *
     FROM purchase_invoices
     WHERE id = ? AND created_by = ?`,
    [result.insertId, req.user.id]
  );

  res.status(201).json({
    success: true,
    purchase_invoice: rows[0],
  });
});

const lookupByHsn = asyncHandler(async (req, res) => {
  const { hsn_code } = req.query;

  if (!hsn_code) {
    return res.json({
      success: true,
      found: false,
    });
  }

  const [rows] = await pool.query(
    `SELECT product_name, hsn_code, quantity, price,
            seller_name, invoice_date
     FROM purchase_invoices
     WHERE hsn_code = ? AND created_by = ?
     ORDER BY invoice_date DESC, created_at DESC
     LIMIT 1`,
    [hsn_code, req.user.id]
  );

  if (!rows.length) {
    return res.json({
      success: true,
      found: false,
    });
  }

  res.json({
    success: true,
    found: true,
    match: rows[0],
  });
});

const listPurchaseInvoices = asyncHandler(async (req, res) => {
  const { hsn_code, seller_name } = req.query;

  let sql = `
    SELECT p.*, u.name AS added_by
    FROM purchase_invoices p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.created_by = ?
  `;

  const params = [req.user.id];

  if (hsn_code) {
    sql += " AND p.hsn_code = ?";
    params.push(hsn_code);
  }

  if (seller_name) {
    sql += " AND p.seller_name LIKE ?";
    params.push(`%${seller_name}%`);
  }

  sql += `
    ORDER BY p.invoice_date DESC, p.created_at DESC
  `;

  const [rows] = await pool.query(sql, params);

  res.json({
    success: true,
    count: rows.length,
    purchase_invoices: rows,
  });
});

/*
 * POST /api/purchase-invoices/bills
 * Multi-item purchase bill with item-level GST.
 */
const addPurchaseBill = asyncHandler(async (req, res) => {
  const {
    bill_number,
    vendor_name,
    bill_date,
    items,
  } = req.body;

  let parsedItems = items;

  if (typeof parsedItems === "string") {
    try {
      parsedItems = JSON.parse(parsedItems);
    } catch (_) {
      parsedItems = [];
    }
  }

  const validItems = Array.isArray(parsedItems)
    ? parsedItems.filter(isValidItem).map((item) => normalizeItem(item))
    : [];

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [billResult] = await connection.query(
      `INSERT INTO purchase_bills
        (bill_number, vendor_name, bill_date, gst_rate, created_by)
       VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), 0, ?)`,
      [
        bill_number || null,
        vendor_name || null,
        bill_date || null,
        req.user.id,
      ]
    );

    const billId = billResult.insertId;

    for (const item of validItems) {
      let productId = item.product_id;
      if (!productId && item.item_name) {
        const [matching] = await connection.query(
          "SELECT id FROM stock WHERE product_name = ? AND created_by = ? LIMIT 1",
          [item.item_name, req.user.id]
        );
        if (matching.length) {
          productId = matching[0].id;
        }
      }

      await connection.query(
        `INSERT INTO purchase_bill_items
          (purchase_bill_id, product_id, item_name, quantity, price,
           discount, unit, item_type, gst_rate, hsn_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billId,
          productId,
          item.item_name,
          item.quantity,
          item.price,
          item.discount,
          item.unit,
          item.item_type,
          item.gst_rate,
          item.hsn_code,
        ]
      );

      /*
       * A Goods purchase increases inventory quantity.
       * Services do not enter physical stock.
       * Never change Product Master selling price from purchase price.
       */
      if (item.item_type === "goods" && productId && item.quantity > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity + ?
           WHERE id = ? AND created_by = ?`,
          [
            item.quantity,
            productId,
            req.user.id,
          ]
        );
      }
    }

    await connection.commit();

    const [bills] = await pool.query(
      `SELECT *
       FROM purchase_bills
       WHERE id = ? AND created_by = ?`,
      [billId, req.user.id]
    );

    const [billItems] = await pool.query(
      `SELECT *
       FROM purchase_bill_items
       WHERE purchase_bill_id = ?
       ORDER BY id ASC`,
      [billId]
    );

    const enriched = enrichBillWithCalculations(bills[0], billItems);

    res.status(201).json({
      success: true,
      purchase_bill: enriched,
      items: enriched.items,
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

const listPurchaseBills = asyncHandler(async (req, res) => {
  const { search } = req.query;

  let sql = `
    SELECT pb.*,
           COUNT(pbi.id) AS item_count
    FROM purchase_bills pb
    LEFT JOIN purchase_bill_items pbi
      ON pbi.purchase_bill_id = pb.id
    WHERE pb.created_by = ?
  `;

  const params = [req.user.id];

  if (search) {
    sql += `
      AND (
        pb.bill_number LIKE ?
        OR pb.vendor_name LIKE ?
      )
    `;

    params.push(
      `%${search}%`,
      `%${search}%`
    );
  }

  sql += `
    GROUP BY pb.id
    ORDER BY pb.bill_date DESC, pb.created_at DESC
  `;

  const [rows] = await pool.query(sql, params);

  if (!rows.length) {
    return res.json({
      success: true,
      count: 0,
      purchase_bills: [],
    });
  }

  const ids = rows.map((b) => b.id);
  const placeholders = ids.map(() => "?").join(",");
  const [items] = await pool.query(
    `SELECT pbi.*, s.product_name AS stock_product_name
     FROM purchase_bill_items pbi
     LEFT JOIN stock s ON s.id = pbi.product_id
     WHERE pbi.purchase_bill_id IN (${placeholders})
     ORDER BY pbi.purchase_bill_id DESC, pbi.id ASC`,
    ids
  );

  const itemsByBill = {};
  for (const item of items) {
    if (!itemsByBill[item.purchase_bill_id]) {
      itemsByBill[item.purchase_bill_id] = [];
    }
    const resolvedName = item.item_name || item.product_name || item.stock_product_name || "Item";
    itemsByBill[item.purchase_bill_id].push({
      ...item,
      item_name: resolvedName,
    });
  }

  const enrichedBills = rows.map((bill) =>
    enrichBillWithCalculations(bill, itemsByBill[bill.id] || [])
  );

  res.json({
    success: true,
    count: enrichedBills.length,
    purchase_bills: enrichedBills,
  });
});

const getPurchaseBill = asyncHandler(async (req, res) => {
  const [bills] = await pool.query(
    `SELECT *
     FROM purchase_bills
     WHERE id = ? AND created_by = ?`,
    [req.params.id, req.user.id]
  );

  if (!bills.length) {
    throw new ApiError(404, "Purchase bill not found.");
  }

  const [items] = await pool.query(
    `SELECT pbi.*, s.product_name
     FROM purchase_bill_items pbi
     LEFT JOIN stock s ON s.id = pbi.product_id
     WHERE pbi.purchase_bill_id = ?
     ORDER BY pbi.id ASC`,
    [req.params.id]
  );

  const enriched = enrichBillWithCalculations(bills[0], items);

  res.json({
    success: true,
    purchase_bill: enriched,
    items: enriched.items,
  });
});

module.exports = {
  addPurchaseInvoice,
  lookupByHsn,
  listPurchaseInvoices,
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
};
