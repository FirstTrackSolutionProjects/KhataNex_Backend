const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const getDateBoundaries = (period) => {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const p = String(period || "").trim().toLowerCase();
  if (p === "today") {
    return { from: todayStr, to: todayStr };
  }
  if (p === "this_week" || p === "week" || p === "this week") {
    // Current week starting from Monday (or Sunday) to today
    const d = new Date(now);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayOfWeek);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  if (p === "this_month" || p === "month" || p === "this month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  if (p === "this_year" || p === "year" || p === "this year") {
    const d = new Date(now.getFullYear(), 0, 1);
    return { from: d.toISOString().split("T")[0], to: todayStr };
  }
  return { from: null, to: null };
};

// GET /api/khata?customer_id=&from=&to=&type=&period=
// Unified ledger feed containing:
//   - collections (sales) -> type: 'credit'
//   - khata_entries (debits, product sale credits, manual credits) -> type: 'debit' or 'credit'
//   - customer_dues -> type: 'due'
const getKhata = asyncHandler(async (req, res) => {
  let { customer_id, from, to, type, period, timeframe, range } = req.query;

  const resolvedPeriod = period || timeframe || range;
  if (resolvedPeriod && (!from || !to)) {
    const boundaries = getDateBoundaries(resolvedPeriod);
    if (boundaries.from && !from) from = boundaries.from;
    if (boundaries.to && !to) to = boundaries.to;
  }

  // 1. Credit entries (Sales from collections)
  let salesSql = `
    SELECT c.id, c.amount, c.sale_date AS date, c.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
           'credit' AS type, c.payment_type,
           c.customer_id,
           c.item_name AS product_name,
           NULL AS product_id,
           NULL AS quantity,
           NULL AS unit_price,
           0 AS is_linked_to_payment,
           NULL AS payment_id,
           'collection' AS source
    FROM collections c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.created_by = ?
  `;
  const salesParams = [req.user.id];
  if (customer_id) {
    salesSql += " AND c.customer_id = ?";
    salesParams.push(customer_id);
  }
  if (from) {
    salesSql += " AND c.sale_date >= ?";
    salesParams.push(from);
  }
  if (to) {
    salesSql += " AND c.sale_date <= ?";
    salesParams.push(to);
  }

  // 2. Khata entries (Debits and Credits from khata_entries)
  let khataSql = `
    SELECT ke.id, ke.amount, ke.entry_date AS date, ke.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           ke.description,
           ke.type,
           NULL AS payment_type,
           ke.customer_id,
           s.product_name,
           ke.product_id,
           ke.quantity,
           ke.unit_price,
           ke.is_linked_to_payment,
           ke.payment_id,
           'khata_entry' AS source
    FROM khata_entries ke
    LEFT JOIN customers cu ON cu.id = ke.customer_id
    LEFT JOIN stock s ON s.id = ke.product_id
    WHERE ke.created_by = ?
  `;
  const khataParams = [req.user.id];
  if (customer_id) {
    khataSql += " AND ke.customer_id = ?";
    khataParams.push(customer_id);
  }
  if (from) {
    khataSql += " AND ke.entry_date >= ?";
    khataParams.push(from);
  }
  if (to) {
    khataSql += " AND ke.entry_date <= ?";
    khataParams.push(to);
  }

  // 3. Due entries (from customer_dues)
  let duesSql = `
    SELECT cd.id, cd.amount, cd.remaining_amount,
           COALESCE(cd.due_date, DATE(cd.created_at)) AS date,
           cd.created_at,
           COALESCE(cu.name, 'Customer') AS name,
           cd.description,
           'due' AS type,
           cd.status,
           cd.customer_id,
           s.product_name,
           cd.product_id,
           cd.quantity,
           cd.unit_price,
           0 AS is_linked_to_payment,
           NULL AS payment_id,
           'customer_due' AS source
    FROM customer_dues cd
    LEFT JOIN customers cu ON cu.id = cd.customer_id
    LEFT JOIN stock s ON s.id = cd.product_id
    WHERE cd.created_by = ?
  `;
  const duesParams = [req.user.id];
  if (customer_id) {
    duesSql += " AND cd.customer_id = ?";
    duesParams.push(customer_id);
  }
  if (from) {
    duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) >= ?";
    duesParams.push(from);
  }
  if (to) {
    duesSql += " AND COALESCE(cd.due_date, DATE(cd.created_at)) <= ?";
    duesParams.push(to);
  }

  const [sales] = await pool.query(salesSql, salesParams);
  const [khataRows] = await pool.query(khataSql, khataParams);
  const [dues] = await pool.query(duesSql, duesParams);

  // Normalize entries so that type is explicitly and unambiguously identified
  const normalizedSales = sales.map((row) => ({
    ...row,
    type: "credit",
    category: "credit",
    is_credit: true,
    is_debit: false,
    is_due: false,
    signed_amount: Number(row.amount || 0),
  }));

  const normalizedKhata = khataRows.map((row) => {
    const isDebit = String(row.type).toLowerCase() === "debit";
    const amt = Number(row.amount || 0);
    return {
      ...row,
      type: isDebit ? "debit" : "credit",
      category: isDebit ? "debit" : "credit",
      is_debit: isDebit,
      is_credit: !isDebit,
      is_due: false,
      signed_amount: isDebit ? -amt : amt,
    };
  });

  const normalizedDues = dues.map((row) => ({
    ...row,
    type: "due",
    category: "due",
    is_due: true,
    is_debit: false,
    is_credit: false,
    signed_amount: Number(row.amount || 0),
  }));

  let entries = [...normalizedSales, ...normalizedKhata, ...normalizedDues];

  // Calculate totals before type filtering for accurate ledger totals
  let totalCredit = 0;
  let totalDebit = 0;
  let totalDue = 0;

  for (const entry of entries) {
    const amt = Number(entry.amount || 0);
    if (entry.is_credit) {
      totalCredit += amt;
    } else if (entry.is_debit) {
      totalDebit += amt;
    } else if (entry.is_due) {
      totalDue += amt;
    }
  }

  totalCredit = Math.round(totalCredit * 100) / 100;
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalDue = Math.round(totalDue * 100) / 100;
  const netBalance = Math.round((totalCredit - totalDebit) * 100) / 100;

  if (type) {
    const filterType = String(type).trim().toLowerCase();
    entries = entries.filter((e) => e.type.toLowerCase() === filterType);
  }

  entries.sort(
    (a, b) =>
      new Date(b.date) - new Date(a.date) ||
      new Date(b.created_at) - new Date(a.created_at)
  );

  res.json({
    success: true,
    count: entries.length,
    period: resolvedPeriod || "custom",
    range: { from: from || "all-time", to: to || "all-time" },
    total_credit: totalCredit,
    total_debit: totalDebit,
    total_due: totalDue,
    net_balance: netBalance,
    summary: {
      total_credit: totalCredit,
      total_debit: totalDebit,
      total_due: totalDue,
      net_balance: netBalance,
    },
    dashboard: {
      total_credit: totalCredit,
      total_debit: totalDebit,
      total_due: totalDue,
      net_balance: netBalance,
    },
    entries,
  });
});

