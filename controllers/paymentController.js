const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const VALID_PURPOSES = [
  "Due Received",
  "Investor Advance",
  "Amount Received",
  "Paid Out",
  "Purchase Bill",
  "Advance",
  "Product Sale",
  "New Payment",
];

const resolveCategory = (purpose, payment_category) => {
  if (payment_category) {
    const cat = String(payment_category).trim().toLowerCase();
    if (
      cat === "amount_received" ||
      cat === "amountreceived" ||
      cat === "normal_received" ||
      cat === "normalreceived" ||
      cat === "received"
    ) {
      return "amount_received";
    }
    if (cat === "due_received" || cat === "duereceived" || cat === "due") return "due_received";
    if (cat === "paid_by_business" || cat === "paidout" || cat === "paid_out") return "paid_by_business";
    if (cat === "purchase_bill" || cat === "purchasebill") return "paid_by_business";
    if (cat === "advance_from_investor" || cat === "advance" || cat === "investor_advance") return "advance_from_investor";
    if (cat === "product_sale" || cat === "productsale") return "product_sale";
  }

  if (purpose) {
    const p = String(purpose).trim().toLowerCase();
    if (p.includes("purchase")) return "paid_by_business";
    if (p.includes("amount received") || p === "received" || p.includes("normal received")) return "amount_received";
    if (p.includes("due")) return "due_received";
    if (p.includes("advance") || p.includes("investor")) return "advance_from_investor";
    if (p.includes("product") || p.includes("sale")) return "product_sale";
    if (p.includes("paid out") || p.includes("paid_by_business")) return "paid_by_business";
    if (p.includes("received")) return "amount_received";
  }

  // Default is Normal Received (amount_received) so that normal payments are never misclassified as due_received
  return "amount_received";
};

const resolvePurpose = (purpose, payment_category) => {
  if (purpose && typeof purpose === "string" && purpose.trim()) {
    const p = purpose.trim();
    const match = VALID_PURPOSES.find(
      (vp) => vp.toLowerCase() === p.toLowerCase()
    );
    if (match) return match;
    return p;
  }

  const category = resolveCategory(null, payment_category);
  switch (category) {
    case "due_received":
      return "Due Received";
    case "advance_from_investor":
      return "Investor Advance";
    case "amount_received":
      return "Amount Received";
    case "product_sale":
      return "Product Sale";
    case "paid_by_business":
      return "Paid Out";
    default:
      return "Amount Received";
  }
};

const normalizePaymentMode = (mode) => {
  if (!mode) return "cash";
  const m = String(mode).trim().toLowerCase();
  if (m === "cash") return "cash";
  return "online";
};

