const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const SORTABLE = {
  name: "product_name",
  type: "type",
  price: "price",
  category: "category",
};

// Requirement 12: GST Inclusive / Exclusive calculation
// Inclusive:
//   base = enteredPrice / (1 + rate / 100)
//   gst = enteredPrice - base
//   total = enteredPrice
// Exclusive:
//   base = enteredPrice
//   gst = base * (rate / 100)
//   total = base + gst
const calculateStockGst = (price, gstRate, isInclusive) => {
  const enteredPrice = Math.max(0, Number(price || 0));
  const rate = Math.max(0, Number(gstRate || 0));

  let basePrice = 0;
  let gstAmount = 0;
  let totalPrice = 0;

  if (isInclusive) {
    basePrice = rate > 0 ? enteredPrice / (1 + rate / 100) : enteredPrice;
    gstAmount = enteredPrice - basePrice;
    totalPrice = enteredPrice;
  } else {
    basePrice = enteredPrice;
    gstAmount = (basePrice * rate) / 100;
    totalPrice = basePrice + gstAmount;
  }

  return {
    entered_price: enteredPrice,
    base_price: Math.round(basePrice * 100) / 100,
    gst_amount: Math.round(gstAmount * 100) / 100,
    total_price: Math.round(totalPrice * 100) / 100,
  };
};

// Requirement 14: Standardized Stock Status thresholds:
//   quantity > 10 -> In Stock (in_stock)
//   quantity > 0 && quantity <= 10 -> Low Stock (low_stock)
//   quantity <= 0 -> Out of Stock (out_of_stock)
const calculateStockStatus = (quantity) => {
  const qty = Number(quantity || 0);
  if (qty > 10) {
    return {
      stock_status: "in_stock",
      status_label: "In Stock",
    };
  }
  if (qty > 0 && qty <= 10) {
    return {
      stock_status: "low_stock",
      status_label: "Low Stock",
    };
  }
  return {
    stock_status: "out_of_stock",
    status_label: "Out of Stock",
  };
};

const enrichStockItem = (item) => {
  if (!item) return null;
  const isInclusive = Boolean(
    item.price_inclusive_gst === 1 ||
    item.price_inclusive_gst === true ||
    item.price_inclusive_gst === "1"
  );
  const gstCalc = calculateStockGst(item.price, item.gst_rate, isInclusive);
  const statusCalc = calculateStockStatus(item.quantity);

  return {
    ...item,
    price_inclusive_gst: isInclusive ? 1 : 0,
    ...gstCalc,
    ...statusCalc,
  };
};