// GET /api/khata/dashboard & GET /api/khata/summary
// Dedicated dashboard totals for Today, This Week, This Month, This Year, All Time
const getKhataDashboard = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const calculateForRange = async (fromDate, toDate) => {
    let salesQuery = "SELECT COALESCE(SUM(amount), 0) AS total FROM collections WHERE created_by = ?";
    const salesParams = [userId];
    if (fromDate) {
      salesQuery += " AND sale_date >= ?";
      salesParams.push(fromDate);
    }
    if (toDate) {
      salesQuery += " AND sale_date <= ?";
      salesParams.push(toDate);
    }

    let creditQuery = "SELECT COALESCE(SUM(amount), 0) AS total FROM khata_entries WHERE created_by = ? AND type = 'credit'";
    const creditParams = [userId];
    if (fromDate) {
      creditQuery += " AND entry_date >= ?";
      creditParams.push(fromDate);
    }
    if (toDate) {
      creditQuery += " AND entry_date <= ?";
      creditParams.push(toDate);
    }

    let debitQuery = "SELECT COALESCE(SUM(amount), 0) AS total FROM khata_entries WHERE created_by = ? AND type = 'debit'";
    const debitParams = [userId];
    if (fromDate) {
      debitQuery += " AND entry_date >= ?";
      debitParams.push(fromDate);
    }
    if (toDate) {
      debitQuery += " AND entry_date <= ?";
      debitParams.push(toDate);
    }

    let dueQuery = "SELECT COALESCE(SUM(amount), 0) AS total FROM customer_dues WHERE created_by = ?";
    const dueParams = [userId];
    if (fromDate) {
      dueQuery += " AND COALESCE(due_date, DATE(created_at)) >= ?";
      dueParams.push(fromDate);
    }
    if (toDate) {
      dueQuery += " AND COALESCE(due_date, DATE(created_at)) <= ?";
      dueParams.push(toDate);
    }

    const [
      [salesRes],
      [creditRes],
      [debitRes],
      [dueRes],
    ] = await Promise.all([
      pool.query(salesQuery, salesParams),
      pool.query(creditQuery, creditParams),
      pool.query(debitQuery, debitParams),
      pool.query(dueQuery, dueParams),
    ]);

    const totalCredit =
      Math.round((Number(salesRes[0]?.total || 0) + Number(creditRes[0]?.total || 0)) * 100) / 100;
    const totalDebit =
      Math.round(Number(debitRes[0]?.total || 0) * 100) / 100;
    const totalDue =
      Math.round(Number(dueRes[0]?.total || 0) * 100) / 100;
    const netBalance =
      Math.round((totalCredit - totalDebit) * 100) / 100;

    return {
      total_credit: totalCredit,
      total_debit: totalDebit,
      total_due: totalDue,
      net_balance: netBalance,
    };
  };

  const todayBounds = getDateBoundaries("today");
  const weekBounds = getDateBoundaries("this_week");
  const monthBounds = getDateBoundaries("this_month");
  const yearBounds = getDateBoundaries("this_year");

  const [todayTotals, weekTotals, monthTotals, yearTotals, allTotals] =
    await Promise.all([
      calculateForRange(todayBounds.from, todayBounds.to),
      calculateForRange(weekBounds.from, weekBounds.to),
      calculateForRange(monthBounds.from, monthBounds.to),
      calculateForRange(yearBounds.from, yearBounds.to),
      calculateForRange(null, null),
    ]);

  res.json({
    success: true,
    today: todayTotals,
    this_week: weekTotals,
    this_month: monthTotals,
    this_year: yearTotals,
    all_time: allTotals,
    summary: monthTotals, // Default summary corresponds to current month
    total_credit: monthTotals.total_credit,
    total_debit: monthTotals.total_debit,
    total_due: monthTotals.total_due,
    net_balance: monthTotals.net_balance,
  });
});

