const getNextSubscriptionInvoiceNumber = async (pool) => {
  const now = new Date();
  const indiaYear = Number(new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
  }).format(now));
  const indiaMonth = Number(new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "numeric",
  }).format(now));
  const fiscalYearStart = indiaMonth >= 4 ? indiaYear : indiaYear - 1;
  const fiscalYear = `${fiscalYearStart}-${String(fiscalYearStart + 1).slice(-2)}`;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT IGNORE INTO subscription_invoice_series (fiscal_year, last_number) VALUES (?, 0)",
      [fiscalYear]
    );
    const [rows] = await conn.query(
      "SELECT last_number FROM subscription_invoice_series WHERE fiscal_year = ? FOR UPDATE",
      [fiscalYear]
    );
    if (!rows[0]) throw new Error(`Invoice series not found for fiscal year ${fiscalYear}`);

    const sequence = Number(rows[0].last_number) + 1;
    await conn.query(
      "UPDATE subscription_invoice_series SET last_number = ? WHERE fiscal_year = ?",
      [sequence, fiscalYear]
    );
    await conn.commit();
    return `FTS/INV/${fiscalYear}/K-${String(sequence).padStart(2, "0")}`;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

module.exports = getNextSubscriptionInvoiceNumber;
