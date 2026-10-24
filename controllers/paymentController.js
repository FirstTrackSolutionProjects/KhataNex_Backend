const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { getTenantContext, hasPermission, logAuditEvent } = require("../utils/tenantContext");

const VALID_PURPOSES = [
  "Due Received",
  "Advance Receivable",
  "Advance Payable",
  "Money Received",
  "Paid Out",
  "Purchase Bill",
  "Product Sale",
  "Amount Received",
  "New Payment",
];

const resolveCategory = (purpose, payment_category) => {
  if (payment_category) {
    const cat = String(payment_category).trim().toLowerCase();
    if (
      cat === "money_received" ||
      cat === "moneyreceived" ||
      cat === "amount_received" ||
      cat === "amountreceived" ||
      cat === "normal_received" ||
      cat === "normalreceived" ||
      cat === "received"
    ) {
      return "money_received";
    }
    if (
      cat === "advance_receivable" ||
      cat === "advancereceivable" ||
      cat === "advance_from_investor" ||
      cat === "investor_advance" ||
      cat === "advance"
    ) {
      return "advance_receivable";
    }
    if (
      cat === "advance_payable" ||
      cat === "advancepayable" ||
      cat === "advance_paid"
    ) {
      return "advance_payable";
    }
    if (cat === "purchase_bill" || cat === "purchasebill") return "paid_by_business";
    if (
      cat === "paid_out" ||
      cat === "paidout" ||
      cat === "paid_by_business"
    ) {
      return "paid_out";
    }
    if (cat === "due_received" || cat === "duereceived" || cat === "due") return "due_received";
    if (cat === "product_sale" || cat === "productsale") return "product_sale";
  }

  if (purpose) {
    const p = String(purpose).trim().toLowerCase();
    if (p.includes("purchase")) return "paid_by_business";
    if (
      p.includes("money received") ||
      p.includes("amount received") ||
      p === "received" ||
      p.includes("normal received")
    ) {
      return "money_received";
    }
    if (p.includes("advance payable") || p.includes("advance paid")) return "advance_payable";
    if (p.includes("advance receivable") || p.includes("investor")) return "advance_receivable";
    if (p.includes("due")) return "due_received";
    if (p.includes("paid out") || p.includes("paid_by_business")) return "paid_out";
    if (p.includes("product") || p.includes("sale")) return "product_sale";
  }

  // Default is Money Received (money_received). Due Received is NEVER the default.
  return "money_received";
};

const resolvePurpose = (purpose, payment_category) => {
  const category = resolveCategory(purpose, payment_category);
  switch (category) {
    case "due_received":
      return "Due Received";
    case "advance_receivable":
      return "Advance Receivable";
    case "advance_payable":
      return "Advance Payable";
    case "money_received":
      return "Money Received";
    case "product_sale":
      return "Product Sale";
    case "paid_by_business":
      return "Purchase Bill";
    case "paid_out":
      return "Paid Out";
    default:
      return "Money Received";
  }
};

const normalizePaymentMode = (mode) => {
  if (!mode) return "cash";
  const m = String(mode).trim().toLowerCase();
  if (m === "cash") return "cash";
  return "online";
};