/**
 * Helper to resolve customer for Khata Credit and Debit entries.
 * - If customer_id is present, ALWAYS use that customer.
 * - Existing customer_id takes strict priority over manual customer fields.
 * - Do NOT fall back to Walk-in/manual customer because a manual customer name is also present.
 * - Do NOT create/use a Walk-in customer when a valid customer_id is supplied.
 * - Only use the manual/Walk-in customer path when customer_id is actually absent.
 */
const resolveKhataCustomer = async (conn, body, userId) => {
  if (!body) return null;

  // 1. Resolve raw customer_id from any common payload format
  const rawId =
    (body.customer_id && typeof body.customer_id === "object" ? body.customer_id.id : null) ??
    body.customer_id ??
    (body.customerId && typeof body.customerId === "object" ? body.customerId.id : null) ??
    body.customerId ??
    (body.customer && typeof body.customer === "object" ? body.customer.id : null) ??
    (typeof body.customer === "number" ||
    (typeof body.customer === "string" && /^\d+$/.test(body.customer.trim()))
      ? body.customer
      : null);

  let parsedId = null;
  if (rawId !== null && rawId !== undefined) {
    const s = String(rawId).trim();
    if (
      s &&
      s.toLowerCase() !== "walk-in" &&
      s.toLowerCase() !== "walk in" &&
      s.toLowerCase() !== "walkin" &&
      s.toLowerCase() !== "null" &&
      s.toLowerCase() !== "undefined"
    ) {
      const num = Number(s);
      parsedId = !isNaN(num) && num > 0 ? num : s;
    }
  }

  // 2. If customer_id is present, ALWAYS use that customer.
  //    Existing customer_id must take priority over manual customer fields.
  //    Do NOT fall back to Walk-in/manual customer when customer_id is present.
  if (parsedId !== null && parsedId !== undefined) {
    // Check if customer exists for this user
    const [custRows] = await conn.query(
      "SELECT id FROM customers WHERE id = ? AND created_by = ?",
      [parsedId, userId]
    );
    if (custRows.length) {
      return custRows[0].id;
    }

    // Check with organization/admin hierarchy
    const [orgCust] = await conn.query(
      `SELECT id FROM customers
       WHERE id = ?
         AND (created_by = ?
              OR created_by = (SELECT created_by_admin FROM users WHERE id = ?)
              OR ? IN (SELECT id FROM users WHERE role = 'superadmin'))`,
      [parsedId, userId, userId, userId]
    );
    if (orgCust.length) {
      return orgCust[0].id;
    }

    // Check if customer exists anywhere in customers table
    const [anyCust] = await conn.query(
      "SELECT id FROM customers WHERE id = ?",
      [parsedId]
    );
    if (anyCust.length) {
      return anyCust[0].id;
    }

    return parsedId;
  }

  // 3. Only use the manual/Walk-in customer path when customer_id is actually absent.
  const rawManualName =
    body.customer_name ??
    body.customerName ??
    (typeof body.customer === "string" ? body.customer : null);
  const manualName = rawManualName ? String(rawManualName).trim() : "";

  const isWalkIn =
    !manualName ||
    manualName.toLowerCase() === "walk-in" ||
    manualName.toLowerCase() === "walk in" ||
    manualName.toLowerCase() === "walkin" ||
    manualName.toLowerCase() === "walk-in customer";

  if (isWalkIn) {
    return null;
  }

  const phone = body.customer_phone || body.customerPhone || null;
  const [newCust] = await conn.query(
    "INSERT INTO customers (name, phone, created_by) VALUES (?, ?, ?)",
    [manualName, phone, userId]
  );
  return newCust.insertId;
};

