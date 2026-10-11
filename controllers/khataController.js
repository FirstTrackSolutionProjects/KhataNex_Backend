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
  let { customer_id, from, to, start_date, startDate, end_date, endDate, type, period, timeframe, range } = req.query;

  from = from || start_date || startDate;
  to = to || end_date || endDate;

  const resolvedPeriod = period || timeframe || range;
  if (resolvedPeriod && (!from || !to)) {
    const boundaries = getDateBoundaries(resolvedPeriod);
    if (boundaries.from && !from) from = boundaries.from;
    if (boundaries.to && !to) to = boundaries.to;
  }

  // 1. Credit entries (Sales from collections)
  let salesSql = `
    SELECT c.id, c.amount, c.sale_date AS date,
           TIME(c.created_at) AS time,
           c.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           COALESCE(cu.name, 'Walk-in') AS party_name,
           COALESCE(cu.name, 'Walk-in') AS customer_name,
           CONCAT('Sale', IF(c.item_name IS NOT NULL, CONCAT(' - ', c.item_name), '')) AS description,
           'credit' AS type,
           c.payment_type AS payment_mode,
           c.payment_type,
           c.customer_id,
           c.item_name AS product_name,
           NULL AS product_id,
           NULL AS quantity,
           NULL AS unit_price,
           NULL AS items,
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
    SELECT ke.id, ke.amount, ke.entry_date AS date,
           COALESCE(ke.entry_time, TIME(ke.created_at)) AS time,
           ke.created_at,
           COALESCE(cu.name, 'Walk-in') AS name,
           COALESCE(cu.name, 'Walk-in') AS party_name,
           COALESCE(cu.name, 'Walk-in') AS customer_name,
           ke.description,
           ke.type,
           COALESCE(ke.payment_mode, 'cash') AS payment_mode,
           COALESCE(ke.payment_mode, 'cash') AS payment_type,
           ke.customer_id,
           s.product_name,
           ke.product_id,
           ke.quantity,
           ke.unit_price,
           ke.items,
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
           COALESCE(cd.due_time, TIME(cd.created_at)) AS time,
           cd.created_at,
           COALESCE(cu.name, 'Customer') AS name,
           COALESCE(cu.name, 'Customer') AS party_name,
           COALESCE(cu.name, 'Customer') AS customer_name,
           cd.description,
           'due' AS type,
           COALESCE(cd.payment_mode, 'credit') AS payment_mode,
           cd.status,
           cd.customer_id,
           s.product_name,
           cd.product_id,
           cd.quantity,
           cd.unit_price,
           cd.items,
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

  const parseItems = (rawItems, row) => {
    let list = [];
    if (rawItems) {
      try {
        list = typeof rawItems === "string" ? JSON.parse(rawItems) : rawItems;
      } catch (_) {
        list = [];
      }
    }
    if (!Array.isArray(list) || list.length === 0) {
      if (row.product_name || row.product_id) {
        list = [
          {
            product_id: row.product_id || null,
            product_name: row.product_name || "Product",
            quantity: Number(row.quantity || 1),
            unit_price: Number(row.unit_price || row.amount || 0),
            amount: Number(row.amount || 0),
          },
        ];
      }
    }
    return list;
  };

  // Normalize entries so that type is explicitly and unambiguously identified
  const normalizedSales = sales.map((row) => ({
    ...row,
    time: row.time ? String(row.time).slice(0, 8) : "00:00:00",
    payment_mode: row.payment_mode === "cash" ? "cash" : "upi",
    items: parseItems(row.items, row),
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
    const rawMode = row.payment_mode ? String(row.payment_mode).trim().toLowerCase() : "cash";
    const mode = rawMode === "upi" ? "upi" : "cash";
    return {
      ...row,
      time: row.time ? String(row.time).slice(0, 8) : "00:00:00",
      payment_mode: mode,
      items: parseItems(row.items, row),
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
    time: row.time ? String(row.time).slice(0, 8) : "00:00:00",
    payment_mode: row.payment_mode || "credit",
    items: parseItems(row.items, row),
    type: "due",
    category: "due",
    is_due: true,
    is_debit: false,
    is_credit: false,
    signed_amount: Number(row.amount || 0),
  }));

  let entries = [...normalizedSales, ...normalizedKhata, ...normalizedDues];

  // Optional search filter across customer, product, description
  const searchKeyword = String(req.query.search || req.query.query || req.query.q || "").trim().toLowerCase();
  if (searchKeyword) {
    entries = entries.filter((e) =>
      String(e.name || "").toLowerCase().includes(searchKeyword) ||
      String(e.party_name || "").toLowerCase().includes(searchKeyword) ||
      String(e.description || "").toLowerCase().includes(searchKeyword) ||
      String(e.product_name || "").toLowerCase().includes(searchKeyword) ||
      (Array.isArray(e.items) && e.items.some((it) => String(it.product_name || "").toLowerCase().includes(searchKeyword)))
    );
  }

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

  entries.sort((a, b) => {
    const dateA = String(a.date || "").slice(0, 10);
    const dateB = String(b.date || "").slice(0, 10);
    const timeA = a.time || "00:00:00";
    const timeB = b.time || "00:00:00";
    const tsA = new Date(`${dateA}T${timeA}`).getTime();
    const tsB = new Date(`${dateB}T${timeB}`).getTime();
    if (!isNaN(tsA) && !isNaN(tsB) && tsB !== tsA) {
      return tsB - tsA;
    }
    const createdA = new Date(a.created_at).getTime();
    const createdB = new Date(b.created_at).getTime();
    if (createdB !== createdA) return createdB - createdA;
    return Number(b.id || 0) - Number(a.id || 0);
  });

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

  const customFrom = req.query.from || req.query.start_date || req.query.startDate;
  const customTo = req.query.to || req.query.end_date || req.query.endDate;
  const customTotals = (customFrom || customTo)
    ? await calculateForRange(customFrom, customTo)
    : null;

  const activeSummary = customTotals || monthTotals;

  res.json({
    success: true,
    today: todayTotals,
    this_week: weekTotals,
    this_month: monthTotals,
    this_year: yearTotals,
    all_time: allTotals,
    custom: customTotals,
    range: (customFrom || customTo) ? { from: customFrom || null, to: customTo || null } : undefined,
    summary: activeSummary,
    total_credit: activeSummary.total_credit,
    total_debit: activeSummary.total_debit,
    total_due: activeSummary.total_due,
    net_balance: activeSummary.net_balance,
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

  // Check if a customer already exists with this name (case-insensitive) for this user
  const [existingByName] = await conn.query(
    "SELECT id FROM customers WHERE LOWER(name) = LOWER(?) AND created_by = ? LIMIT 1",
    [manualName, userId]
  );
  if (existingByName.length) {
    return existingByName[0].id;
  }

  const phone = body.customer_phone || body.customerPhone || null;
  const [newCust] = await conn.query(
    "INSERT INTO customers (name, phone, created_by) VALUES (?, ?, ?)",
    [manualName, phone, userId]
  );
  return newCust.insertId;
};

/**
 * Helper to resolve product from Product Master (stock) for Credit & Due entries.
 * Supports single autocomplete textbox: resolves by numeric ID, object { id, product_name },
 * or product name string (case-insensitive).
 */
const resolveKhataProduct = async (conn, itemOrBody, userId) => {
  if (!itemOrBody) return null;

  let pId =
    (itemOrBody.product_id && typeof itemOrBody.product_id === "object" ? itemOrBody.product_id.id : null) ??
    itemOrBody.product_id ??
    itemOrBody.productId ??
    (itemOrBody.product && typeof itemOrBody.product === "object" ? itemOrBody.product.id : null) ??
    (typeof itemOrBody.product === "number" ||
    (typeof itemOrBody.product === "string" && /^\d+$/.test(String(itemOrBody.product).trim()))
      ? Number(itemOrBody.product)
      : null) ??
    itemOrBody.id;

  if (pId && Number(pId) > 0) {
    const [rows] = await conn.query(
      "SELECT id, product_name, price, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
      [pId, userId]
    );
    if (rows.length) return rows[0];
  }

  const name =
    itemOrBody.product_name ||
    itemOrBody.productName ||
    itemOrBody.item_name ||
    itemOrBody.name ||
    (typeof itemOrBody.product === "string" ? itemOrBody.product : null);

  if (name && String(name).trim()) {
    const trimmed = String(name).trim();
    const [rows] = await conn.query(
      "SELECT id, product_name, price, quantity FROM stock WHERE LOWER(product_name) = LOWER(?) AND created_by = ? LIMIT 1 FOR UPDATE",
      [trimmed, userId]
    );
    if (rows.length) return rows[0];
  }

  return null;
};

// POST /api/khata/debit
// Creates a normal Debit entry in Khata (Normal Debit only, NO Sale of Product, NO stock deduction)
// Auto-creates a Paid Out payment (Khata ↔ Payments synchronization)
const addKhataDebit = asyncHandler(async (req, res) => {
  const {
    amount,
    customer_id,
    customer_name,
    customer_phone,
    description,
    date,
    entry_date,
    entry_time,
    time,
    payment_mode,
  } = req.body;

  const finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
  if (finalAmount <= 0) {
    throw new ApiError(400, "A valid positive debit amount is required.");
  }

  const rawManualParty =
    customer_name ||
    req.body.party_name ||
    req.body.partyName ||
    req.body.customerName ||
    (typeof req.body.customer === "string" ? req.body.customer : null);
  const rawCustomerId =
    (customer_id && typeof customer_id === "object" ? customer_id.id : null) ??
    customer_id ??
    (req.body.customerId && typeof req.body.customerId === "object" ? req.body.customerId.id : null) ??
    req.body.customerId;

  if (!rawCustomerId && (!rawManualParty || !String(rawManualParty).trim())) {
    throw new ApiError(400, "Customer / Party name is required for a debit entry.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const linkedCustomerId = await resolveKhataCustomer(conn, req.body, req.user.id);
    if (!linkedCustomerId && (!rawManualParty || !String(rawManualParty).trim() || String(rawManualParty).trim().toLowerCase() === "walk-in")) {
      throw new ApiError(400, "Customer / Party name is required for a debit entry.");
    }

    const rawDate = entry_date || date || new Date().toISOString().split("T")[0];
    const finalDate = String(rawDate).slice(0, 10);
    const rawTime = entry_time || time || new Date().toTimeString().split(" ")[0];
    const finalTime = String(rawTime).slice(0, 8);
    const resolvedDescription = description && String(description).trim() ? String(description).trim() : "Debit Entry";

    // payment_mode must support ONLY cash and upi for debit. Remove/ignore online.
    const rawMode = payment_mode ? String(payment_mode).trim().toLowerCase() : "cash";
    const mode = rawMode === "upi" ? "upi" : "cash";
    const paymentModeEnum = mode === "cash" ? "cash" : "online";

    // Normal Debit strictly creates entry without product_id and without altering stock
    const [result] = await conn.query(
      `INSERT INTO khata_entries
        (type, customer_id, amount, description, entry_date, entry_time, payment_mode, product_id, quantity, unit_price, is_linked_to_payment, is_skipped, created_by)
       VALUES ('debit', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 0, ?)`,
      [
        linkedCustomerId,
        finalAmount,
        resolvedDescription,
        finalDate,
        finalTime,
        mode,
        req.user.id,
      ]
    );

    const khataId = result.insertId;

    let customerName = null;
    if (linkedCustomerId) {
      const [cRows] = await conn.query("SELECT name FROM customers WHERE id = ?", [linkedCustomerId]);
      if (cRows.length) customerName = cRows[0].name;
    }

    const [payResult] = await conn.query(
      `INSERT INTO payments
        (payment_category, party_name, customer_id, purpose, amount,
         payment_mode, payment_date, khata_entry_id, add_to_khata, created_by)
       VALUES ('paid_out', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        customerName || (customer_name && String(customer_name).trim()) || null,
        linkedCustomerId,
        resolvedDescription,
        finalAmount,
        paymentModeEnum,
        finalDate,
        khataId,
        req.user.id,
      ]
    );

    const paymentId = payResult.insertId;

    await conn.query(
      "UPDATE khata_entries SET payment_id = ? WHERE id = ?",
      [paymentId, khataId]
    );

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone
       FROM khata_entries ke
       LEFT JOIN customers cu ON cu.id = ke.customer_id
       WHERE ke.id = ? AND ke.created_by = ?`,
      [khataId, req.user.id]
    );

    const savedEntry = {
      ...rows[0],
      time: rows[0].entry_time ? String(rows[0].entry_time).slice(0, 8) : finalTime.slice(0, 8),
      payment_mode: mode,
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
// Creates a Credit entry in Khata (Sale of Product on Credit with multiple items, FOR UPDATE lock & instant stock deduction)
// Auto-creates Money Received payment for Credit Product Sale (Khata ↔ Payments synchronization)
const addKhataCredit = asyncHandler(async (req, res) => {
  const {
    amount,
    customer_id,
    customer_name,
    customer_phone,
    description,
    date,
    entry_date,
    entry_time,
    time,
    product_id,
    quantity,
    items,
    payment_mode,
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
    let linkedProductId = null;
    let linkedQuantity = null;
    let linkedUnitPrice = null;
    let resolvedDescription = description ? String(description).trim() : null;

    // Normalize multiple items payload or single item, supporting single autocomplete textbox (product, product_id, product_name)
    let rawItems = [];
    if (Array.isArray(items) && items.length > 0) {
      rawItems = items;
    } else if (product_id || req.body.product || req.body.product_name || req.body.item_name) {
      rawItems = [{
        product_id: product_id || req.body.product_id,
        product: req.body.product,
        product_name: req.body.product_name || req.body.item_name,
        quantity: quantity || req.body.quantity || 1,
        unit_price: req.body.unit_price,
      }];
    }

    const processedItems = [];
    let itemsTotal = 0;

    // Process items stock validation and deduction
    for (const it of rawItems) {
      const stockItem = await resolveKhataProduct(conn, it, req.user.id);
      if (!stockItem) {
        if (it.product_id || it.product) {
          throw new ApiError(404, "Product not found in inventory.");
        }
        continue;
      }

      const reqQty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
      const availableStock = Number(stockItem.quantity || 0);

      if (reqQty > availableStock) {
        throw new ApiError(
          400,
          `Insufficient stock for "${stockItem.product_name}". Available: ${availableStock}, requested: ${reqQty}.`
        );
      }

      // Authoritative Selling Price from Product Master (stock.price)
      const sellingPrice = Number(stockItem.price || 0);
      const lineTotal = sellingPrice * reqQty;
      itemsTotal += lineTotal;

      // Deduct inventory quantity immediately inside transaction
      await conn.query(
        "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
        [reqQty, stockItem.id, req.user.id]
      );

      processedItems.push({
        product_id: stockItem.id,
        product_name: stockItem.product_name,
        quantity: reqQty,
        unit_price: sellingPrice,
        amount: lineTotal,
      });
    }

    if (processedItems.length > 0) {
      finalAmount = itemsTotal;
      linkedProductId = processedItems[0].product_id;
      linkedQuantity = processedItems[0].quantity;
      linkedUnitPrice = processedItems[0].unit_price;
      if (!resolvedDescription) {
        resolvedDescription = `Sale of ${processedItems.map((p) => `${p.product_name} (${p.quantity} pcs)`).join(", ")}`;
      }
    }

    if (finalAmount <= 0) {
      throw new ApiError(400, "A valid positive credit amount or product selection is required.");
    }

    // Credit sale without customer_id is allowed → treat as Walk-in
    const linkedCustomerId = await resolveKhataCustomer(conn, req.body, req.user.id);

    const rawDate = entry_date || date || new Date().toISOString().split("T")[0];
    const finalDate = String(rawDate).slice(0, 10);
    const rawTime = entry_time || time || new Date().toTimeString().split(" ")[0];
    const finalTime = String(rawTime).slice(0, 8);

    // payment_mode must support ONLY cash and upi for credit. Remove/ignore online.
    const rawMode = payment_mode ? String(payment_mode).trim().toLowerCase() : "cash";
    const mode = rawMode === "upi" ? "upi" : "cash";
    const paymentModeEnum = mode === "cash" ? "cash" : "online";
    const itemsJson = processedItems.length > 0 ? JSON.stringify(processedItems) : null;

    // Insert Credit into khata_entries
    const [result] = await conn.query(
      `INSERT INTO khata_entries
        (type, customer_id, amount, description, entry_date, entry_time, payment_mode, product_id, quantity, unit_price, items, is_linked_to_payment, is_skipped, created_by)
       VALUES ('credit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        linkedCustomerId,
        finalAmount,
        resolvedDescription || "Credit Entry",
        finalDate,
        finalTime,
        mode,
        linkedProductId,
        linkedQuantity,
        linkedUnitPrice,
        itemsJson,
        processedItems.length > 0 ? 1 : 0,
        req.user.id,
      ]
    );

    const khataId = result.insertId;

    // Credit Sale of Product auto-creates Money Received payment
    if (processedItems.length > 0) {
      let customerName = null;
      if (linkedCustomerId) {
        const [cRows] = await conn.query("SELECT name FROM customers WHERE id = ?", [linkedCustomerId]);
        if (cRows.length) customerName = cRows[0].name;
      }

      const [payResult] = await conn.query(
        `INSERT INTO payments
          (payment_category, party_name, customer_id, purpose, amount,
           payment_mode, payment_date, product_id, quantity, unit_price,
           khata_entry_id, add_to_khata, created_by)
         VALUES ('money_received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          customerName || (customer_name && String(customer_name).trim()) || "Walk-in",
          linkedCustomerId,
          resolvedDescription || "Money Received",
          finalAmount,
          paymentModeEnum,
          finalDate,
          linkedProductId,
          linkedQuantity,
          linkedUnitPrice,
          khataId,
          req.user.id,
        ]
      );

      const paymentId = payResult.insertId;

      await conn.query(
        "UPDATE khata_entries SET payment_id = ? WHERE id = ?",
        [paymentId, khataId]
      );
    }

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
       FROM khata_entries ke
       LEFT JOIN customers cu ON cu.id = ke.customer_id
       LEFT JOIN stock s ON s.id = ke.product_id
       WHERE ke.id = ? AND ke.created_by = ?`,
      [khataId, req.user.id]
    );

    const savedEntry = {
      ...rows[0],
      time: rows[0].entry_time ? String(rows[0].entry_time).slice(0, 8) : finalTime.slice(0, 8),
      payment_mode: mode,
      items: processedItems,
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
// Creates a Due entry in Khata (Due sale MUST require a customer_id; supports multiple items & stock deduction)
const addKhataDue = asyncHandler(async (req, res) => {
  const {
    customer_id,
    amount,
    description,
    item_name,
    due_date,
    date,
    entry_time,
    due_time,
    time,
    product_id,
    quantity,
    items,
    payment_mode,
  } = req.body;

  // Due sale MUST require a customer_id. No manual customer-name-only due.
  const rawCustomerId =
    (customer_id && typeof customer_id === "object" ? customer_id.id : null) ??
    customer_id ??
    (req.body.customerId && typeof req.body.customerId === "object" ? req.body.customerId.id : null) ??
    req.body.customerId;

  if (!rawCustomerId) {
    throw new ApiError(
      400,
      "customer_id is required to create a due sale. Manual customer names cannot create dues."
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [custRows] = await conn.query(
      "SELECT id, name FROM customers WHERE id = ? AND created_by = ?",
      [rawCustomerId, req.user.id]
    );
    if (!custRows.length) {
      throw new ApiError(404, "Selected customer not found.");
    }
    const linkedCustomerId = custRows[0].id;

    let finalAmount = amount && Number(amount) > 0 ? Number(amount) : 0;
    let linkedProductId = null;
    let linkedQuantity = null;
    let linkedUnitPrice = null;
    let finalDescription = (description || item_name || "").trim();

    // Support multiple items or single product, supporting single autocomplete textbox (product, product_id, product_name)
    let rawItems = [];
    if (Array.isArray(items) && items.length > 0) {
      rawItems = items;
    } else if (product_id || req.body.product || req.body.product_name || req.body.item_name) {
      rawItems = [{
        product_id: product_id || req.body.product_id,
        product: req.body.product,
        product_name: req.body.product_name || req.body.item_name,
        quantity: quantity || req.body.quantity || 1,
        unit_price: req.body.unit_price,
      }];
    }

    const processedItems = [];
    let itemsTotal = 0;

    for (const it of rawItems) {
      const stockItem = await resolveKhataProduct(conn, it, req.user.id);
      if (!stockItem) {
        if (it.product_id || it.product) {
          throw new ApiError(404, "Product not found in inventory.");
        }
        continue;
      }

      const reqQty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
      const availableStock = Number(stockItem.quantity || 0);

      if (reqQty > availableStock) {
        throw new ApiError(
          400,
          `Insufficient stock for "${stockItem.product_name}". Available: ${availableStock}, requested: ${reqQty}.`
        );
      }

      const sellingPrice = Number(stockItem.price || 0);
      const lineTotal = sellingPrice * reqQty;
      itemsTotal += lineTotal;

      // Deduct inventory quantity immediately inside transaction
      await conn.query(
        "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
        [reqQty, stockItem.id, req.user.id]
      );

      processedItems.push({
        product_id: stockItem.id,
        product_name: stockItem.product_name,
        quantity: reqQty,
        unit_price: sellingPrice,
        amount: lineTotal,
      });
    }

    if (processedItems.length > 0) {
      finalAmount = itemsTotal;
      linkedProductId = processedItems[0].product_id;
      linkedQuantity = processedItems[0].quantity;
      linkedUnitPrice = processedItems[0].unit_price;
      if (!finalDescription) {
        finalDescription = `Due Sale of ${processedItems.map((p) => `${p.product_name} (${p.quantity} pcs)`).join(", ")}`;
      }
    }

    if (finalAmount <= 0) {
      throw new ApiError(400, "A positive due amount or product selection is required.");
    }

    if (!finalDescription) {
      finalDescription = "Outstanding Due";
    }

    const rawDate = due_date || date || null;
    const finalDueDate = rawDate ? String(rawDate).slice(0, 10) : null;
    const rawTime = due_time || entry_time || time || new Date().toTimeString().split(" ")[0];
    const finalTime = String(rawTime).slice(0, 8);

    // payment_mode must support ONLY cash and upi. Remove/ignore online. Default is 'credit'.
    const rawMode = payment_mode ? String(payment_mode).trim().toLowerCase() : "credit";
    const mode = (rawMode === "upi" || rawMode === "cash") ? rawMode : "credit";
    const itemsJson = processedItems.length > 0 ? JSON.stringify(processedItems) : null;

    const [result] = await conn.query(
      `INSERT INTO customer_dues
        (customer_id, description, amount, remaining_amount, due_date, due_time, payment_mode, status, product_id, quantity, unit_price, items, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        linkedCustomerId,
        finalDescription,
        finalAmount,
        finalAmount,
        finalDueDate,
        finalTime,
        mode,
        linkedProductId,
        linkedQuantity,
        linkedUnitPrice,
        itemsJson,
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
      time: rows[0].due_time ? String(rows[0].due_time).slice(0, 8) : finalTime.slice(0, 8),
      payment_mode: mode,
      items: processedItems,
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

// PUT /api/khata/:id and PATCH /api/khata/:id
// Edits a Khata entry (khata_entries or customer_dues) with stock restoration and linked payment sync
const updateKhataEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
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
    payment_mode,
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Helper to restore items stock
    const restoreItemsStock = async (rawItems, fallbackProdId, fallbackQty) => {
      let itemsList = [];
      if (rawItems) {
        try {
          itemsList = typeof rawItems === "string" ? JSON.parse(rawItems) : rawItems;
        } catch (_) {
          itemsList = [];
        }
      }
      if (Array.isArray(itemsList) && itemsList.length > 0) {
        for (const it of itemsList) {
          const pId = it.product_id || it.id;
          const q = Number(it.quantity || 0);
          if (pId && q > 0) {
            await conn.query(
              "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
              [q, pId, req.user.id]
            );
          }
        }
      } else if (fallbackProdId && Number(fallbackQty || 0) > 0) {
        await conn.query(
          "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
          [Number(fallbackQty), fallbackProdId, req.user.id]
        );
      }
    };

    // 1. Check khata_entries
    const [keRows] = await conn.query(
      "SELECT * FROM khata_entries WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, req.user.id]
    );

    if (keRows.length) {
      const entry = keRows[0];
      const isDebit = entry.type === "debit";
      let finalAmount = amount !== undefined && Number(amount) > 0 ? Number(amount) : Number(entry.amount);
      let linkedProductId = entry.product_id;
      let linkedQuantity = entry.quantity;
      let linkedUnitPrice = entry.unit_price;
      const rawDate = entry_date || date || entry.entry_date;
      const finalDate = rawDate ? String(rawDate).slice(0, 10) : new Date().toISOString().split("T")[0];
      const rawTime = req.body.entry_time || req.body.time || entry.entry_time || "00:00:00";
      const finalTime = String(rawTime).slice(0, 8);
      const finalDesc = description !== undefined ? description : entry.description;

      // payment_mode must support ONLY cash and upi.
      const rawMode = payment_mode ? String(payment_mode).trim().toLowerCase() : (entry.payment_mode || "cash");
      const mode = rawMode === "upi" ? "upi" : "cash";
      const paymentModeEnum = mode === "cash" ? "cash" : "online";

      let resolvedCustId = entry.customer_id;
      if (customer_id !== undefined || customer_name !== undefined) {
        resolvedCustId = await resolveKhataCustomer(conn, req.body, req.user.id);
      }

      let updatedItemsJson = entry.items;

      // Stock adjustments for credit entries
      if (!isDebit) {
        // Restore stock from old items or product
        await restoreItemsStock(entry.items, entry.product_id, entry.quantity);

        const rawItems = Array.isArray(req.body.items) && req.body.items.length > 0
          ? req.body.items
          : (product_id !== undefined
              ? (product_id ? [{ product_id, quantity: req.body.quantity || 1 }] : [])
              : null);

        if (rawItems !== null && rawItems.length > 0) {
          let itemsTotal = 0;
          const processedItems = [];
          for (const it of rawItems) {
            const pId = it.product_id || it.id;
            if (!pId) continue;
            const [stockRows] = await conn.query(
              "SELECT id, product_name, price, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
              [pId, req.user.id]
            );
            if (!stockRows.length) {
              throw new ApiError(404, `Product #${pId} not found in inventory.`);
            }
            const stockItem = stockRows[0];
            const newQty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
            const availableStock = Number(stockItem.quantity || 0);
            if (newQty > availableStock) {
              throw new ApiError(
                400,
                `Insufficient stock for "${stockItem.product_name}". Available: ${availableStock}, requested: ${newQty}.`
              );
            }
            await conn.query(
              "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
              [newQty, pId, req.user.id]
            );
            const unitPrice = Number(stockItem.price || 0);
            const lineTotal = unitPrice * newQty;
            itemsTotal += lineTotal;
            processedItems.push({
              product_id: stockItem.id,
              product_name: stockItem.product_name,
              quantity: newQty,
              unit_price: unitPrice,
              amount: lineTotal,
            });
          }

          if (processedItems.length > 0) {
            linkedProductId = processedItems[0].product_id;
            linkedQuantity = processedItems[0].quantity;
            linkedUnitPrice = processedItems[0].unit_price;
            updatedItemsJson = JSON.stringify(processedItems);
            finalAmount = itemsTotal;
          }
        } else if (rawItems !== null && rawItems.length === 0) {
          linkedProductId = null;
          linkedQuantity = null;
          linkedUnitPrice = null;
          updatedItemsJson = null;
        }
      }

      await conn.query(
        `UPDATE khata_entries
         SET amount = ?, customer_id = ?, description = ?, entry_date = ?, entry_time = ?,
             product_id = ?, quantity = ?, unit_price = ?, items = ?, payment_mode = ?
         WHERE id = ? AND created_by = ?`,
        [
          finalAmount,
          resolvedCustId,
          finalDesc,
          finalDate,
          finalTime,
          linkedProductId,
          linkedQuantity,
          linkedUnitPrice,
          updatedItemsJson,
          mode,
          id,
          req.user.id,
        ]
      );

      // Sync linked payment if present
      const paymentId = entry.payment_id;
      if (paymentId || entry.is_linked_to_payment) {
        await conn.query(
          `UPDATE payments
           SET amount = ?, customer_id = ?, purpose = ?, payment_date = ?,
               payment_mode = ?, product_id = ?, quantity = ?, unit_price = ?
           WHERE (id = ? OR khata_entry_id = ?) AND created_by = ?`,
          [
            finalAmount,
            resolvedCustId,
            finalDesc,
            finalDate,
            paymentModeEnum,
            linkedProductId,
            linkedQuantity,
            linkedUnitPrice,
            paymentId || 0,
            id,
            req.user.id,
          ]
        );
      }

      await conn.commit();

      const [updatedRows] = await pool.query(
        `SELECT ke.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
         FROM khata_entries ke
         LEFT JOIN customers cu ON cu.id = ke.customer_id
         LEFT JOIN stock s ON s.id = ke.product_id
         WHERE ke.id = ? AND ke.created_by = ?`,
        [id, req.user.id]
      );

      return res.json({
        success: true,
        message: "Khata entry updated successfully.",
        entry: updatedRows[0],
      });
    }

    // 2. Check customer_dues
    const [dueRows] = await conn.query(
      "SELECT * FROM customer_dues WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, req.user.id]
    );

    if (dueRows.length) {
      const due = dueRows[0];
      let newAmount = amount !== undefined && Number(amount) > 0 ? Number(amount) : Number(due.amount);
      const finalDueDate = due_date || date || due.due_date;
      const finalTime = req.body.due_time || req.body.time || due.due_time || "00:00:00";
      const rawMode = payment_mode ? String(payment_mode).trim().toLowerCase() : (due.payment_mode || "credit");
      const mode = (rawMode === "upi" || rawMode === "cash") ? rawMode : "credit";

      // Restore old stock
      await restoreItemsStock(due.items, due.product_id, due.quantity);

      let linkedProductId = due.product_id;
      let linkedQuantity = due.quantity;
      let linkedUnitPrice = due.unit_price;
      let updatedItemsJson = due.items;

      const rawItems = Array.isArray(req.body.items) && req.body.items.length > 0
        ? req.body.items
        : (product_id !== undefined
            ? (product_id ? [{ product_id, quantity: req.body.quantity || 1 }] : [])
            : null);

      if (rawItems !== null && rawItems.length > 0) {
        let itemsTotal = 0;
        const processedItems = [];
        for (const it of rawItems) {
          const pId = it.product_id || it.id;
          if (!pId) continue;
          const [stockRows] = await conn.query(
            "SELECT id, product_name, price, quantity FROM stock WHERE id = ? AND created_by = ? FOR UPDATE",
            [pId, req.user.id]
          );
          if (!stockRows.length) {
            throw new ApiError(404, `Product #${pId} not found in inventory.`);
          }
          const stockItem = stockRows[0];
          const newQty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
          const availableStock = Number(stockItem.quantity || 0);
          if (newQty > availableStock) {
            throw new ApiError(
              400,
              `Insufficient stock for "${stockItem.product_name}". Available: ${availableStock}, requested: ${newQty}.`
            );
          }
          await conn.query(
            "UPDATE stock SET quantity = quantity - ? WHERE id = ? AND created_by = ?",
            [newQty, pId, req.user.id]
          );
          const unitPrice = Number(stockItem.price || 0);
          const lineTotal = unitPrice * newQty;
          itemsTotal += lineTotal;
          processedItems.push({
            product_id: stockItem.id,
            product_name: stockItem.product_name,
            quantity: newQty,
            unit_price: unitPrice,
            amount: lineTotal,
          });
        }
        if (processedItems.length > 0) {
          linkedProductId = processedItems[0].product_id;
          linkedQuantity = processedItems[0].quantity;
          linkedUnitPrice = processedItems[0].unit_price;
          updatedItemsJson = JSON.stringify(processedItems);
          newAmount = itemsTotal;
        }
      }

      const amountDiff = newAmount - Number(due.amount);
      const newRemaining = Math.max(0, Number(due.remaining_amount) + amountDiff);
      const newStatus = newRemaining <= 0 ? "settled" : (newRemaining < newAmount ? "partially_paid" : "pending");

      await conn.query(
        `UPDATE customer_dues
         SET amount = ?, remaining_amount = ?, status = ?, description = COALESCE(?, description),
             due_date = ?, due_time = ?, payment_mode = ?, product_id = ?, quantity = ?, unit_price = ?, items = ?
         WHERE id = ? AND created_by = ?`,
        [
          newAmount,
          newRemaining,
          newStatus,
          description || null,
          finalDueDate,
          finalTime,
          mode,
          linkedProductId,
          linkedQuantity,
          linkedUnitPrice,
          updatedItemsJson,
          id,
          req.user.id,
        ]
      );

      if (amountDiff !== 0 && due.customer_id) {
        await conn.query(
          "UPDATE customers SET total_due = GREATEST(0, total_due + ?) WHERE id = ? AND created_by = ?",
          [amountDiff, due.customer_id, req.user.id]
        );
      }

      await conn.commit();

      const [updatedDueRows] = await pool.query(
        `SELECT cd.*, cu.name AS customer_name, cu.phone AS customer_phone, s.product_name
         FROM customer_dues cd
         LEFT JOIN customers cu ON cu.id = cd.customer_id
         LEFT JOIN stock s ON s.id = cd.product_id
         WHERE cd.id = ? AND cd.created_by = ?`,
        [id, req.user.id]
      );

      return res.json({
        success: true,
        message: "Customer due updated successfully.",
        entry: updatedDueRows[0],
      });
    }

    throw new ApiError(404, "Khata entry not found.");
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// DELETE /api/khata/:id
// Deletes a Khata entry with stock restoration and linked payment sync
const deleteKhataEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const restoreItemsStock = async (rawItems, fallbackProdId, fallbackQty) => {
      let itemsList = [];
      if (rawItems) {
        try {
          itemsList = typeof rawItems === "string" ? JSON.parse(rawItems) : rawItems;
        } catch (_) {
          itemsList = [];
        }
      }
      if (Array.isArray(itemsList) && itemsList.length > 0) {
        for (const it of itemsList) {
          const pId = it.product_id || it.id;
          const q = Number(it.quantity || 0);
          if (pId && q > 0) {
            await conn.query(
              "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
              [q, pId, req.user.id]
            );
          }
        }
      } else if (fallbackProdId && Number(fallbackQty || 0) > 0) {
        await conn.query(
          "UPDATE stock SET quantity = quantity + ? WHERE id = ? AND created_by = ?",
          [Number(fallbackQty), fallbackProdId, req.user.id]
        );
      }
    };

    // 1. Check khata_entries
    const [keRows] = await conn.query(
      "SELECT * FROM khata_entries WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, req.user.id]
    );

    if (keRows.length) {
      const entry = keRows[0];

      // Restore stock for all items
      await restoreItemsStock(entry.items, entry.product_id, entry.quantity);

      // Delete linked payment if exists
      if (entry.payment_id || entry.is_linked_to_payment) {
        await conn.query(
          "DELETE FROM payments WHERE (id = ? OR khata_entry_id = ?) AND created_by = ?",
          [entry.payment_id || 0, id, req.user.id]
        );
      }

      await conn.query("DELETE FROM khata_entries WHERE id = ? AND created_by = ?", [id, req.user.id]);

      await conn.commit();

      return res.json({
        success: true,
        message: "Khata entry deleted successfully.",
        deleted_id: id,
      });
    }

    // 2. Check customer_dues
    const [dueRows] = await conn.query(
      "SELECT * FROM customer_dues WHERE id = ? AND created_by = ? FOR UPDATE",
      [id, req.user.id]
    );

    if (dueRows.length) {
      const due = dueRows[0];

      // Restore stock for all items
      await restoreItemsStock(due.items, due.product_id, due.quantity);

      // Deduct customer total_due by remaining due amount
      if (due.customer_id && Number(due.remaining_amount) > 0) {
        await conn.query(
          "UPDATE customers SET total_due = GREATEST(0, total_due - ?) WHERE id = ? AND created_by = ?",
          [Number(due.remaining_amount), due.customer_id, req.user.id]
        );
      }

      await conn.query("DELETE FROM customer_due_allocations WHERE due_id = ?", [id]);
      await conn.query("DELETE FROM customer_dues WHERE id = ? AND created_by = ?", [id, req.user.id]);

      await conn.commit();

      return res.json({
        success: true,
        message: "Customer due deleted successfully.",
        deleted_id: id,
      });
    }

    throw new ApiError(404, "Khata entry not found.");
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/khata/search-customers
const searchKhataCustomers = asyncHandler(async (req, res) => {
  const keyword = String(req.query.search || req.query.query || req.query.q || "").trim();
  let sql = `
    SELECT id, name, display_name, phone, email, business_name, total_due
    FROM customers
    WHERE created_by = ?
  `;
  const params = [req.user.id];
  if (keyword) {
    sql += " AND (name LIKE ? OR display_name LIKE ? OR phone LIKE ? OR business_name LIKE ? OR email LIKE ?)";
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    sql += ` ORDER BY
      CASE
        WHEN name LIKE ? THEN 1
        WHEN name LIKE ? THEN 2
        ELSE 3
      END,
      total_due DESC,
      name ASC
      LIMIT 50`;
    params.push(`${keyword}%`, `%${keyword}%`);
  } else {
    sql += " ORDER BY total_due DESC, name ASC LIMIT 50";
  }
  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, customers: rows });
});