// POST /api/payments
const addPayment = asyncHandler(async (req, res) => {
  const {
    payment_category,
    party_name,
    customer_id,
    purpose,
    amount,
    payment_mode,
    payment_date,
    product_id,
    quantity,
    allocations,
    dues,
    due_id,
    add_to_khata,
    purchase_bill_id,
    money_receipt_id,
  } = req.body;

  let resolvedPurpose = resolvePurpose(purpose, payment_category);
  let resolvedCategory = resolveCategory(resolvedPurpose, payment_category);

  // If allocations or due_id are explicitly supplied, category is definitely due_received
  if ((Array.isArray(allocations) && allocations.length > 0) || (Array.isArray(dues) && dues.length > 0) || due_id) {
    resolvedCategory = "due_received";
    resolvedPurpose = "Due Received";
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let linkedCustomerId = null;
    let customerObj = null;

    if (customer_id) {
      const [custRows] = await conn.query(
        "SELECT id, name, phone, email, total_due FROM customers WHERE id = ? AND created_by = ?",
        [customer_id, req.user.id]
      );
      if (custRows.length) {
        linkedCustomerId = customer_id;
        customerObj = custRows[0];
      }
    }

    let finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
    let linkedProductId = null;
    let linkedProductName = null;
    let linkedQuantity = null;
    let linkedUnitPrice = null;
    let linkedPurchaseBillId = null;
    let linkedMoneyReceiptId = null;
    let resolvedPartyName = party_name || (customerObj?.name ?? null);
    const recordedAllocations = [];

    // Target purchase bill resolution supporting all common frontend field variations:
    // purchase_bill_id, bill_id, id, billId, purchaseBillId, req.params.id
    const targetBillId =
      purchase_bill_id ||
      req.body.purchase_bill_id ||
      req.body.purchaseBillId ||
      req.body.bill_id ||
      req.body.billId ||
      req.body.id ||
      req.params?.id ||
      req.params?.purchase_bill_id ||
      req.params?.bill_id;

    // 0a. PURCHASE BILL PAYMENT: Look up purchase bill & calculate total from purchase_bill_items
    if (targetBillId || resolvedPurpose === "Purchase Bill" || payment_category === "purchase_bill") {
      if (!targetBillId) {
        throw new ApiError(400, "purchase_bill_id is required for Purchase Bill payment.");
      }

      const [pbRows] = await conn.query(
        "SELECT * FROM purchase_bills WHERE id = ? AND created_by = ? FOR UPDATE",
        [targetBillId, req.user.id]
      );

      if (!pbRows.length) {
        throw new ApiError(404, "Purchase bill not found.");
      }

      const pb = pbRows[0];
      if (pb.is_paid === 1 || pb.payment_id) {
        throw new ApiError(400, "This purchase bill has already been marked as paid.");
      }

      // Calculate bill total using item-level GST (item-level is authoritative, no bill-level double GST)
      const [pbItems] = await conn.query(
        "SELECT quantity, price, discount, gst_rate FROM purchase_bill_items WHERE purchase_bill_id = ?",
        [pb.id]
      );

      let billTotal = 0;
      for (const it of pbItems) {
        const itemNet = Math.max(0, (Number(it.quantity || 0) * Number(it.price || 0)) - Number(it.discount || 0));
        const itemGst = (itemNet * Number(it.gst_rate || 0)) / 100;
        billTotal += itemNet + itemGst;
      }
      billTotal = Math.round(billTotal * 100) / 100;

      finalAmount = Number(amount) > 0 ? Number(amount) : billTotal;
      linkedPurchaseBillId = pb.id;
      resolvedCategory = "paid_by_business";
      resolvedPurpose = "Purchase Bill";
      if (!resolvedPartyName && pb.vendor_name) {
        resolvedPartyName = pb.vendor_name;
      }
    }

    // 0b. MONEY RECEIPT PAYMENT: Link from money receipt
    else if (money_receipt_id) {
      const [mrRows] = await conn.query(
        "SELECT * FROM money_receipts WHERE id = ? AND created_by = ? FOR UPDATE",
        [money_receipt_id, req.user.id]
      );

      if (!mrRows.length) {
        throw new ApiError(404, "Money receipt not found.");
      }

      const mr = mrRows[0];
      if (mr.is_linked_to_payment === 1 || mr.payment_id) {
        throw new ApiError(400, "This money receipt is already linked to a payment.");
      }

      if (mr.against_type === "advance") {
        resolvedCategory = "advance_from_investor";
        resolvedPurpose = "Investor Advance";
      } else {
        resolvedCategory = "amount_received";
        resolvedPurpose = "Amount Received";
      }

      finalAmount = Number(mr.amount_received || 0);
      linkedMoneyReceiptId = mr.id;
      if (!linkedCustomerId && mr.customer_id) {
        linkedCustomerId = mr.customer_id;
      }
      if (!resolvedPartyName && mr.received_from_name) {
        resolvedPartyName = mr.received_from_name;
      }
    }

    // 1. PRODUCT SALE: Look up from Product Master (stock) at selling price (stock.price)
    if (!linkedPurchaseBillId && !linkedMoneyReceiptId && (resolvedPurpose === "Product Sale" || resolvedCategory === "product_sale")) {
      if (!product_id) {
        throw new ApiError(400, "product_id is required for Product Sale.");
      }

      const [stockRows] = await conn.query(
        "SELECT id, product_name, price FROM stock WHERE id = ? AND created_by = ?",
        [product_id, req.user.id]
      );

      if (!stockRows.length) {
        throw new ApiError(404, "Selected product not found in inventory.");
      }

      const stockItem = stockRows[0];
      const qty = Number(quantity) > 0 ? Number(quantity) : 1;
      const unitPrice = Number(stockItem.price || 0);

      linkedProductId = stockItem.id;
      linkedProductName = stockItem.product_name;
      linkedQuantity = qty;
      linkedUnitPrice = unitPrice;

      // Selling price determines payment amount
      finalAmount = unitPrice * qty;
    }

    // 2. DUE RECEIVED: Only executes when explicitly Due Received (never for normal Amount Received)
    else if (!linkedPurchaseBillId && !linkedMoneyReceiptId && (resolvedPurpose === "Due Received" || resolvedCategory === "due_received")) {
      const rawAllocations = Array.isArray(allocations)
        ? allocations
        : Array.isArray(dues)
        ? dues
        : due_id
        ? [{ due_id, amount: finalAmount }]
        : [];

      if (rawAllocations.length > 0) {
        let allocatedTotal = 0;

        for (const alloc of rawAllocations) {
          const targetDueId = alloc.due_id || alloc.id;
          const allocAmount = Number(alloc.amount);

          if (!targetDueId || !Number.isFinite(allocAmount) || allocAmount <= 0) {
            throw new ApiError(400, "Each due allocation must have a valid due_id and positive amount.");
          }

          let dueQuery = "SELECT * FROM customer_dues WHERE id = ? AND created_by = ?";
          const dueParams = [targetDueId, req.user.id];
          if (linkedCustomerId) {
            dueQuery += " AND customer_id = ?";
            dueParams.push(linkedCustomerId);
          }

          const [dueRows] = await conn.query(dueQuery, dueParams);
          if (!dueRows.length) {
            throw new ApiError(404, `Due record #${targetDueId} not found or does not belong to this customer.`);
          }

          const dueRecord = dueRows[0];
          const remaining = Number(dueRecord.remaining_amount);

          if (allocAmount > remaining + 0.001) {
            throw new ApiError(
              400,
              `Allocation amount ₹${allocAmount} exceeds remaining due ₹${remaining} for "${dueRecord.description}".`
            );
          }

          const newRemaining = Math.max(0, remaining - allocAmount);
          const newStatus = newRemaining <= 0 ? "settled" : "partially_paid";

          await conn.query(
            "UPDATE customer_dues SET remaining_amount = ?, status = ? WHERE id = ?",
            [newRemaining, newStatus, targetDueId]
          );

          if (!linkedCustomerId && dueRecord.customer_id) {
            linkedCustomerId = dueRecord.customer_id;
          }

          allocatedTotal += allocAmount;
          recordedAllocations.push({
            due_id: targetDueId,
            description: dueRecord.description,
            allocated_amount: allocAmount,
            remaining_amount: newRemaining,
            status: newStatus,
          });
        }

        finalAmount = allocatedTotal;

        if (linkedCustomerId) {
          await conn.query(
            "UPDATE customers SET total_due = GREATEST(0, total_due - ?) WHERE id = ? AND created_by = ?",
            [finalAmount, linkedCustomerId, req.user.id]
          );
        }
      } else if (linkedCustomerId && finalAmount > 0) {
        // Fallback: auto-allocate in FIFO order across customer's pending dues
        const [pendingDues] = await conn.query(
          "SELECT * FROM customer_dues WHERE customer_id = ? AND created_by = ? AND status != 'settled' ORDER BY created_at ASC, id ASC",
          [linkedCustomerId, req.user.id]
        );

        let remainingToAllocate = finalAmount;
        for (const d of pendingDues) {
          if (remainingToAllocate <= 0) break;
          const dueRemain = Number(d.remaining_amount);
          const applyAmount = Math.min(remainingToAllocate, dueRemain);
          const newRemain = dueRemain - applyAmount;
          const newStatus = newRemain <= 0 ? "settled" : "partially_paid";

          await conn.query(
            "UPDATE customer_dues SET remaining_amount = ?, status = ? WHERE id = ?",
            [newRemain, newStatus, d.id]
          );

          recordedAllocations.push({
            due_id: d.id,
            description: d.description,
            allocated_amount: applyAmount,
            remaining_amount: newRemain,
            status: newStatus,
          });

          remainingToAllocate -= applyAmount;
        }

        await conn.query(
          "UPDATE customers SET total_due = GREATEST(0, total_due - ?) WHERE id = ? AND created_by = ?",
          [finalAmount, linkedCustomerId, req.user.id]
        );
      }
    }
    // Note: When resolvedCategory === 'amount_received' (Normal Received),
    // we NEVER allocate against dues or decrement customer dues. It is an independent receipt.

    // 3. PAID OUT / PAID BY BUSINESS add_to_khata flag
    const shouldAddToKhata =
      (resolvedCategory === "paid_by_business" && !linkedPurchaseBillId)
        ? Boolean(add_to_khata === true || add_to_khata === "true" || add_to_khata === 1)
        : 0;

    const [result] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, product_id, product_name, quantity, unit_price,
         purchase_bill_id, money_receipt_id, add_to_khata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolvedCategory,
        resolvedPartyName,
        linkedCustomerId,
        resolvedPurpose,
        finalAmount,
        normalizePaymentMode(payment_mode),
        payment_date || null,
        linkedProductId,
        linkedProductName,
        linkedQuantity,
        linkedUnitPrice,
        linkedPurchaseBillId,
        linkedMoneyReceiptId,
        shouldAddToKhata ? 1 : 0,
        req.user.id,
      ]
    );

    const paymentId = result.insertId;

    if (linkedPurchaseBillId) {
      await conn.query(
        "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [paymentId, linkedPurchaseBillId, req.user.id]
      );
    }

    if (linkedMoneyReceiptId) {
      await conn.query(
        "UPDATE money_receipts SET is_linked_to_payment = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [paymentId, linkedMoneyReceiptId, req.user.id]
      );
    }

    // Record allocations in junction table if any
    for (const alloc of recordedAllocations) {
      await conn.query(
        "INSERT INTO customer_due_allocations (payment_id, due_id, amount) VALUES (?, ?, ?)",
        [paymentId, alloc.due_id, alloc.allocated_amount]
      );
    }

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT p.*,
              cu.name AS customer_name,
              cu.phone AS customer_phone,
              cu.total_due AS customer_total_due
       FROM payments p
       LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.id = ? AND p.created_by = ?`,
      [paymentId, req.user.id]
    );

    res.status(201).json({
      success: true,
      payment: rows[0],
      allocations: recordedAllocations,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/payments
const listPayments = asyncHandler(async (req, res) => {
  const { category, purpose, customer_id, from, to } = req.query;

  let sql = `
    SELECT p.*,
           u.name AS added_by,
           cu.name AS customer_name,
           cu.phone AS customer_phone
    FROM payments p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN customers cu ON cu.id = p.customer_id
    WHERE 1=1
  `;
  const params = [];

  sql += " AND p.created_by = ?";
  params.push(req.user.id);

  if (category) {
    sql += " AND p.payment_category = ?";
    params.push(category);
  }

  if (purpose) {
    sql += " AND p.purpose = ?";
    params.push(purpose);
  }

  if (customer_id) {
    sql += " AND p.customer_id = ?";
    params.push(customer_id);
  }

  if (from) {
    sql += " AND p.payment_date >= ?";
    params.push(from);
  }

  if (to) {
    sql += " AND p.payment_date <= ?";
    params.push(to);
  }

  sql += " ORDER BY p.payment_date DESC, p.created_at DESC";

  const [rows] = await pool.query(sql, params);

  res.json({
    success: true,
    count: rows.length,
    payments: rows,
  });
});

// GET /api/payments/dues?customer_id=...
// Returns outstanding dues for a customer
const getCustomerOutstandingDues = asyncHandler(async (req, res) => {
  const customerId = req.query.customer_id;

  if (!customerId) {
    throw new ApiError(400, "customer_id is required to fetch outstanding dues.");
  }

  const [rows] = await pool.query(
    `SELECT * FROM customer_dues
     WHERE customer_id = ? AND created_by = ? AND status != 'settled'
     ORDER BY created_at ASC, id ASC`,
    [customerId, req.user.id]
  );

  res.json({
    success: true,
    count: rows.length,
    dues: rows,
  });
});

// POST /api/payments/:id/add-to-khata
// Links an existing Paid Out payment to Khata without creating duplicate rows
const addPaymentToKhata = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT * FROM payments WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  if (!rows.length) {
    throw new ApiError(404, "Payment not found.");
  }

  const payment = rows[0];

  if (payment.add_to_khata === 1) {
    return res.json({
      success: true,
      message: "Payment is already linked to Khata.",
      payment,
    });
  }

  await pool.query(
    "UPDATE payments SET add_to_khata = 1 WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  const [updated] = await pool.query(
    "SELECT * FROM payments WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );

  res.json({
    success: true,
    message: "Payment linked to Khata successfully.",
    payment: updated[0],
  });
});

// GET /api/payments/unlinked-money-receipts
const getUnlinkedMoneyReceipts = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT mr.*, cu.name AS customer_name
     FROM money_receipts mr
     LEFT JOIN customers cu ON cu.id = mr.customer_id
     WHERE (mr.is_linked_to_payment = 0 OR mr.is_linked_to_payment IS NULL)
       AND (mr.payment_id IS NULL)
       AND mr.created_by = ?
     ORDER BY mr.receipt_date DESC, mr.id DESC`,
    [req.user.id]
  );

  res.json({
    success: true,
    count: rows.length,
    money_receipts: rows,
  });
});

