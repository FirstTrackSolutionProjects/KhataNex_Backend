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

    if (bill_number && String(bill_number).trim()) {
      const [existingBill] = await connection.query(
        "SELECT id FROM purchase_bills WHERE bill_number = ? AND created_by = ? LIMIT 1",
        [String(bill_number).trim(), req.user.id]
      );
      if (existingBill.length) {
        throw new ApiError(400, `Purchase bill '${bill_number}' already exists.`);
      }
    }

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

    let billTotal = 0;
    const stockUpdates = new Map(); // productId -> aggregated quantity to increment

    for (const item of validItems) {
      billTotal += Number(item.total_amount || 0);
      let productId = item.product_id ? Number(item.product_id) : null;
      if (!productId && item.item_name) {
        const [matching] = await connection.query(
          "SELECT id FROM stock WHERE (product_name = ? OR LOWER(product_name) = LOWER(?)) AND created_by = ? ORDER BY (category = 'Purchases') ASC, id DESC LIMIT 1",
          [item.item_name, item.item_name, req.user.id]
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

      // Existing linked product in stock: aggregate quantity so stock is updated exactly once
      if (item.item_type === "goods" && productId && Number(item.quantity || 0) > 0) {
        stockUpdates.set(productId, (stockUpdates.get(productId) || 0) + Number(item.quantity));
      }
    }

    // Apply stock updates: exactly ONE update per linked product
    for (const [prodId, totalQty] of stockUpdates.entries()) {
      if (prodId && totalQty > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity + ?
           WHERE id = ? AND created_by = ?`,
          [totalQty, prodId, req.user.id]
        );
      }
    }

    // Fall back to supplied body amount if no item lines were entered
    if (validItems.length === 0) {
      const suppliedAmount = Number(req.body.total_amount || req.body.amount || req.body.total || 0);
      if (suppliedAmount > 0) {
        billTotal = suppliedAmount;
      }
    }
    billTotal = Math.round(billTotal * 100) / 100;

    // Auto-create linked payment: exactly one payment per purchase bill
    const paymentMode = (req.body.payment_mode && String(req.body.payment_mode).trim().toLowerCase() === "cash") ? "cash" : "online";
    const partyName = (req.body.party_name || vendor_name) ? String(req.body.party_name || vendor_name).trim() : "Vendor";
    const paymentDate = bill_date || req.body.payment_date || null;
    const purpose = req.body.purpose || req.body.description || req.body.notes || (bill_number ? `Purchase Bill #${bill_number}` : "Purchase Bill");

    const [existingPayments] = await connection.query(
      `SELECT id FROM payments
       WHERE (purchase_bill_id = ?
              OR (purpose = ? AND ? != '')
              OR (purpose = ? AND ? != ''))
         AND created_by = ?
       ORDER BY id ASC`,
      [
        purchaseBillId,
        bill_number ? `Purchase Bill #${bill_number}` : "",
        bill_number || "",
        bill_number ? `Purchase Bill ${bill_number}` : "",
        bill_number || "",
        req.user.id
      ]
    );

    let paymentId;
    if (existingPayments.length > 0) {
      paymentId = existingPayments[0].id;
      await connection.query(
        `UPDATE payments
         SET payment_category = 'paid_by_business', party_name = ?, purpose = ?,
             amount = ?, payment_mode = ?, payment_date = COALESCE(?, CURRENT_DATE),
             purchase_bill_id = ?
         WHERE id = ? AND created_by = ?`,
        [partyName, purpose, billTotal, paymentMode, paymentDate, purchaseBillId, paymentId, req.user.id]
      );
      if (existingPayments.length > 1) {
        const extraIds = existingPayments.slice(1).map((p) => p.id);
        await connection.query(
          "UPDATE payments SET purchase_bill_id = ?, payment_category = 'paid_by_business' WHERE id IN (?) AND created_by = ?",
          [purchaseBillId, extraIds, req.user.id]
        );
      }
    } else {
      const [payRes] = await connection.query(
        `INSERT INTO payments
          (payment_category, party_name, purpose, amount, payment_mode, payment_date, purchase_bill_id, add_to_khata, created_by)
         VALUES ('paid_by_business', ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?, 0, ?)`,
        [partyName, purpose, billTotal, paymentMode, paymentDate, purchaseBillId, req.user.id]
      );
      paymentId = payRes.insertId;
    }

    await connection.query(
      "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ?",
      [paymentId, purchaseBillId]
    );

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

    // 2. Reverse old purchase quantities (goods only) inside transaction - aggregated per product
    const oldStockUpdates = new Map();
    for (const oldItem of oldItems) {
      const oldItemType = oldItem.item_type === "service" ? "service" : "goods";
      if (oldItemType === "goods") {
        let productId = oldItem.product_id ? Number(oldItem.product_id) : null;
        if (!productId && oldItem.item_name) {
          const [matching] = await connection.query(
            "SELECT id FROM stock WHERE (product_name = ? OR LOWER(product_name) = LOWER(?)) AND created_by = ? ORDER BY (category = 'Purchases') ASC, id DESC LIMIT 1",
            [oldItem.item_name, oldItem.item_name, req.user.id]
          );
          if (matching.length) {
            productId = matching[0].id;
          }
        }
        if (productId && Number(oldItem.quantity || 0) > 0) {
          oldStockUpdates.set(productId, (oldStockUpdates.get(productId) || 0) + Number(oldItem.quantity));
        }
      }
    }

    for (const [prodId, totalQty] of oldStockUpdates.entries()) {
      if (prodId && totalQty > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity - ?
           WHERE id = ? AND created_by = ?`,
          [totalQty, prodId, req.user.id]
        );
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

    let updatedBillTotal = 0;
    const newStockUpdates = new Map();

    // Insert new valid items and apply new stock quantities (goods only)
    for (const item of validItems) {
      updatedBillTotal += Number(item.total_amount || 0);
      let productId = item.product_id ? Number(item.product_id) : null;
      if (!productId && item.item_name) {
        const [matching] = await connection.query(
          "SELECT id FROM stock WHERE (product_name = ? OR LOWER(product_name) = LOWER(?)) AND created_by = ? ORDER BY (category = 'Purchases') ASC, id DESC LIMIT 1",
          [item.item_name, item.item_name, req.user.id]
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

      if (item.item_type === "goods" && productId && Number(item.quantity || 0) > 0) {
        newStockUpdates.set(productId, (newStockUpdates.get(productId) || 0) + Number(item.quantity));
      }
    }

    // Existing linked product updates stock exactly once
    for (const [prodId, totalQty] of newStockUpdates.entries()) {
      if (prodId && totalQty > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity + ?
           WHERE id = ? AND created_by = ?`,
          [totalQty, prodId, req.user.id]
        );
      }
    }

    if (validItems.length === 0) {
      const suppliedAmount = Number(req.body.total_amount || req.body.amount || req.body.total || 0);
      if (suppliedAmount > 0) {
        updatedBillTotal = suppliedAmount;
      }
    }
    updatedBillTotal = Math.round(updatedBillTotal * 100) / 100;

    // Sync linked payment details - guarantee single payment per purchase bill
    const paymentMode = req.body.payment_mode ? ((String(req.body.payment_mode).trim().toLowerCase() === "cash") ? "cash" : "online") : undefined;
    const partyName = (req.body.party_name || vendor_name) ? String(req.body.party_name || vendor_name).trim() : null;
    const purpose = req.body.purpose || req.body.description || req.body.notes || (bill_number ? `Purchase Bill #${bill_number}` : undefined);

    const [existingPayments] = await connection.query(
      `SELECT id FROM payments
       WHERE (purchase_bill_id = ?
              OR (purpose = ? AND ? != '')
              OR (purpose = ? AND ? != ''))
         AND created_by = ?
       ORDER BY id ASC`,
      [
        id,
        bill_number ? `Purchase Bill #${bill_number}` : "",
        bill_number || "",
        bill_number ? `Purchase Bill ${bill_number}` : "",
        bill_number || "",
        req.user.id
      ]
    );
    if (existingPayments.length > 0) {
      const primaryPaymentId = existingPayments[0].id;
      await connection.query(
        `UPDATE payments
         SET amount = ?,
             party_name = COALESCE(?, party_name),
             payment_mode = COALESCE(?, payment_mode),
             purpose = COALESCE(?, purpose),
             payment_date = COALESCE(?, payment_date)
         WHERE id = ? AND created_by = ?`,
        [
          updatedBillTotal,
          partyName,
          paymentMode || null,
          purpose || null,
          bill_date || null,
          primaryPaymentId,
          req.user.id,
        ]
      );
      if (existingPayments.length > 1) {
        const extraIds = existingPayments.slice(1).map((p) => p.id);
        await connection.query(
          "UPDATE payments SET purchase_bill_id = ?, payment_category = 'paid_by_business' WHERE id IN (?) AND created_by = ?",
          [id, extraIds, req.user.id]
        );
      }
      await connection.query(
        "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [primaryPaymentId, id, req.user.id]
      );
    } else {
      const [payRes] = await connection.query(
        `INSERT INTO payments
          (payment_category, party_name, purpose, amount, payment_mode, payment_date, purchase_bill_id, add_to_khata, created_by)
         VALUES ('paid_by_business', ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?, 0, ?)`,
        [
          partyName || "Vendor",
          purpose || "Purchase Bill",
          updatedBillTotal,
          paymentMode || "online",
          bill_date || null,
          id,
          req.user.id,
        ]
      );
      await connection.query(
        "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [payRes.insertId, id, req.user.id]
      );
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

    // 2. Subtract goods quantities from Product Master stock (services do nothing) - aggregated per product
    const stockReversals = new Map();
    for (const item of existingItems) {
      const itemType = item.item_type === "service" ? "service" : "goods";
      if (itemType === "goods") {
        let productId = item.product_id ? Number(item.product_id) : null;
        if (!productId && item.item_name) {
          const [matching] = await connection.query(
            "SELECT id FROM stock WHERE (product_name = ? OR LOWER(product_name) = LOWER(?)) AND created_by = ? ORDER BY (category = 'Purchases') ASC, id DESC LIMIT 1",
            [item.item_name, item.item_name, req.user.id]
          );
          if (matching.length) {
            productId = matching[0].id;
          }
        }
        if (productId && Number(item.quantity || 0) > 0) {
          stockReversals.set(productId, (stockReversals.get(productId) || 0) + Number(item.quantity));
        }
      }
    }

    for (const [prodId, totalQty] of stockReversals.entries()) {
      if (prodId && totalQty > 0) {
        await connection.query(
          `UPDATE stock
           SET quantity = quantity - ?
           WHERE id = ? AND created_by = ?`,
          [totalQty, prodId, req.user.id]
        );
      }
    }

    // 3. Delete purchase bill items and purchase bill (do NOT delete Product Master product itself)
    await connection.query(
      `DELETE FROM purchase_bill_items
       WHERE purchase_bill_id = ?`,
      [id]
    );

    // Clean up linked payment
    await connection.query(
      `DELETE FROM payments
       WHERE (purchase_bill_id = ? OR id = ?) AND created_by = ?`,
      [id, existing[0].payment_id || 0, req.user.id]
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

// GET /api/purchase-bills/items
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
  addPurchaseBill,
  listPurchaseBills,
  getPurchaseBill,
  updatePurchaseBill,
  deletePurchaseBill,
  searchPurchaseItems,
};