// GET /api/khata/search-products
const searchKhataProducts = asyncHandler(async (req, res) => {
  const keyword = String(req.query.search || req.query.query || req.query.q || "").trim();
  const type = String(req.query.type || req.query.item_type || "").trim().toLowerCase();
  let sql = `
    SELECT id, product_name, price, quantity, unit, hsn_code, gst_rate, type, item_type
    FROM stock
    WHERE created_by = ?
  `;
  const params = [req.user.id];
  if (type && type !== "all") {
    if (type === "goods") {
      sql += " AND (item_type = 'goods' OR type = 'goods' OR (type IS NULL AND item_type IS NULL))";
    } else if (type === "service") {
      sql += " AND (item_type = 'service' OR type = 'service')";
    }
  }
  if (keyword) {
    sql += " AND (product_name LIKE ? OR category LIKE ? OR hsn_code LIKE ?)";
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    sql += ` ORDER BY
      CASE
        WHEN product_name LIKE ? THEN 1
        WHEN product_name LIKE ? THEN 2
        ELSE 3
      END,
      product_name ASC
      LIMIT 50`;
    params.push(`${keyword}%`, `%${keyword}%`);
  } else {
    sql += " ORDER BY product_name ASC LIMIT 50";
  }
  const [rows] = await pool.query(sql, params);
  res.json({ success: true, count: rows.length, products: rows });
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
  updateKhataEntry,
  deleteKhataEntry,
  searchKhataCustomers,
  searchKhataProducts,
};