// POST /api/khata/debit
// Creates a normal Debit entry in Khata (Requirement 1: Normal Debit only, NO Sale of Product, NO stock deduction)
const addKhataDebit = asyncHandler(async (req, res) => {
  const {
    amount,
    customer_id,
    customer_name,
    customer_phone,
    description,
    date,
    entry_date,
  } = req.body;

  const finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
  if (finalAmount <= 0) {
    throw new ApiError(400, "A valid positive debit amount is required.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const linkedCustomerId = await resolveKhataCustomer(conn, req.body, req.user.id);

    const finalDate = entry_date || date || new Date().toISOString().split("T")[0];
    const resolvedDescription = description && String(description).trim() ? String(description).trim() : "Debit Entry";

    // Normal Debit strictly creates entry without product_id and without altering stock
    const [result] = await conn.query(
      `INSERT INTO khata_entries
        (type, customer_id, amount, description, entry_date, product_id, quantity, unit_price, is_linked_to_payment, is_skipped, created_by)
       VALUES ('debit', ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?)`,
      [
        linkedCustomerId,
        finalAmount,
        resolvedDescription,
        finalDate,
        req.user.id,
      ]
    );

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone
       FROM khata_entries ke
       LEFT JOIN customers cu ON cu.id = ke.customer_id
       WHERE ke.id = ? AND ke.created_by = ?`,
      [result.insertId, req.user.id]
    );

    const savedEntry = {
      ...rows[0],
      type: "debit",
      category: "debit",
      is_debit: true,
      is_credit: false,
      is_due: false,
      signed_amount: -Number(rows[0].amount || 0),
    };

    res.status(201).json({
      success: true,
      message: "Khata debit entry created successfully.",
      type: "debit",
      entry: savedEntry,
      debit: savedEntry,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/khata/credit
// Creates a Credit entry in Khata (Requirement 2: Sale of Product on Credit with FOR UPDATE lock & instant stock deduction)
const addKhataCredit = asyncHandler(async (req, res) => {
  const {
    amount,
    customer_id,
    customer_name,
    customer_phone,
    description,
    date,
    entry_date,
    product_id,
    quantity,
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
    let linkedProductId = null;
    let linkedQuantity = null;
    let linkedUnitPrice = null;
    let resolvedDescription = description ? String(description).trim() : null;

    // 2. KHATA — SALE OF PRODUCT ON CREDIT
    if (product_id) {
      const [stockRows] = await conn.query(
        "SELECT id, product_name, price, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
        [product_id, req.user.id]
      );

      if (!stockRows.length) {
        throw new ApiError(404, "Product not found in inventory.");
      }

      const stockItem = stockRows[0];
      const reqQty = Number(quantity) > 0 ? Number(quantity) : 1;
      const availableStock = Number(stockItem.quantity || 0);

      if (reqQty > availableStock) {
        throw new ApiError(
          400,
          `Insufficient stock for "${stockItem.product_name}". Available stock: ${availableStock}.`
        );
      }

      // Authoritative Selling Price from Product Master (stock.price)
      const sellingPrice = Number(stockItem.price || 0);
      finalAmount = sellingPrice * reqQty;
      linkedProductId = stockItem.id;
      linkedQuantity = reqQty;
      linkedUnitPrice = sellingPrice;

      if (!resolvedDescription) {
        resolvedDescription = `Sale of ${stockItem.product_name} (${reqQty} pcs)`;
      }

      // Deduct inventory quantity immediately inside the transaction
      await conn.query(
        "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
        [reqQty, stockItem.id, req.user.id]
      );
    }

    if (finalAmount <= 0) {
      throw new ApiError(400, "A valid positive credit amount or product selection is required.");
    }

    const linkedCustomerId = await resolveKhataCustomer(conn, req.body, req.user.id);

    const finalDate = entry_date || date || new Date().toISOString().split("T")[0];

    // Insert Credit into khata_entries
    const [result] = await conn.query(
      `INSERT INTO khata_entries
        (type, customer_id, amount, description, entry_date, product_id, quantity, unit_price, is_linked_to_payment, is_skipped, created_by)
       VALUES ('credit', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        linkedCustomerId,
        finalAmount,
        resolvedDescription || "Credit Entry",
        finalDate,
        linkedProductId,
        linkedQuantity,
        linkedUnitPrice,
        req.user.id,
      ]
    );

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
       FROM khata_entries ke
       LEFT JOIN customers cu ON cu.id = ke.customer_id
       LEFT JOIN stock s ON s.id = ke.product_id
       WHERE ke.id = ? AND ke.created_by = ?`,
      [result.insertId, req.user.id]
    );

    const savedEntry = {
      ...rows[0],
      type: "credit",
      category: "credit",
      is_credit: true,
      is_debit: false,
      is_due: false,
      signed_amount: Number(rows[0].amount || 0),
    };

    res.status(201).json({
      success: true,
      message: "Khata credit entry created successfully.",
      type: "credit",
      entry: savedEntry,
      credit: savedEntry,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/khata/due
// Creates a Due entry in Khata (Requirement 3: Sale of Product for Due with stock validation, FOR UPDATE lock & deduction)
const addKhataDue = asyncHandler(async (req, res) => {
  const {
    customer_id,
    customer_name,
    customer_phone,
    amount,
    description,
    item_name,
    due_date,
    date,
    product_id,
    quantity,
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
    let linkedProductId = null;
    let linkedQuantity = null;
    let linkedUnitPrice = null;
    let finalDescription = (description || item_name || "").trim();

    // 3. KHATA — SALE OF PRODUCT FOR DUE
    if (product_id) {
      const [stockRows] = await conn.query(
        "SELECT id, product_name, price, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
        [product_id, req.user.id]
      );

      if (!stockRows.length) {
        throw new ApiError(404, "Product not found in inventory.");
      }

      const stockItem = stockRows[0];
      const reqQty = Number(quantity) > 0 ? Number(quantity) : 1;
      const availableStock = Number(stockItem.quantity || 0);

      if (reqQty > availableStock) {
        throw new ApiError(
          400,
          `Insufficient stock for "${stockItem.product_name}". Available stock: ${availableStock}.`
        );
      }

      const sellingPrice = Number(stockItem.price || 0);
      finalAmount = sellingPrice * reqQty;
      linkedProductId = stockItem.id;
      linkedQuantity = reqQty;
      linkedUnitPrice = sellingPrice;

      if (!finalDescription) {
        finalDescription = `Due Sale of ${stockItem.product_name} (${reqQty} pcs)`;
      }

      // Deduct inventory quantity immediately inside transaction
      await conn.query(
        "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
        [reqQty, stockItem.id, req.user.id]
      );
    }

    if (finalAmount <= 0) {
      throw new ApiError(400, "A positive due amount or product selection is required.");
    }

    if (!finalDescription) {
      finalDescription = "Outstanding Due";
    }

    let linkedCustomerId = null;
    if (customer_id) {
      const [custRows] = await conn.query(
        "SELECT id FROM customers WHERE id = ? AND created_by = ?",
        [customer_id, req.user.id]
      );
      if (custRows.length) {
        linkedCustomerId = customer_id;
      }
    } else if (customer_name && String(customer_name).trim()) {
      const [createCustResult] = await conn.query(
        "INSERT INTO customers (name, phone, created_by) VALUES (?, ?, ?)",
        [String(customer_name).trim(), customer_phone || null, req.user.id]
      );
      linkedCustomerId = createCustResult.insertId;
    }

    if (!linkedCustomerId) {
      throw new ApiError(
        400,
        "customer_id or customer_name is required to create a due."
      );
    }

    const finalDueDate = due_date || date || null;

    const [result] = await conn.query(
      `INSERT INTO customer_dues
        (customer_id, description, amount, remaining_amount, due_date, status, product_id, quantity, unit_price, created_by)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        linkedCustomerId,
        finalDescription,
        finalAmount,
        finalAmount,
        finalDueDate,
        linkedProductId,
        linkedQuantity,
        linkedUnitPrice,
        req.user.id,
      ]
    );

    await conn.query(
      "UPDATE customers SET total_due = total_due + ? WHERE id = ? AND created_by = ?",
      [finalAmount, linkedCustomerId, req.user.id]
    );

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT cd.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
       FROM customer_dues cd
       LEFT JOIN customers cu ON cu.id = cd.customer_id
       LEFT JOIN stock s ON s.id = cd.product_id
       WHERE cd.id = ? AND cd.created_by = ?`,
      [result.insertId, req.user.id]
    );

    const savedEntry = {
      ...rows[0],
      type: "due",
      category: "due",
      is_due: true,
      is_debit: false,
      is_credit: false,
      signed_amount: Number(rows[0].amount || 0),
    };

    res.status(201).json({
      success: true,
      message: "Khata due entry created successfully.",
      type: "due",
      due: savedEntry,
      entry: savedEntry,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/khata (Unified dispatcher to handle debit, credit, and due)
const addKhataEntry = asyncHandler(async (req, res, next) => {
  const rawType = String(req.body.type || "").trim().toLowerCase();

  if (rawType === "due") {
    return addKhataDue(req, res, next);
  }

  if (rawType === "credit") {
    return addKhataCredit(req, res, next);
  }

  // Default is Debit entry
  return addKhataDebit(req, res, next);
});

// GET /api/khata/dues
const getKhataDues = asyncHandler(async (req, res) => {
  const { customer_id, status } = req.query;

  let sql = `
    SELECT cd.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
    FROM customer_dues cd
    LEFT JOIN customers cu ON cu.id = cd.customer_id
    LEFT JOIN stock s ON s.id = cd.product_id
    WHERE cd.created_by = ?
  `;
  const params = [req.user.id];

  if (customer_id) {
    sql += " AND cd.customer_id = ?";
    params.push(customer_id);
  }

  if (status) {
    sql += " AND cd.status = ?";
    params.push(status);
  }

  sql += " ORDER BY cd.created_at DESC, cd.id DESC";

  const [rows] = await pool.query(sql, params);

  res.json({
    success: true,
    count: rows.length,
    dues: rows,
  });
});

// GET /api/khata/unlinked-debits
// Lists Khata debit entries available to add to Payments
const getUnlinkedKhataDebits = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ke.*,
            cu.name AS customer_name,
            cu.phone AS customer_phone,
            s.product_name
     FROM khata_entries ke
     LEFT JOIN customers cu ON cu.id = ke.customer_id
     LEFT JOIN stock s ON s.id = ke.product_id
     WHERE ke.created_by = ?
       AND ke.type = 'debit'
       AND ke.is_linked_to_payment = 0
       AND ke.is_skipped = 0
     ORDER BY ke.entry_date DESC, ke.id DESC`,
    [req.user.id]
  );

  res.json({
    success: true,
    count: rows.length,
    debits: rows,
  });
});