const formatDateForMySQL = (val) => {
  if (!val) return null;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// POST /api/payments
const addPayment = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "create")) {
    throw new ApiError(403, "You do not have permission to create payments.");
  }
  const businessOwnerId = tenant.businessOwnerId;

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

  const explicitCategory = (payment_category || req.body?.category || req.body?.paymentCategory || "").trim().toLowerCase();
  const isPurchaseCategory = explicitCategory === "purchase_bill" || explicitCategory === "purchasebill";

  let resolvedCategory = resolveCategory(purpose, explicitCategory);

  // ONLY due_received loads/allocates customer dues.
  // If payment_category was explicitly provided as anything other than due_received, it NEVER allocates dues.
  if (explicitCategory && !["due_received", "duereceived", "due"].includes(explicitCategory)) {
    // Keep resolvedCategory as resolved, do NOT override to due_received
  } else if ((Array.isArray(allocations) && allocations.length > 0) || (Array.isArray(dues) && dues.length > 0) || due_id) {
    resolvedCategory = "due_received";
  }

  let resolvedPurpose = resolvePurpose(purpose, resolvedCategory);
  if (resolvedCategory === "due_received") {
    resolvedPurpose = "Due Received";
  } else if (isPurchaseCategory) {
    resolvedCategory = "paid_by_business";
    resolvedPurpose = "Purchase Bill";
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let linkedCustomerId = null;
    let customerObj = null;

    if (customer_id) {
      const [custRows] = await conn.query(
        "SELECT id, name, phone, email, total_due FROM customers WHERE id = ? AND created_by = ?",
        [customer_id, businessOwnerId]
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
    let linkedMoneyReceiptCreatedAt = null;
    let resolvedPartyName = party_name || (customerObj?.name ?? null);
    const recordedAllocations = [];

    const rawKhataEntryId = req.body?.khata_entry_id || req.body?.khataId || req.body?.khata_id;
    if (rawKhataEntryId) {
      const [existingKhataPay] = await conn.query(
        "SELECT * FROM payments WHERE khata_entry_id = ? AND created_by = ? LIMIT 1",
        [rawKhataEntryId, businessOwnerId]
      );
      if (existingKhataPay.length > 0) {
        await conn.commit();
        return res.status(200).json({
          success: true,
          message: "Payment for this Khata debit already exists.",
          payment: existingKhataPay[0],
        });
      }
    }

    // Target purchase bill resolution supporting all common frontend field variations:
    // purchase_bill_id, bill_id, id, billId, purchaseBillId, bill_number, purpose regex, req.params.id
    let targetBillId =
      purchase_bill_id ||
      req.body.purchase_bill_id ||
      req.body.purchaseBillId ||
      req.body.bill_id ||
      req.body.billId ||
      req.body.id ||
      req.params?.id ||
      req.params?.purchase_bill_id ||
      req.params?.bill_id;

    if (!targetBillId) {
      let candidateBillNumber =
        req.body?.bill_number ||
        req.body?.billNumber ||
        req.query?.bill_number ||
        req.query?.billNumber;

      if (!candidateBillNumber && purpose) {
        const match = String(purpose).match(/Purchase Bill\s*#?\s*([A-Za-z0-9_\-\/]+)/i);
        if (match) {
          candidateBillNumber = match[1].trim();
        }
      }

      if (candidateBillNumber) {
        const [matchedBills] = await conn.query(
          "SELECT id FROM purchase_bills WHERE (bill_number = ? OR id = ?) AND created_by = ? LIMIT 1",
          [String(candidateBillNumber).trim(), Number(candidateBillNumber) || 0, businessOwnerId]
        );
        if (matchedBills.length) {
          targetBillId = matchedBills[0].id;
        }
      }
    }

    if (!targetBillId && (isPurchaseCategory || resolvedPurpose === "Purchase Bill")) {
      const vendorName = party_name || req.body?.vendor_name || req.body?.recipient_name;
      if (vendorName) {
        const [recentBills] = await conn.query(
          "SELECT id FROM purchase_bills WHERE created_by = ? AND vendor_name = ? ORDER BY id DESC LIMIT 1",
          [businessOwnerId, String(vendorName).trim()]
        );
        if (recentBills.length) {
          targetBillId = recentBills[0].id;
        }
      }
    }

    // 0a. PURCHASE BILL PAYMENT: Look up purchase bill & calculate total from purchase_bill_items
    if (targetBillId || resolvedPurpose === "Purchase Bill" || isPurchaseCategory) {
      if (!targetBillId) {
        throw new ApiError(400, "purchase_bill_id or valid bill_number is required for Purchase Bill payment.");
      }

      const [pbRows] = await conn.query(
        "SELECT * FROM purchase_bills WHERE id = ? AND created_by = ? FOR UPDATE",
        [targetBillId, businessOwnerId]
      );

      if (!pbRows.length) {
        throw new ApiError(404, "Purchase bill not found.");
      }

      const pb = pbRows[0];

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
      resolvedPurpose = pb.bill_number ? `Purchase Bill #${pb.bill_number}` : "Purchase Bill";
      if (!resolvedPartyName && (pb.vendor_name || req.body?.vendor_name || req.body?.recipient_name)) {
        resolvedPartyName = pb.vendor_name || req.body?.vendor_name || req.body?.recipient_name;
      }

      // Check if a payment for this purchase bill already exists
      const [existingPbPayments] = await conn.query(
        `SELECT * FROM payments
         WHERE ((purchase_bill_id = ? OR id = ?)
                OR (purpose = ? AND ? != '')
                OR (purpose = ? AND ? != ''))
           AND created_by = ?
         ORDER BY id ASC`,
        [
          pb.id,
          pb.payment_id || 0,
          `Purchase Bill #${pb.bill_number}`,
          pb.bill_number || "",
          `Purchase Bill ${pb.bill_number}`,
          pb.bill_number || "",
          businessOwnerId,
        ]
      );

      if (existingPbPayments.length > 0) {
        const primaryPayment = existingPbPayments[0];
        const resolvedMode = normalizePaymentMode(payment_mode || req.body?.mode || primaryPayment.payment_mode);
        const resolvedDate = formatDateForMySQL(payment_date || primaryPayment.payment_date || pb.bill_date);

        await conn.query(
          `UPDATE payments
           SET payment_category = 'paid_by_business',
               party_name = ?,
               purpose = ?,
               amount = ?,
               payment_mode = ?,
               payment_date = COALESCE(?, CURRENT_DATE),
               purchase_bill_id = ?
           WHERE id = ? AND created_by = ?`,
          [
            resolvedPartyName || primaryPayment.party_name || pb.vendor_name || "Vendor",
            primaryPayment.purpose || resolvedPurpose,
            finalAmount,
            resolvedMode,
            resolvedDate,
            pb.id,
            primaryPayment.id,
            businessOwnerId,
          ]
        );

        if (existingPbPayments.length > 1) {
          const extraIds = existingPbPayments.slice(1).map((p) => p.id);
          await conn.query(
            "UPDATE payments SET purchase_bill_id = ?, payment_category = 'paid_by_business' WHERE id IN (?) AND created_by = ?",
            [pb.id, extraIds, businessOwnerId]
          );
        }

        await conn.query(
          "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
          [primaryPayment.id, pb.id, businessOwnerId]
        );

        await conn.commit();

        const [updatedRows] = await pool.query(
          "SELECT * FROM payments WHERE id = ? AND created_by = ?",
          [primaryPayment.id, businessOwnerId]
        );

        return res.status(200).json({
          success: true,
          message: "Purchase bill payment updated successfully.",
          payment: updatedRows[0],
        });
      }
    }

    // 0b. MONEY RECEIPT PAYMENT: Link from money receipt
    else if (money_receipt_id) {
      const [mrRows] = await conn.query(
        "SELECT * FROM money_receipts WHERE id = ? AND created_by = ? FOR UPDATE",
        [money_receipt_id, businessOwnerId]
      );

      if (!mrRows.length) {
        throw new ApiError(404, "Money receipt not found.");
      }

      const mr = mrRows[0];
      if (mr.is_linked_to_payment === 1 || mr.payment_id) {
        throw new ApiError(400, "This money receipt is already linked to a payment.");
      }

      if (mr.against_type === "advance") {
        resolvedCategory = "advance_receivable";
        resolvedPurpose = "Advance Receivable";
      } else {
        resolvedCategory = "money_received";
        resolvedPurpose = "Money Received";
      }

      finalAmount = Number(mr.amount_received || 0);
      linkedMoneyReceiptId = mr.id;
      if (!linkedCustomerId && mr.customer_id) {
        linkedCustomerId = mr.customer_id;
      }
      if (!resolvedPartyName && mr.received_from_name) {
        resolvedPartyName = mr.received_from_name;
      }
      if (!payment_date && mr.receipt_date) {
        payment_date = formatDateForMySQL(mr.receipt_date);
      }
      linkedMoneyReceiptCreatedAt = mr.receipt_date || mr.created_at;
    }

    // 1. PRODUCT SALE: Look up from Product Master (stock) at selling price (stock.price)
    if (!linkedPurchaseBillId && !linkedMoneyReceiptId && (resolvedPurpose === "Product Sale" || resolvedCategory === "product_sale")) {
      if (!product_id) {
        throw new ApiError(400, "product_id is required for Product Sale.");
      }

      const [stockRows] = await conn.query(
        "SELECT id, product_name, price FROM stock WHERE id = ? AND created_by = ?",
        [product_id, businessOwnerId]
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
          const dueParams = [targetDueId, businessOwnerId];
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
            [finalAmount, linkedCustomerId, businessOwnerId]
          );
        }
      } else if (linkedCustomerId && finalAmount > 0) {
        // Fallback: auto-allocate in FIFO order across customer's pending dues
        const [pendingDues] = await conn.query(
          "SELECT * FROM customer_dues WHERE customer_id = ? AND created_by = ? AND status != 'settled' ORDER BY created_at ASC, id ASC",
          [linkedCustomerId, businessOwnerId]
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
          [finalAmount, linkedCustomerId, businessOwnerId]
        );
      }
    }
    // Note: When resolvedCategory === 'amount_received' (Normal Received),
    // we NEVER allocate against dues or decrement customer dues. It is an independent receipt.

    // 3. PAID OUT / PAID BY BUSINESS add_to_khata flag
    const shouldAddToKhata =
      ((resolvedCategory === "paid_by_business" || resolvedCategory === "paid_out") && !linkedPurchaseBillId)
        ? Boolean(add_to_khata === true || add_to_khata === "true" || add_to_khata === 1)
        : 0;

    const resolvedPaymentDate = formatDateForMySQL(payment_date);

    const [result] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, product_id, product_name, quantity, unit_price,
         purchase_bill_id, money_receipt_id, add_to_khata, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        resolvedCategory,
        resolvedPartyName,
        linkedCustomerId,
        resolvedPurpose,
        finalAmount,
        normalizePaymentMode(payment_mode),
        resolvedPaymentDate || null,
        linkedProductId,
        linkedProductName,
        linkedQuantity,
        linkedUnitPrice,
        linkedPurchaseBillId,
        linkedMoneyReceiptId,
        shouldAddToKhata ? 1 : 0,
        businessOwnerId,
        linkedMoneyReceiptCreatedAt || null,
      ]
    );

    const paymentId = result.insertId;

    if (linkedPurchaseBillId) {
      await conn.query(
        "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [paymentId, linkedPurchaseBillId, businessOwnerId]
      );
    }

    if (linkedMoneyReceiptId) {
      await conn.query(
        "UPDATE money_receipts SET is_linked_to_payment = 1, payment_id = ? WHERE id = ? AND created_by = ?",
        [paymentId, linkedMoneyReceiptId, businessOwnerId]
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

    await logAuditEvent(req, {
      action: "CREATE_PAYMENT",
      targetType: "payment",
      targetId: paymentId,
      details: {
        category: resolvedCategory,
        purpose: resolvedPurpose,
        amount: finalAmount,
        party_name: resolvedPartyName,
        payment_mode: normalizePaymentMode(payment_mode),
        customer_id: linkedCustomerId,
        purchase_bill_id: linkedPurchaseBillId,
        money_receipt_id: linkedMoneyReceiptId,
      },
    });

    const [rows] = await pool.query(
      `SELECT p.*,
              cu.name AS customer_name,
              cu.phone AS customer_phone,
              cu.total_due AS customer_total_due
       FROM payments p
       LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.id = ? AND p.created_by = ?`,
      [paymentId, businessOwnerId]
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
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "view")) {
    throw new ApiError(403, "You do not have permission to view payments.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const { category, purpose, customer_id, from, to, search } = req.query;

  // Handle dedicated Superadmin Subscriptions category
  if (category && String(category).trim().toLowerCase() === "subscriptions") {
    if (req.user.role !== "superadmin") {
      throw new ApiError(403, "Subscription payments category is restricted to Superadmin.");
    }

    let subSql = `
      SELECT o.id,
             o.id AS payment_id,
             o.order_number,
             o.total_paise,
             o.list_price_paise,
             o.coupon_discount_paise,
             o.introductory_discount_paise,
             o.discount_paise,
             o.taxable_paise,
             o.tax_paise,
             o.tax_percent,
             (o.total_paise / 100) AS amount,
             (o.list_price_paise / 100) AS base_amount,
             (o.discount_paise / 100) AS discount,
             (o.tax_paise / 100) AS tax,
             o.status AS payment_status,
             o.status,
             'subscriptions' AS payment_category,
             'SaaS Subscription' AS purpose,
             'online' AS payment_mode,
             o.provider,
             o.provider_payment_id,
             o.provider_order_id,
             COALESCE(o.paid_at, o.created_at) AS payment_date,
             COALESCE(o.paid_at, o.created_at) AS effective_date,
             TIME(COALESCE(o.paid_at, o.created_at)) AS payment_time,
             TIME(COALESCE(o.paid_at, o.created_at)) AS time,
             'verified_collection' AS settlement_status,
             u.id AS user_id,
             u.name AS party_name,
             u.name AS customer_name,
             u.email AS customer_email,
             u.phone AS customer_phone,
             u.business_name,
             p.name AS plan_name,
             p.duration_months,
             i.invoice_number,
             i.pdf_filename
      FROM subscription_orders o
      JOIN users u ON o.user_id = u.id
      JOIN subscription_plans p ON o.plan_id = p.id
      LEFT JOIN subscription_invoices i ON i.order_id = o.id
      WHERE o.status = 'paid'
    `;
    const subParams = [];

    if (search) {
      subSql += " AND (u.name LIKE ? OR u.email LIKE ? OR o.order_number LIKE ? OR o.provider_payment_id LIKE ?)";
      subParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (from) {
      subSql += " AND o.paid_at >= ?";
      subParams.push(from);
    }
    if (to) {
      subSql += " AND o.paid_at <= ?";
      subParams.push(to);
    }

    subSql += " ORDER BY o.paid_at DESC LIMIT 100";
    const [subRows] = await pool.query(subSql, subParams);

    return res.json({
      success: true,
      category: "subscriptions",
      accountingNotice: "Payments shown represent verified gateway collections (verified_collection). Payouts to the bank settle per gateway cycle (T+2 business days) and are tracked separately under Settlements.",
      payments: subRows,
    });
  }

  let sql = `
    SELECT p.*,
           u.name AS added_by,
           cu.name AS customer_name,
           cu.phone AS customer_phone,
           mr.receipt_number,
           COALESCE(
             mr.receipt_time,
             TIME(mr.receipt_date),
             ke.entry_time,
             TIME(p.created_at)
           ) AS time,
           COALESCE(
             mr.receipt_time,
             TIME(mr.receipt_date),
             ke.entry_time,
             TIME(p.created_at)
           ) AS payment_time,
           COALESCE(
             p.payment_date,
             DATE(mr.receipt_date),
             ke.entry_date,
             DATE(p.created_at)
           ) AS effective_date
    FROM payments p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN customers cu ON cu.id = p.customer_id
    LEFT JOIN money_receipts mr ON mr.id = p.money_receipt_id
    LEFT JOIN khata_entries ke ON ke.id = p.khata_entry_id
    WHERE 1=1
  `;
  const params = [];

  sql += " AND p.created_by = ?";
  params.push(businessOwnerId);

  if (category) {
    const cat = String(category).trim().toLowerCase();
    if (cat === "money_received" || cat === "amount_received") {
      sql += " AND p.payment_category IN ('money_received', 'amount_received', 'due_received')";
    } else if (cat === "advance_receivable" || cat === "advance_from_investor") {
      sql += " AND p.payment_category IN ('advance_receivable', 'advance_from_investor')";
    } else if (cat === "paid_out" || cat === "paid_by_business") {
      sql += " AND p.payment_category IN ('paid_out', 'paid_by_business')";
    } else {
      sql += " AND p.payment_category = ?";
      params.push(cat);
    }
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

  sql += " ORDER BY COALESCE(p.payment_date, DATE(mr.receipt_date), ke.entry_date, DATE(p.created_at)) DESC, COALESCE(mr.receipt_time, TIME(mr.receipt_date), ke.entry_time, TIME(p.created_at), '00:00:00') DESC, p.id DESC";

  const [rows] = await pool.query(sql, params);

  const normalizedRows = rows.map((p) => {
    let cat = p.payment_category;
    if (cat === "amount_received") cat = "money_received";
    if (cat === "advance_from_investor") cat = "advance_receivable";
    if (cat === "paid_by_business") cat = "paid_out";
    const resolvedTime = p.time ? String(p.time).slice(0, 8) : (p.created_at ? new Date(p.created_at).toTimeString().slice(0, 8) : "00:00:00");
    return {
      ...p,
      payment_category: cat,
      category: cat,
      time: resolvedTime,
      payment_time: resolvedTime,
    };
  });

  res.json({
    success: true,
    count: normalizedRows.length,
    payments: normalizedRows,
  });
});

// PUT /api/payments/:id
const updatePayment = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "edit")) {
    throw new ApiError(403, "You do not have permission to edit payments.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const { id } = req.params;
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
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, businessOwnerId]
    );
    if (!existingRows.length) {
      throw new ApiError(404, "Payment not found.");
    }

    const payment = existingRows[0];
    const newAmount = amount !== undefined && Number(amount) > 0 ? Number(amount) : Number(payment.amount);
    const resolvedPurpose = purpose || payment.purpose;
    const resolvedCategory = resolveCategory(resolvedPurpose, payment_category || payment.payment_category);
    const resolvedMode = normalizePaymentMode(payment_mode || payment.payment_mode);
    const finalDate = formatDateForMySQL(payment_date || payment.payment_date);

    const amountDiff = newAmount - Number(payment.amount);
    if (amountDiff !== 0 && payment.customer_id) {
      const [allocRows] = await conn.query(
        "SELECT * FROM customer_due_allocations WHERE payment_id = ?",
        [payment.id]
      );
      if (allocRows.length) {
        await conn.query(
          "UPDATE customers SET total_due = GREATEST(0, total_due - ?) WHERE id = ? AND created_by = ?",
          [amountDiff, payment.customer_id, businessOwnerId]
        );
      }
    }

    if (payment.khata_entry_id) {
      await conn.query(
        `UPDATE khata_entries
         SET amount = ?, description = ?, entry_date = ?, payment_mode = ?
         WHERE id = ? AND created_by = ?`,
        [newAmount, resolvedPurpose, finalDate, resolvedMode, payment.khata_entry_id, businessOwnerId]
      );
    }

    await conn.query(
      `UPDATE payments
       SET payment_category = ?, party_name = ?, customer_id = ?, purpose = ?,
           amount = ?, payment_mode = ?, payment_date = ?, product_id = ?, quantity = ?
       WHERE id = ? AND created_by = ?`,
      [
        resolvedCategory,
        party_name !== undefined ? party_name : payment.party_name,
        customer_id !== undefined ? customer_id : payment.customer_id,
        resolvedPurpose,
        newAmount,
        resolvedMode,
        finalDate,
        product_id !== undefined ? product_id : payment.product_id,
        quantity !== undefined ? quantity : payment.quantity,
        id,
        businessOwnerId,
      ]
    );

    await conn.commit();

    await logAuditEvent(req, {
      action: "UPDATE_PAYMENT",
      targetType: "payment",
      targetId: id,
      details: {
        amount: newAmount,
        purpose: resolvedPurpose,
        payment_category: resolvedCategory,
        party_name: party_name !== undefined ? party_name : payment.party_name,
      },
    });

    const [updatedRows] = await pool.query(
      `SELECT p.*, cu.name AS customer_name, cu.phone AS customer_phone
       FROM payments p
       LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.id = ? AND p.created_by = ?`,
      [id, businessOwnerId]
    );

    res.json({
      success: true,
      message: "Payment updated successfully.",
      payment: updatedRows[0],
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// DELETE /api/payments/:id
const deletePayment = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "delete")) {
    throw new ApiError(403, "You do not have permission to delete payments.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const { id } = req.params;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, businessOwnerId]
    );
    if (!rows.length) {
      throw new ApiError(404, "Payment not found.");
    }

    const payment = rows[0];

    // Revert due allocations
    const [allocs] = await conn.query(
      "SELECT * FROM customer_due_allocations WHERE payment_id = ?",
      [payment.id]
    );
    let restoredDueAmount = 0;
    for (const alloc of allocs) {
      const [dueRows] = await conn.query(
        "SELECT * FROM customer_dues WHERE id = ?",
        [alloc.due_id]
      );
      if (dueRows.length) {
        const d = dueRows[0];
        const newRemaining = Math.min(Number(d.amount), Number(d.remaining_amount) + Number(alloc.amount));
        const newStatus = newRemaining >= Number(d.amount) ? "pending" : "partially_paid";
        await conn.query(
          "UPDATE customer_dues SET remaining_amount = ?, status = ? WHERE id = ?",
          [newRemaining, newStatus, d.id]
        );
      }
      restoredDueAmount += Number(alloc.amount);
    }

    if (restoredDueAmount > 0 && payment.customer_id) {
      await conn.query(
        "UPDATE customers SET total_due = total_due + ? WHERE id = ? AND created_by = ?",
        [restoredDueAmount, payment.customer_id, businessOwnerId]
      );
    }
    await conn.query("DELETE FROM customer_due_allocations WHERE payment_id = ?", [payment.id]);

    if (payment.khata_entry_id) {
      await conn.query(
        "DELETE FROM khata_entries WHERE id = ? AND created_by = ?",
        [payment.khata_entry_id, businessOwnerId]
      );
    }

    if (payment.purchase_bill_id) {
      await conn.query(
        "UPDATE purchase_bills SET is_paid = 0, payment_id = NULL WHERE id = ? AND created_by = ?",
        [payment.purchase_bill_id, businessOwnerId]
      );
    }

    if (payment.money_receipt_id) {
      await conn.query(
        "UPDATE money_receipts SET is_linked_to_payment = 0, payment_id = NULL WHERE id = ? AND created_by = ?",
        [payment.money_receipt_id, businessOwnerId]
      );
    }

    await conn.query("DELETE FROM payments WHERE id = ? AND created_by = ?", [id, businessOwnerId]);

    await conn.commit();

    await logAuditEvent(req, {
      action: "DELETE_PAYMENT",
      targetType: "payment",
      targetId: id,
      details: {
        amount: payment.amount,
        purpose: payment.purpose,
        payment_category: payment.payment_category,
        party_name: payment.party_name,
      },
    });

    res.json({
      success: true,
      message: "Payment deleted successfully.",
      deleted_id: id,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/payments/dues?customer_id=...
// Returns outstanding dues for a customer
const getCustomerOutstandingDues = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "customers", "view") && !hasPermission(req.user, "payments", "view")) {
    throw new ApiError(403, "You do not have permission to view customer dues.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const customerId = req.query.customer_id;

  if (!customerId) {
    throw new ApiError(400, "customer_id is required to fetch outstanding dues.");
  }

  const [rows] = await pool.query(
    `SELECT * FROM customer_dues
     WHERE customer_id = ? AND created_by = ? AND status != 'settled'
     ORDER BY created_at ASC, id ASC`,
    [customerId, businessOwnerId]
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
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "edit") && !hasPermission(req.user, "khata", "create")) {
    throw new ApiError(403, "You do not have permission to link payment to Khata.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const { id } = req.params;

  const [rows] = await pool.query(
    "SELECT * FROM payments WHERE id = ? AND created_by = ?",
    [id, businessOwnerId]
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
    [id, businessOwnerId]
  );

  const [updated] = await pool.query(
    "SELECT * FROM payments WHERE id = ? AND created_by = ?",
    [id, businessOwnerId]
  );

  await logAuditEvent(req, {
    action: "LINK_PAYMENT_TO_KHATA",
    targetType: "payment",
    targetId: id,
    details: { payment_id: id },
  });

  res.json({
    success: true,
    message: "Payment linked to Khata successfully.",
    payment: updated[0],
  });
});

// GET /api/payments/unlinked-money-receipts
const getUnlinkedMoneyReceipts = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "view") && !hasPermission(req.user, "invoices", "view")) {
    throw new ApiError(403, "You do not have permission to view money receipts.");
  }
  const businessOwnerId = tenant.businessOwnerId;

  const [rows] = await pool.query(
    `SELECT mr.*, cu.name AS customer_name
     FROM money_receipts mr
     LEFT JOIN customers cu ON cu.id = mr.customer_id
     WHERE (mr.is_linked_to_payment = 0 OR mr.is_linked_to_payment IS NULL)
       AND (mr.payment_id IS NULL)
       AND mr.created_by = ?
     ORDER BY mr.receipt_date DESC, mr.id DESC`,
    [businessOwnerId]
  );

  res.json({
    success: true,
    count: rows.length,
    money_receipts: rows,
  });
});

