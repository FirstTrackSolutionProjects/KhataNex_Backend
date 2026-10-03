const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const normalizeRate = (value) => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return 0;
  return rate;
};

// Check if an item is a real, non-empty item to eliminate automatic/empty/duplicate item creation
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

// Item-level GST is authoritative:
// taxable = qty * price - discount
// gst = taxable * gst_rate / 100
// total = taxable + gst
const normalizeItem = (item) => {
  const itemType =
    item.item_type === "service" || item.type === "service" ? "service" : "goods";

  const qty = Math.max(0, Number(item.quantity || 0));
  const price = Math.max(0, Number(item.price || 0));
  const discount = Math.max(0, Number(item.discount || 0));
  const gstRate = normalizeRate(item.gst_rate !== undefined && item.gst_rate !== "" ? item.gst_rate : 0);

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

const getBillWithItems = async (billId, userId) => {
  const [bills] = await pool.query(
    `SELECT *
     FROM purchase_bills
     WHERE id = ? AND created_by = ?`,
    [billId, userId]
  );

  if (!bills.length) {
    throw new ApiError(404, "Purchase bill not found.");
  }

  const [items] = await pool.query(
    `SELECT *
     FROM purchase_bill_items
     WHERE purchase_bill_id = ?
     ORDER BY id ASC`,
    [billId]
  );

  return enrichBillWithCalculations(bills[0], items);
};

// POST /api/purchase-bills
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

  // Eliminate automatic/empty/duplicate item creation: only explicitly supplied non-empty items are kept
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
        bill_number ? String(bill_number).trim() : null,
        vendor_name ? String(vendor_name).trim() : null,
        bill_date || null,
        req.user.id,
      ]
    );

    const purchaseBillId = billResult.insertId;

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
         (
           purchase_bill_id,
           product_id,
           item_name,
           quantity,
           price,
           discount,
           unit,
           item_type,
           gst_rate,
           hsn_code
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          purchaseBillId,
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
       * Goods purchase increases matching Product Master stock.quantity.
       * Services do not affect stock.
       * Never change Product Master selling price from purchase price.
       */
      if (item.item_type === "goods" && productId && item.quantity > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity + ?
           WHERE id = ? AND created_by = ?`,
          [item.quantity, productId, req.user.id]
        );
      }
    }

    await connection.commit();

    const purchaseBill = await getBillWithItems(purchaseBillId, req.user.id);

    res.status(201).json({
      success: true,
      purchase_bill: purchaseBill,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

// GET /api/purchase-bills
const listPurchaseBills = asyncHandler(async (req, res) => {
  const search = String(req.query.search || "").trim();

  let sql = `
    SELECT DISTINCT b.*
    FROM purchase_bills b
    LEFT JOIN purchase_bill_items i
      ON i.purchase_bill_id = b.id
    WHERE b.created_by = ?
  `;

  const params = [req.user.id];

  if (search) {
    sql += `
      AND (
        b.bill_number LIKE ?
        OR b.vendor_name LIKE ?
        OR i.item_name LIKE ?
        OR i.hsn_code LIKE ?
      )
    `;

    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  sql += `
    ORDER BY b.bill_date DESC, b.created_at DESC
  `;

  const [bills] = await pool.query(sql, params);

  if (!bills.length) {
    return res.json({
      success: true,
      count: 0,
      purchase_bills: [],
    });
  }

  const ids = bills.map((bill) => bill.id);
  const placeholders = ids.map(() => "?").join(",");

  const [items] = await pool.query(
    `SELECT *
     FROM purchase_bill_items
     WHERE purchase_bill_id IN (${placeholders})
     ORDER BY purchase_bill_id DESC, id ASC`,
    ids
  );

  const itemsByBill = {};
  for (const item of items) {
    if (!itemsByBill[item.purchase_bill_id]) {
      itemsByBill[item.purchase_bill_id] = [];
    }
    itemsByBill[item.purchase_bill_id].push(item);
  }

  const result = bills.map((bill) =>
    enrichBillWithCalculations(bill, itemsByBill[bill.id] || [])
  );

  res.json({
    success: true,
    count: result.length,
    purchase_bills: result,
  });
});

// GET /api/purchase-bills/:id
const getPurchaseBill = asyncHandler(async (req, res) => {
  const purchaseBill = await getBillWithItems(req.params.id, req.user.id);

  res.json({
    success: true,
    purchase_bill: purchaseBill,
  });
});

// PUT /api/purchase-bills/:id
const updatePurchaseBill = asyncHandler(async (req, res) => {
  const { id } = req.params;
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

  // Filter valid non-empty items
  const validItems = Array.isArray(parsedItems)
    ? parsedItems.filter(isValidItem).map((item) => normalizeItem(item))
    : [];

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      `SELECT id
       FROM purchase_bills
       WHERE id = ? AND created_by = ?
       FOR UPDATE`,
      [id, req.user.id]
    );

    if (!existing.length) {
      throw new ApiError(404, "Purchase bill not found.");
    }

    // 1. Fetch old items to reverse their stock quantities
    const [oldItems] = await connection.query(
      `SELECT product_id, item_name, quantity, item_type
       FROM purchase_bill_items
       WHERE purchase_bill_id = ?`,
      [id]
    );

    // 2. Reverse old purchase quantities (goods only) inside transaction
    for (const oldItem of oldItems) {
      const oldItemType = oldItem.item_type === "service" ? "service" : "goods";
      if (oldItemType === "goods") {
        let productId = oldItem.product_id;
        if (!productId && oldItem.item_name) {
          const [matching] = await connection.query(
            "SELECT id FROM stock WHERE product_name = ? AND created_by = ? LIMIT 1",
            [oldItem.item_name, req.user.id]
          );
          if (matching.length) {
            productId = matching[0].id;
          }
        }
        if (productId && Number(oldItem.quantity || 0) > 0) {
          await connection.query(
            `UPDATE stock
             SET quantity = quantity - ?
             WHERE id = ? AND created_by = ?`,
            [Number(oldItem.quantity || 0), productId, req.user.id]
          );
        }
      }
    }

    // Update bill details
    await connection.query(
      `UPDATE purchase_bills
       SET
         bill_number = ?,
         vendor_name = ?,
         bill_date = COALESCE(?, bill_date),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND created_by = ?`,
      [
        bill_number ? String(bill_number).trim() : null,
        vendor_name ? String(vendor_name).trim() : null,
        bill_date || null,
        id,
        req.user.id,
      ]
    );

    // Delete old items
    await connection.query(
      `DELETE FROM purchase_bill_items
       WHERE purchase_bill_id = ?`,
      [id]
    );

    // Insert new valid items and apply new stock quantities (goods only)
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
         (
           purchase_bill_id,
           product_id,
           item_name,
           quantity,
           price,
           discount,
           unit,
           item_type,
           gst_rate,
           hsn_code
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
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
       * Apply new purchase quantities:
       * Goods only affect stock.
       * Services do not affect stock.
       * Never change Product Master selling price from purchase price.
       */
      if (item.item_type === "goods" && productId && item.quantity > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity + ?
           WHERE id = ? AND created_by = ?`,
          [item.quantity, productId, req.user.id]
        );
      }
    }

    await connection.commit();

    const purchaseBill = await getBillWithItems(id, req.user.id);

    res.json({
      success: true,
      purchase_bill: purchaseBill,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

// DELETE /api/purchase-bills/:id
const deletePurchaseBill = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      `SELECT id
       FROM purchase_bills
       WHERE id = ? AND created_by = ?
       FOR UPDATE`,
      [id, req.user.id]
    );

    if (!existing.length) {
      throw new ApiError(404, "Purchase bill not found.");
    }

    // 1. Fetch items before deleting to reverse their stock quantities
    const [existingItems] = await connection.query(
      `SELECT product_id, item_name, quantity, item_type
       FROM purchase_bill_items
       WHERE purchase_bill_id = ?`,
      [id]
    );

    // 2. Subtract goods quantities from Product Master stock (services do nothing)
    for (const item of existingItems) {
      const itemType = item.item_type === "service" ? "service" : "goods";
      if (itemType === "goods") {
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
        if (productId && Number(item.quantity || 0) > 0) {
          await connection.query(
            `UPDATE stock
             SET quantity = quantity - ?
             WHERE id = ? AND created_by = ?`,
            [Number(item.quantity || 0), productId, req.user.id]
          );
        }
      }
    }

    // 3. Delete purchase bill items and purchase bill (do NOT delete Product Master product itself)
    await connection.query(
      `DELETE FROM purchase_bill_items
       WHERE purchase_bill_id = ?`,
      [id]
    );

    await connection.query(
      `DELETE FROM purchase_bills
       WHERE id = ? AND created_by = ?`,
      [id, req.user.id]
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Purchase bill deleted successfully.",
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

module.exports = {
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
  updatePurchaseBill,
  deletePurchaseBill,
};
