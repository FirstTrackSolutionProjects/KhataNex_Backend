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
  const resolvedItemType = item.item_type || item.type || "goods";

  return {
    ...item,
    item_type: resolvedItemType,
    type: item.type || resolvedItemType,
    price_inclusive_gst: isInclusive ? 1 : 0,
    ...gstCalc,
    ...statusCalc,
  };
};

const lookupLatestByHsn = async (hsn_code, userId) => {
  if (!hsn_code) return null;

  // 1. First check modern purchase_bill_items
  const [billItemRows] = await pool.query(
    `SELECT pbi.item_name AS product_name, pbi.quantity, pbi.unit, pbi.gst_rate,
            pbi.item_type, pbi.price AS purchase_price, pb.vendor_name AS seller_name,
            pb.bill_date AS invoice_date, pb.id AS purchase_bill_id, pbi.id AS purchase_bill_item_id
     FROM purchase_bill_items pbi
     JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
     WHERE pbi.hsn_code = ? AND pb.created_by = ?
     ORDER BY pb.bill_date DESC, pbi.id DESC
     LIMIT 1`,
    [hsn_code, userId]
  );
  if (billItemRows.length) return billItemRows[0];

  // 2. Check stock
  const [rows] = await pool.query(
    `SELECT product_name, quantity, unit, gst_rate,
            price_inclusive_gst, description, expense_type, type, item_type
     FROM stock
     WHERE hsn_code = ? AND created_by = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [hsn_code, userId]
  );
  if (rows.length) return rows[0];

  // 3. Fallback to purchase_invoices
  const [purchaseRows] = await pool.query(
    `SELECT product_name, quantity, unit, price AS purchase_price, seller_name, invoice_date
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
    selling_price,
    quantity,
    purchase_bill_id,
    purchase_bill_item_id,
    purchase_item_id,
  } = req.body;

  // Requirement 3: Do not automatically create a new inventory product when recording a Purchase Bill.
  // When recording a purchase bill, frontend attempts auto-creation with category "Purchases".
  if (category && String(category).trim().toLowerCase() === "purchases") {
    return res.status(200).json({
      success: true,
      message: "Automatic product creation from purchase bill is disabled. Products must be added via Product Master.",
      stock: null,
    });
  }

  const targetItemId = purchase_bill_item_id || purchase_item_id;
  if (targetItemId) {
    const [itemRows] = await pool.query(
      `SELECT pbi.*, pb.id AS bill_id, pb.bill_number, pb.vendor_name
       FROM purchase_bill_items pbi
       JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
       WHERE pbi.id = ? AND pb.created_by = ?`,
      [Number(targetItemId), req.user.id]
    );
    if (itemRows.length) {
      const pbi = itemRows[0];
      if (!product_name) product_name = pbi.item_name;
      if (!hsn_code && pbi.hsn_code) hsn_code = pbi.hsn_code;
      if (!unit && pbi.unit) unit = pbi.unit;
      if ((gst_rate === undefined || gst_rate === "") && pbi.gst_rate !== null && pbi.gst_rate !== undefined) {
        gst_rate = pbi.gst_rate;
      }
      if (!item_type && !type && pbi.item_type) item_type = pbi.item_type;
      if (quantity === undefined || quantity === null || quantity === "") {
        quantity = pbi.quantity;
      }
      if (!purchase_bill_id) purchase_bill_id = pbi.purchase_bill_id;
    }
  }

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

  // stock.price remains Selling Price. Only require selling price where applicable.
  // Never overwrite selling price with purchase price.
  const resolvedSellingPrice =
    selling_price !== undefined && selling_price !== null && selling_price !== ""
      ? Number(selling_price)
      : price !== undefined && price !== null && price !== ""
      ? Number(price)
      : 0;

  const finalPrice = Number.isFinite(resolvedSellingPrice) && resolvedSellingPrice >= 0 ? resolvedSellingPrice : 0;

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

  let stockId;
  let isExistingUpgrade = false;

  if (product_name && String(product_name).trim()) {
    const trimmedName = String(product_name).trim();
    const [existingStock] = await pool.query(
      "SELECT * FROM stock WHERE (product_name = ? OR LOWER(product_name) = LOWER(?)) AND created_by = ? ORDER BY (category = 'Purchases') DESC, id ASC LIMIT 1",
      [trimmedName, trimmedName, req.user.id]
    );

    if (existingStock.length) {
      const existing = existingStock[0];
      if (existing.category === "Purchases" || !existing.price || existing.price === 0) {
        isExistingUpgrade = true;
        stockId = existing.id;
        const resolvedQty = (quantity !== undefined && quantity !== null && quantity !== "")
          ? Number(quantity)
          : Number(existing.quantity || 0) > 0 ? Number(existing.quantity) : finalQuantity;

        await pool.query(
          `UPDATE stock SET
            category = ?,
            type = ?,
            item_type = ?,
            hsn_code = COALESCE(?, hsn_code),
            unit = COALESCE(?, unit),
            gst_rate = ?,
            price_inclusive_gst = ?,
            description = COALESCE(?, description),
            expense_type = COALESCE(?, expense_type),
            price = ?,
            quantity = ?,
            purchase_bill_id = COALESCE(?, purchase_bill_id)
           WHERE id = ? AND created_by = ?`,
          [
            category || null,
            finalType,
            finalType,
            hsn_code || null,
            finalType === "service" ? null : unit || null,
            finalGst,
            price_inclusive_gst ? 1 : 0,
            description || null,
            expense_type || null,
            finalPrice,
            resolvedQty,
            finalPurchaseBillId,
            stockId,
            req.user.id,
          ]
        );
      }
    }
  }

  if (!isExistingUpgrade) {
    const [result] = await pool.query(
      `INSERT INTO stock
        (product_name, category, type, item_type, hsn_code, unit, gst_rate,
         price_inclusive_gst, description, expense_type, price, quantity, purchase_bill_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product_name || null,
        category || null,
        finalType,
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
    stockId = result.insertId;
  }

  if (targetItemId) {
    await pool.query(
      "UPDATE purchase_bill_items SET product_id = ? WHERE id = ?",
      [stockId, Number(targetItemId)]
    );
  }

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
        stockId,
        finalPurchaseBillId,
        req.user.id,
        stockId,
        product_name || "",
        product_name || "",
        hsn_code || null,
        hsn_code || null,
      ]
    );
  }

  if (product_name) {
    await pool.query(
      `UPDATE purchase_bill_items pbi
       JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
       SET pbi.product_id = ?
       WHERE pb.created_by = ? AND pbi.product_id IS NULL AND (pbi.item_name = ? OR LOWER(pbi.item_name) = LOWER(?))`,
      [stockId, req.user.id, product_name, product_name]
    );
  }

  const [rows] = await pool.query(
    "SELECT * FROM stock WHERE id = ? AND created_by = ?",
    [stockId, req.user.id]
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
    type,
    item_type,
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

  const requestedType = (type || item_type || "").trim().toLowerCase();
  if (requestedType && requestedType !== "all") {
    if (requestedType === "goods") {
      sql += " AND (s.item_type = 'goods' OR s.type = 'goods' OR (s.type IS NULL AND s.item_type IS NULL))";
    } else if (requestedType === "service") {
      sql += " AND (s.item_type = 'service' OR s.type = 'service')";
    } else {
      sql += " AND (s.item_type = ? OR s.type = ?)";
      params.push(requestedType, requestedType);
    }
  }

  const keyword = String(search || req.query.query || req.query.q || "").trim();
  if (keyword) {
    sql += `
      AND (
        s.product_name LIKE ?
        OR s.type LIKE ?
        OR s.item_type LIKE ?
        OR s.category LIKE ?
        OR s.hsn_code LIKE ?
      )
    `;

    params.push(
      `%${keyword}%`,
      `%${keyword}%`,
      `%${keyword}%`,
      `%${keyword}%`,
      `%${keyword}%`
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

  const finalType = item_type || type || null;

  await pool.query(
    `UPDATE stock SET
      product_name = COALESCE(?, product_name),
      category = COALESCE(?, category),
      type = COALESCE(?, type),
      item_type = COALESCE(?, item_type),
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
      finalType,
      finalType,
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

// GET /api/stock/lookup
const lookupStockOrPurchase = asyncHandler(async (req, res) => {
  const hsn_code = req.query.hsn_code || req.query.hsn;
  const search = req.query.search || req.query.q || req.query.product_name;

  if (!hsn_code && !search) {
    return res.json({ success: true, found: false });
  }

  // 1. Check purchase_bill_items
  let sql = `
    SELECT pbi.id AS purchase_bill_item_id,
           pbi.id,
           pbi.purchase_bill_id,
           pbi.item_name AS product_name,
           pbi.item_name,
           pbi.hsn_code,
           pbi.quantity,
           pbi.unit,
           pbi.price AS purchase_price,
           pbi.price,
           pbi.item_type,
           pbi.gst_rate,
           pb.vendor_name,
           pb.vendor_name AS seller_name,
           pb.bill_number,
           pb.bill_date
    FROM purchase_bill_items pbi
    JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
    WHERE pb.created_by = ?
  `;
  const params = [req.user.id];
  if (hsn_code) {
    sql += " AND pbi.hsn_code = ?";
    params.push(hsn_code);
  }
  if (search) {
    sql += " AND (pbi.item_name LIKE ? OR pbi.hsn_code LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += " ORDER BY pb.bill_date DESC, pbi.id DESC LIMIT 1";

  const [billRows] = await pool.query(sql, params);
  if (billRows.length) {
    return res.json({
      success: true,
      found: true,
      match: billRows[0],
      product: billRows[0],
      item: billRows[0],
      data: billRows[0],
    });
  }

  // 2. Check stock
  let stockSql = `SELECT * FROM stock WHERE created_by = ?`;
  const stockParams = [req.user.id];
  if (hsn_code) {
    stockSql += " AND hsn_code = ?";
    stockParams.push(hsn_code);
  }
  if (search) {
    stockSql += " AND (product_name LIKE ? OR hsn_code LIKE ?)";
    stockParams.push(`%${search}%`, `%${search}%`);
  }
  stockSql += " ORDER BY created_at DESC LIMIT 1";

  const [stockRows] = await pool.query(stockSql, stockParams);
  if (stockRows.length) {
    const enriched = enrichStockItem(stockRows[0]);
    return res.json({
      success: true,
      found: true,
      match: enriched,
      product: enriched,
      item: enriched,
      data: enriched,
    });
  }

  // 3. Check legacy purchase_invoices
  let legacySql = `SELECT product_name, hsn_code, quantity, price AS purchase_price, price, seller_name, invoice_date FROM purchase_invoices WHERE created_by = ?`;
  const legacyParams = [req.user.id];
  if (hsn_code) {
    legacySql += " AND hsn_code = ?";
    legacyParams.push(hsn_code);
  }
  if (search) {
    legacySql += " AND (product_name LIKE ? OR hsn_code LIKE ?)";
    legacyParams.push(`%${search}%`, `%${search}%`);
  }
  legacySql += " ORDER BY invoice_date DESC LIMIT 1";

  const [legacyRows] = await pool.query(legacySql, legacyParams);
  if (legacyRows.length) {
    return res.json({
      success: true,
      found: true,
      match: legacyRows[0],
      product: legacyRows[0],
      item: legacyRows[0],
      data: legacyRows[0],
    });
  }

  res.json({ success: true, found: false });
});

// GET /api/stock/purchase-items
const searchPurchaseItems = asyncHandler(async (req, res) => {
  const query = String(req.query.search || req.query.q || req.query.query || req.query.hsn_code || req.query.hsn || "").trim();
  const purchaseBillId = req.query.purchase_bill_id || req.query.purchaseBillId || req.query.bill_id;

  let sql = `
    SELECT pbi.id AS purchase_bill_item_id,
           pbi.id,
           pbi.purchase_bill_id,
           pb.bill_number,
           pb.vendor_name,
           pb.bill_date,
           pbi.product_id,
           pbi.item_name AS product_name,
           pbi.item_name,
           pbi.hsn_code,
           pbi.quantity,
           pbi.unit,
           pbi.price AS purchase_price,
           pbi.price,
           pbi.discount,
           pbi.item_type,
           pbi.gst_rate
    FROM purchase_bill_items pbi
    JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
    WHERE pb.created_by = ?
  `;
  const params = [req.user.id];

  if (purchaseBillId) {
    sql += " AND pb.id = ?";
    params.push(Number(purchaseBillId));
  }

  if (query) {
    sql += ` AND (
      pbi.item_name LIKE ?
      OR pbi.hsn_code LIKE ?
      OR pb.bill_number LIKE ?
      OR pb.vendor_name LIKE ?
    )`;
    const term = `%${query}%`;
    params.push(term, term, term, term);
  }

  sql += " ORDER BY pb.bill_date DESC, pbi.id DESC LIMIT 50";

  const [items] = await pool.query(sql, params);

  res.json({
    success: true,
    count: items.length,
    items,
    data: items,
    purchase_items: items,
  });
});

module.exports = {
  addStock,
  listStock,
  updateStock,
  deleteStock,
  lookupStockOrPurchase,
  searchPurchaseItems,
};