// POST /api/payments/link-money-receipt/:id
const linkMoneyReceiptToPayment = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "create")) {
    throw new ApiError(403, "You do not have permission to link money receipts to payments.");
  }
  const businessOwnerId = tenant.businessOwnerId;

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
      [id, businessOwnerId]
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

    const category = mr.against_type === "advance" ? "advance_receivable" : "money_received";
    const purpose = mr.against_type === "advance" ? "Advance Receivable" : "Money Received";

    const receiptDateVal = formatDateForMySQL(mr.receipt_date);
    const [result] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, money_receipt_id, add_to_khata, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?, 0, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [
        category,
        mr.received_from_name || mr.customer_name || "Customer",
        mr.customer_id || null,
        purpose,
        Number(mr.amount_received || 0),
        normalizePaymentMode(payment_mode || mr.payment_mode),
        receiptDateVal,
        mr.id,
        businessOwnerId,
        mr.receipt_date || mr.created_at,
      ]
    );

    const paymentId = result.insertId;

    await conn.query(
      "UPDATE money_receipts SET is_linked_to_payment = 1, payment_id = ? WHERE id = ? AND created_by = ?",
      [paymentId, mr.id, businessOwnerId]
    );

    await conn.commit();

    await logAuditEvent(req, {
      action: "LINK_MONEY_RECEIPT_TO_PAYMENT",
      targetType: "payment",
      targetId: paymentId,
      details: { money_receipt_id: mr.id, amount: mr.amount_received },
    });

    const [paymentRows] = await pool.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ?",
      [paymentId, businessOwnerId]
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
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "view") && !hasPermission(req.user, "inventory", "view")) {
    throw new ApiError(403, "You do not have permission to view purchase bills.");
  }
  const businessOwnerId = tenant.businessOwnerId;

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
    [businessOwnerId]
  );

  res.json({
    success: true,
    count: rows.length,
    purchase_bills: rows,
  });
});