// POST /api/khata/:id/link-payment
// Explicitly links a selected Khata debit to a Payment and marks it as linked
const linkKhataDebitToPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { payment_mode } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT ke.*, cu.name AS customer_name
       FROM khata_entries ke
       LEFT JOIN customers cu ON cu.id = ke.customer_id
       WHERE ke.id = ? AND ke.created_by = ? FOR UPDATE`,
      [id, req.user.id]
    );

    if (!rows.length) {
      await conn.rollback();
      throw new ApiError(404, "Khata debit entry not found.");
    }

    const debit = rows[0];

    if (debit.is_linked_to_payment === 1 || debit.payment_id) {
      await conn.rollback();
      throw new ApiError(400, "This Khata debit entry is already linked to a payment.");
    }

    // Create payment representing this expense
    const [payResult] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, product_id, quantity, unit_price,
         khata_entry_id, add_to_khata, created_by)
       VALUES ('paid_by_business', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        debit.customer_name || null,
        debit.customer_id || null,
        debit.description || "Paid Out (from Khata)",
        debit.amount,
        (!payment_mode || String(payment_mode).trim().toLowerCase() === "cash") ? "cash" : "online",
        debit.entry_date,
        debit.product_id || null,
        debit.quantity || null,
        debit.unit_price || null,
        debit.id,
        req.user.id,
      ]
    );

    const paymentId = payResult.insertId;

    // Mark Khata debit as linked
    await conn.query(
      "UPDATE khata_entries SET is_linked_to_payment = 1, payment_id = ? WHERE id = ? AND created_by = ?",
      [paymentId, debit.id, req.user.id]
    );

    await conn.commit();

    const [paymentRows] = await pool.query(
      "SELECT * FROM payments WHERE id = ? AND created_by = ?",
      [paymentId, req.user.id]
    );

    res.status(201).json({
      success: true,
      message: "Khata debit entry successfully linked to Payment.",
      payment: paymentRows[0],
      khata_entry_id: debit.id,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/khata/:id/skip
const skipKhataDebit = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query(
    "UPDATE khata_entries SET is_skipped = 1 WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );
  if (!result.affectedRows) {
    throw new ApiError(404, "Khata entry not found.");
  }
  res.json({ success: true, message: "Khata entry skipped." });
});

// PATCH /api/khata/:id/unskip
const unskipKhataDebit = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query(
    "UPDATE khata_entries SET is_skipped = 0 WHERE id = ? AND created_by = ?",
    [id, req.user.id]
  );
  if (!result.affectedRows) {
    throw new ApiError(404, "Khata entry not found.");
  }
  res.json({ success: true, message: "Khata entry unskipped." });
});

module.exports = {
  getKhata,
  getKhataDashboard,
  addKhataEntry,
  addKhataDebit,
  addKhataCredit,
  addKhataDue,
  getKhataDues,
  getUnlinkedKhataDebits,
  linkKhataDebitToPayment,
  skipKhataDebit,
  unskipKhataDebit,
};