const lookupLatestByHsn = async (hsn_code, userId) => {
  if (!hsn_code) return null;

  const [rows] = await pool.query(
    `SELECT product_name, quantity, unit, gst_rate,
            price_inclusive_gst, description, expense_type, type
     FROM stock
     WHERE hsn_code = ? AND created_by = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [hsn_code, userId]
  );

  if (rows.length) return rows[0];

  const [purchaseRows] = await pool.query(
    `SELECT product_name, quantity
     FROM purchase_invoices
     WHERE hsn_code = ? AND created_by = ?
     ORDER BY invoice_date DESC, created_at DESC
     LIMIT 1`,
    [hsn_code, userId]
  );

  return purchaseRows[0] || null;
};

// POST /api/stock
const addStock = asyncHandler(async (req, res) => {
  let {
    product_name,
    category,
    type,
    item_type,
    hsn_code,
    unit,
    gst_rate,
    price_inclusive_gst,
    description,
    expense_type,
    price,
    quantity,
    purchase_bill_id,
  } = req.body;

  const finalPurchaseBillId =
    purchase_bill_id !== undefined &&
    purchase_bill_id !== null &&
    purchase_bill_id !== ""
      ? Number(purchase_bill_id)
      : null;

  const finalType =
    item_type || type || "goods";

  // When creating Product Master from purchase history, calculate historical goods quantity
  let historicalPurchaseQty = 0;
  let historicalUnit = null;
  let historicalGstRate = null;

  if (finalType !== "service") {
    // 1. If purchase_bill_id is supplied, look up matching goods items in that bill
    if (finalPurchaseBillId) {
      const [billItemRows] = await pool.query(
        `SELECT COALESCE(SUM(pbi.quantity), 0) AS bill_qty, MAX(pbi.unit) AS unit, MAX(pbi.gst_rate) AS gst_rate
         FROM purchase_bill_items pbi
         JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
         WHERE pb.id = ? AND pb.created_by = ?
           AND pbi.item_type != 'service'
           AND (
             (pbi.item_name = ? AND ? != '')
             OR (pbi.hsn_code = ? AND ? IS NOT NULL)
           )`,
        [
          finalPurchaseBillId,
          req.user.id,
          product_name || "",
          product_name || "",
          hsn_code || null,
          hsn_code || null,
        ]
      );

      if (billItemRows.length && Number(billItemRows[0].bill_qty) > 0) {
        historicalPurchaseQty = Number(billItemRows[0].bill_qty);
        if (billItemRows[0].unit) historicalUnit = billItemRows[0].unit;
        if (billItemRows[0].gst_rate !== null && billItemRows[0].gst_rate !== undefined) {
          historicalGstRate = billItemRows[0].gst_rate;
        }
      }
    }

    // 2. Calculate accumulated historical purchase quantity for the same goods item across all purchase bills & invoices
    if (product_name || hsn_code) {
      const [accumulatedBillRows] = await pool.query(
        `SELECT COALESCE(SUM(pbi.quantity), 0) AS total_bill_qty
         FROM purchase_bill_items pbi
         JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
         WHERE pb.created_by = ?
           AND pbi.item_type != 'service'
           AND (
             (pbi.item_name = ? AND ? != '')
             OR (pbi.hsn_code = ? AND ? IS NOT NULL)
           )`,
        [
          req.user.id,
          product_name || "",
          product_name || "",
          hsn_code || null,
          hsn_code || null,
        ]
      );

      const [legacyInvoiceRows] = await pool.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total_invoice_qty
         FROM purchase_invoices
         WHERE created_by = ?
           AND (
             (product_name = ? AND ? != '')
             OR (hsn_code = ? AND ? IS NOT NULL)
           )`,
        [
          req.user.id,
          product_name || "",
          product_name || "",
          hsn_code || null,
          hsn_code || null,
        ]
      );

      const totalAccumulated =
        Number(accumulatedBillRows[0]?.total_bill_qty || 0) +
        Number(legacyInvoiceRows[0]?.total_invoice_qty || 0);

      if (totalAccumulated > 0) {
        historicalPurchaseQty = totalAccumulated;
      }
    }
  }

  // Look up metadata by HSN if provided (never use purchase price as selling price)
  if (hsn_code) {
    const match = await lookupLatestByHsn(hsn_code, req.user.id);

    if (match) {
      if (!unit && match.unit) unit = match.unit;
      if ((gst_rate === undefined || gst_rate === "") && match.gst_rate !== undefined) {
        gst_rate = match.gst_rate;
      }
      if (!description && match.description) description = match.description;
      if (!expense_type && match.expense_type) expense_type = match.expense_type;
      if (
        (quantity === undefined || quantity === null || quantity === "") &&
        historicalPurchaseQty === 0 &&
        match.quantity
      ) {
        historicalPurchaseQty = match.quantity;
      }
    }
  }

  if (!unit && historicalUnit) unit = historicalUnit;
  if ((gst_rate === undefined || gst_rate === "") && historicalGstRate !== null && historicalGstRate !== undefined) {
    gst_rate = historicalGstRate;
  }

  // stock.price remains Selling Price. Never use purchase price as stock.price.
  const finalPrice =
    price !== undefined &&
    price !== null &&
    price !== "" &&
    Number(price) >= 0
      ? Number(price)
      : 0;

  const finalGst =
    gst_rate !== undefined &&
    gst_rate !== null &&
    gst_rate !== ""
      ? Number(gst_rate)
      : 0;

  let finalQuantity = 0;
  if (quantity !== undefined && quantity !== null && quantity !== "") {
    finalQuantity = Number(quantity);
  } else if (finalType !== "service" && historicalPurchaseQty > 0) {
    finalQuantity = historicalPurchaseQty;
  }

  const [result] = await pool.query(
    `INSERT INTO stock
      (product_name, category, type, hsn_code, unit, gst_rate,
       price_inclusive_gst, description, expense_type, price, quantity, purchase_bill_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product_name || null,
      category || null,
      finalType,
      hsn_code || null,
      finalType === "service" ? null : unit || null,
      finalGst,
      price_inclusive_gst ? 1 : 0,
      description || null,
      expense_type || null,
      finalPrice,
      finalQuantity,
      finalPurchaseBillId,
      req.user.id,
    ]
  );

  if (finalPurchaseBillId) {
    await pool.query(
      `UPDATE purchase_bill_items pbi
       JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
       SET pbi.product_id = ?
       WHERE pb.id = ?
         AND pb.created_by = ?
         AND (pbi.product_id IS NULL OR pbi.product_id = ?)
         AND (
           (pbi.item_name = ? AND ? != '')
           OR (pbi.hsn_code = ? AND ? IS NOT NULL)
         )`,
      [
        result.insertId,
        finalPurchaseBillId,
        req.user.id,
        result.insertId,
        product_name || "",
        product_name || "",
        hsn_code || null,
        hsn_code || null,
      ]
    );
  }

  const [rows] = await pool.query(
    "SELECT * FROM stock WHERE id = ? AND created_by = ?",
    [result.insertId, req.user.id]
  );

  const enriched = enrichStockItem(rows[0]);

  res.status(201).json({
    success: true,
    stock: enriched,
  });
});

// GET /api/stock
const listStock = asyncHandler(async (req, res) => {
  const {
    sortBy = "name",
    order = "asc",
    search,
  } = req.query;

  const column = SORTABLE[sortBy] || "product_name";
  const direction =
    order.toLowerCase() === "desc" ? "DESC" : "ASC";

  let sql = `
    SELECT s.*, u.name AS added_by
    FROM stock s
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.created_by = ?
  `;

  const params = [req.user.id];

  if (search) {
    sql += `
      AND (
        s.product_name LIKE ?
        OR s.type LIKE ?
        OR s.category LIKE ?
        OR s.hsn_code LIKE ?
      )
    `;

    params.push(
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`
    );
  }

  sql += ` ORDER BY s.${column} ${direction}`;

  const [rows] = await pool.query(sql, params);
  const enrichedList = rows.map(enrichStockItem);

  res.json({
    success: true,
    count: enrichedList.length,
    stock: enrichedList,
  });
});