// POST /api/payments/link-purchase-bill/:id
const linkPurchaseBillToPayment = asyncHandler(async (req, res) => {
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "create")) {
    throw new ApiError(403, "You do not have permission to pay purchase bills.");
  }
  const businessOwnerId = tenant.businessOwnerId;

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
      [id, businessOwnerId]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Purchase bill not found.");
    }

    const pb = rows[0];

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

    const [existingPbPayments] = await conn.query(
      "SELECT * FROM payments WHERE (purchase_bill_id = ? OR id = ?) AND created_by = ? ORDER BY id ASC",
      [pb.id, pb.payment_id || 0, businessOwnerId]
    );

    let paymentId;
    if (existingPbPayments.length > 0) {
      const primaryPayment = existingPbPayments[0];
      paymentId = primaryPayment.id;
      await conn.query(
        `UPDATE payments
         SET amount = ?, payment_mode = ?, party_name = COALESCE(?, party_name),
             payment_date = COALESCE(?, payment_date, CURRENT_DATE),
             purchase_bill_id = ?
         WHERE id = ? AND created_by = ?`,
        [
          billTotal,
          normalizePaymentMode(payment_mode || primaryPayment.payment_mode),
          pb.vendor_name || null,
          formatDateForMySQL(pb.bill_date),
          pb.id,
          paymentId,
          businessOwnerId,
        ]
      );
      if (existingPbPayments.length > 1) {
        const extraIds = existingPbPayments.slice(1).map((p) => p.id);
        await conn.query("DELETE FROM payments WHERE id IN (?) AND created_by = ?", [extraIds, businessOwnerId]);
      }
    } else {
      const [result] = await conn.query(
        `INSERT INTO payments
          (payment_category, party_name, purpose, amount,
           payment_mode, payment_date, purchase_bill_id, add_to_khata, created_by)
         VALUES ('paid_by_business', ?, 'Purchase Bill', ?, ?, ?, ?, 0, ?)`,
        [
          pb.vendor_name || "Vendor",
          billTotal,
          normalizePaymentMode(payment_mode),
          formatDateForMySQL(pb.bill_date),
          pb.id,
          businessOwnerId,
        ]
      );
      paymentId = result.insertId;
    }

    await conn.query(
      "UPDATE purchase_bills SET is_paid = 1, payment_id = ? WHERE id = ? AND created_by = ?",
      [paymentId, pb.id, businessOwnerId]
    );

    await conn.commit();

    await logAuditEvent(req, {
      action: "LINK_PURCHASE_BILL_TO_PAYMENT",
      targetType: "payment",
      targetId: paymentId,
      details: { purchase_bill_id: pb.id, bill_number: pb.bill_number, amount: billTotal },
    });

    const [paymentRows] = await pool.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ?",
      [paymentId, businessOwnerId]
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
  const tenant = getTenantContext(req);
  if (!hasPermission(req.user, "payments", "view") && !hasPermission(req.user, "khata", "view")) {
    throw new ApiError(403, "You do not have permission to view Khata debits.");
  }
  const businessOwnerId = tenant.businessOwnerId;

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
    [businessOwnerId]
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
  updatePayment,
  deletePayment,
  getCustomerOutstandingDues,
  addPaymentToKhata,
  getUnlinkedMoneyReceipts,
  linkMoneyReceiptToPayment,
  getUnlinkedPurchaseBills,
  linkPurchaseBillToPayment,
  getUnlinkedKhataDebitsForPayment,
};