// POST /api/payments/link-money-receipt/:id
const linkMoneyReceiptToPayment = asyncHandler(async (req, res) => {
  const id = req.params.id || req.body.money_receipt_id;
  const { payment_mode } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT mr.*, cu.name AS customer_name
       FROM money_receipts mr
       LEFT JOIN customers cu ON cu.id = mr.customer_id
       WHERE mr.id = ? AND mr.created_by = ? FOR UPDATE`,
      [id, req.user.id]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Money receipt not found.");
    }

    const mr = rows[0];

    if (mr.is_linked_to_payment === 1 || mr.payment_id) {
      await conn.rollback();
      throw new ApiError(400, "Money receipt is already linked to a payment.");
    }

    const category = mr.against_type === "advance" ? "advance_from_investor" : "amount_received";
    const purpose = mr.against_type === "advance" ? "Investor Advance" : "Amount Received";

    const [result] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, money_receipt_id, add_to_khata, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        category,
        mr.received_from_name || mr.customer_name || "Customer",
        mr.customer_id || null,
        purpose,
        Number(mr.amount_received || 0),
        normalizePaymentMode(payment_mode || mr.payment_mode),
        mr.receipt_date,
        mr.id,
        req.user.id,
      ]
    );

    const paymentId = result.insertId;

    await conn.query(
      "UPDATE money_receipts SET is_linked_to_payment = 1, payment_id = ? WHERE id = ? AND created_by = ?",
      [paymentId, mr.id, req.user.id]
    );

    await conn.commit();

    const [paymentRows] = await pool.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ?",
      [paymentId, req.user.id]
    );

    res.status(201).json({
      success: true,
      message: "Money receipt linked to payment successfully.",
      payment: paymentRows[0],
      money_receipt: mr,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/payments/unlinked-purchase-bills
const getUnlinkedPurchaseBills = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pb.*,
            COUNT(pbi.id) AS item_count,
            COALESCE(SUM((pbi.quantity * pbi.price - pbi.discount) * (1 + pbi.gst_rate / 100)), 0) AS total_amount
     FROM purchase_bills pb
     LEFT JOIN purchase_bill_items pbi ON pbi.purchase_bill_id = pb.id
     WHERE (pb.is_paid = 0 OR pb.is_paid IS NULL)
       AND (pb.payment_id IS NULL)
       AND pb.created_by = ?
     GROUP BY pb.id
     ORDER BY pb.bill_date DESC, pb.id DESC`,
    [req.user.id]
  );

  res.json({
    success: true,
    count: rows.length,
    purchase_bills: rows,
  });
});