// PUT /api/stock/:id
const updateStock = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const {
    product_name,
    category,
    type,
    item_type,
    hsn_code,
    unit,
    gst_rate,
    price_inclusive_gst,
    description,
    expense_type,
    price,
    quantity,
    purchase_bill_id,
  } = req.body;

  const [rows] = await pool.query(
    "SELECT * FROM stock WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  if (!rows.length) {
    throw new ApiError(404, "Stock item not found.");
  }

  await pool.query(
    `UPDATE stock SET
      product_name = COALESCE(?, product_name),
      category = COALESCE(?, category),
      type = COALESCE(?, type),
      hsn_code = COALESCE(?, hsn_code),
      unit = COALESCE(?, unit),
      gst_rate = COALESCE(?, gst_rate),
      price_inclusive_gst = COALESCE(?, price_inclusive_gst),
      description = COALESCE(?, description),
      expense_type = COALESCE(?, expense_type),
      purchase_bill_id = COALESCE(?, purchase_bill_id),
      price = COALESCE(?, price),
      quantity = COALESCE(?, quantity)
     WHERE id = ? AND created_by = ?`,
    [
      product_name || null,
      category || null,
      item_type || type || null,
      hsn_code || null,
      unit || null,
      gst_rate ?? null,
      price_inclusive_gst === undefined
        ? null
        : price_inclusive_gst
          ? 1
          : 0,
      description || null,
      expense_type || null,
      purchase_bill_id !== undefined
        ? (purchase_bill_id ? Number(purchase_bill_id) : null)
        : null,
      price ?? null,
      quantity ?? null,
      id,
      req.user.id,
    ]
  );

  const [updated] = await pool.query(
    "SELECT * FROM stock WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  const enriched = enrichStockItem(updated[0]);

  res.json({
    success: true,
    stock: enriched,
  });
});

// DELETE /api/stock/:id
const deleteStock = asyncHandler(async (req, res) => {
  const stockId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT id FROM stock WHERE id = ? AND created_by = ?",
      [stockId, req.user.id]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Stock item not found.");
    }

    // Unlink foreign key references safely so purchase bills and payments remain intact
    await conn.query(
      "UPDATE purchase_bill_items SET product_id = NULL WHERE product_id = ?",
      [stockId]
    );

    await conn.query(
      "UPDATE payments SET product_id = NULL WHERE product_id = ?",
      [stockId]
    );

    const [result] = await conn.query(
      "DELETE FROM stock WHERE id = ? AND created_by = ?",
      [stockId, req.user.id]
    );

    if (!result.affectedRows) {
      await conn.rollback();
      throw new ApiError(404, "Stock item not found.");
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Stock item removed.",
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = {
  addStock,
  listStock,
  updateStock,
  deleteStock,
};