// POST /api/payments/link-purchase-bill/:id
const linkPurchaseBillToPayment = asyncHandler(async (req, res) => {
  const id =
    req.params?.id ||
    req.body?.purchase_bill_id ||
    req.body?.purchaseBillId ||
    req.body?.bill_id ||
    req.body?.billId ||
    req.body?.id;

  if (!id) {
    throw new ApiError(400, "purchase_bill_id is required for Purchase Bill payment.");
  }

  const { payment_mode } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM purchase_bills WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, req.user.id]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Purchase bill not found.");
    }

    const pb = rows[0];

    if (pb.is_paid === 1 || pb.payment_id) {
      await conn.rollback();
      throw new ApiError(400, "Purchase bill is already marked as paid.");
    }

    const [items] = await conn.query(
      "SELECT * FROM purchase_bill_items WHERE purchase_bill_id = ?",
      [pb.id]
    );

    // Item-level GST is authoritative
    let billTotal = 0;
    for (const item of items) {
      const itemNet = Math.max(0, (Number(item.quantity || 0) * Number(item.price || 0)) - Number(item.discount || 0));
      const itemGst = (itemNet * Number(item.gst_rate || 0)) / 100;
      billTotal += itemNet + itemGst;
    }
    billTotal = Math.round(billTotal * 100) / 100;

    const [result] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, purpose, amount,
         payment_mode, payment_date, purchase_bill_id, add_to_khata, created_by)
       VALUES ('paid_by_business', ?, 'Purchase Bill', ?, ?, ?, ?, 0, ?)`,
      [
        pb.vendor_name || "Vendor",
        billTotal,
        normalizePaymentMode(payment_mode),
        pb.bill_date,
        pb.id,
        req.user.id,
      ]
    );

    const paymentId = result.insertId;

    await conn.query(
      "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
      [paymentId, pb.id, req.user.id]
    );

    await conn.commit();

    const [paymentRows] = await pool.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ?",
      [paymentId, req.user.id]
    );

    res.status(201).json({
      success: true,
      message: "Purchase bill successfully paid and linked to payment.",
      payment: paymentRows[0],
      purchase_bill_id: pb.id,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/payments/unlinked-khata-debits
const getUnlinkedKhataDebitsForPayment = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ke.*, cu.name AS customer_name, s.product_name
     FROM khata_entries ke
     LEFT JOIN customers cu ON cu.id = ke.customer_id
     LEFT JOIN stock s ON s.id = ke.product_id
     WHERE ke.type = 'debit'
       AND (ke.is_linked_to_payment = 0 OR ke.is_linked_to_payment IS NULL)
       AND (ke.is_skipped = 0 OR ke.is_skipped IS NULL)
       AND ke.created_by = ?
     ORDER BY ke.entry_date DESC, ke.id DESC`,
    [req.user.id]
  );

  res.json({
    success: true,
    count: rows.length,
    debits: rows,
  });
});

module.exports = {
  addPayment,
  listPayments,
  getCustomerOutstandingDues,
  addPaymentToKhata,
  getUnlinkedMoneyReceipts,
  linkMoneyReceiptToPayment,
  getUnlinkedPurchaseBills,
  linkPurchaseBillToPayment,
  getUnlinkedKhataDebitsForPayment,
};
