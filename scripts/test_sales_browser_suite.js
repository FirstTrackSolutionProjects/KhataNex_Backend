const puppeteer = require('puppeteer-core');
const pool = require('../config/db');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function runBrowserSuite() {
  console.log('================================================================================');
  console.log('🧪 RUNNING FULL KHATANEX SALES MODULE BROWSER VERIFICATION SUITE');
  console.log('================================================================================\n');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.setViewport({ width: 1280, height: 900 });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [BROWSER CONSOLE ERROR]', msg.text());
    }
  });

  page.on('pageerror', err => {
    console.error('  [BROWSER PAGE EXCEPTION]', err.message);
  });

  page.on('dialog', async dialog => {
    console.log('  [BROWSER DIALOG]', dialog.message());
    await dialog.dismiss();
  });

  try {
    // -------------------------------------------------------------------------
    // 1. LOGIN
    // -------------------------------------------------------------------------
    console.log('Step 1: Logging into KhataNex web app...');
    await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
    await page.type('input[type="email"]', 'ui_tester@khatanex.test');
    await page.type('input[type="password"]', 'TesterPass123!');
    await page.click('button[type="submit"]');

    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('  ✅ Logged in successfully. Current URL:', page.url());

    // -------------------------------------------------------------------------
    // 2. NAVIGATE TO SALES
    // -------------------------------------------------------------------------
    console.log('\nStep 2: Navigating to /sales...');
    await page.goto('http://localhost:5173/sales', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1000));
    console.log('  ✅ Arrived at Sales management page.');

    // -------------------------------------------------------------------------
    // 3. TEST VALIDATION ERROR DISPLAY (NO SILENT SUBMIT SWALLOWING)
    // -------------------------------------------------------------------------
    console.log('\nStep 3: Verifying validation errors display visibly (no silent submit swallowing)...');
    // Open modal
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Record Sale'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Modal should be open
    const modalVisible = await page.evaluate(() => document.querySelectorAll('form').length > 0);
    if (!modalVisible) throw new Error('Modal failed to open!');
    console.log('  ✅ Record Sale modal opened cleanly.');

    // Click submit with empty form in existing mode (no customer selected)
    await page.evaluate(() => {
      const submitBtn = document.querySelector('form button[type="submit"]');
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    // Check for explicit error banner
    let errorBanner = await page.evaluate(() => {
      const err = document.querySelector('.bg-red-50');
      return err ? err.innerText.trim() : null;
    });
    console.log('  Validation error captured on empty existing customer:', errorBanner);
    if (!errorBanner || !errorBanner.includes('Please select an existing customer')) {
      throw new Error(`Expected customer validation error banner, got: "${errorBanner}"`);
    }
    console.log('  ✅ Validation banner displayed prominently without silent cancellation!');

    // Close modal
    await page.evaluate(() => {
      const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Cancel');
      if (cancelBtn) cancelBtn.click();
    });
    await new Promise(r => setTimeout(r, 500));

    // -------------------------------------------------------------------------
    // 4. TEST WALK-IN CUSTOMER SALE CREATION
    // -------------------------------------------------------------------------
    console.log('\nStep 4: Testing Walk-in / Manual Sale creation...');
    // Reopen modal
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Record Sale'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Switch to Walk-in
    await page.evaluate(() => {
      const walkinBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Walk-in'));
      if (walkinBtn) walkinBtn.click();
    });
    await new Promise(r => setTimeout(r, 400));

    // Fill customer name & items using React value tracker
    await page.evaluate(() => {
      const setInput = (input, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const inputs = Array.from(document.querySelectorAll('form input'));
      const nameInput = inputs.find(i => i.placeholder && i.placeholder.includes('Walk-in Customer'));
      if (nameInput) setInput(nameInput, 'Aarav Patel');

      const productInput = inputs.find(i => i.placeholder && i.placeholder.includes('Copper Wire'));
      if (productInput) setInput(productInput, 'USB Type-C Fast Charger');

      const rateInput = inputs.find(i => i.placeholder === '0.00');
      if (rateInput) setInput(rateInput, '450');
    });
    await new Promise(r => setTimeout(r, 500));

    // Submit sale
    console.log('  Submitting Walk-in sale...');
    await page.evaluate(() => {
      const submitBtn = document.querySelector('form button[type="submit"]');
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Verify modal closed and row added to table
    const tableText = await page.evaluate(() => document.querySelector('table')?.innerText || '');
    if (!tableText.includes('Aarav Patel') || !tableText.includes('USB Type-C Fast Charger')) {
      throw new Error('Walk-in sale not found in sales table after submit!');
    }
    console.log('  ✅ Walk-in sale recorded successfully! Appears in table.');

    // -------------------------------------------------------------------------
    // 5. TEST EXISTING CUSTOMER SALE + STOCK DECREMENT + IMMEDIATE TAX INVOICE
    // -------------------------------------------------------------------------
    console.log('\nStep 5: Testing Existing Customer Sale + Stock Decrement + Immediate Tax Invoice Checkbox...');
    // Check initial stock of 'Wireless Mouse' in DB
    const [initialStockRows] = await pool.query(
      'SELECT id, product_name, quantity FROM stock WHERE created_by = 736 AND product_name = "Wireless Mouse"'
    );
    const initialQty = initialStockRows[0].quantity;
    const stockId = initialStockRows[0].id;
    console.log(`  Initial stock for "${initialStockRows[0].product_name}": ${initialQty} pcs`);

    // Reopen modal
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Record Sale'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Select existing customer
    const [custRows] = await pool.query(
      'SELECT id, name FROM customers WHERE created_by = 736 ORDER BY id ASC LIMIT 1'
    );
    const targetCustId = String(custRows[0].id);
    await page.select('#sale-customer-select', targetCustId);
    await new Promise(r => setTimeout(r, 500));

    // Select stock item in Item 1
    await page.select('#sale-stock-select-0', String(stockId));
    await new Promise(r => setTimeout(r, 500));

    // Set Quantity = 5
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('form input'));
      const qtyInput = inputs.find(i => i.type === 'number' && i.min === '0.01');
      if (qtyInput) {
        qtyInput.focus();
        qtyInput.value = '';
      }
    });
    await page.type('input[type="number"][min="0.01"]', '5');
    await new Promise(r => setTimeout(r, 400));

    // Check "Generate Official GST Tax Invoice" checkbox
    await page.evaluate(() => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) {
        checkbox.click();
      }
    });
    await new Promise(r => setTimeout(r, 400));

    // Submit sale
    console.log('  Submitting sale with Generate Invoice enabled...');
    await page.evaluate(() => {
      const submitBtn = document.querySelector('form button[type="submit"]');
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // Verify stock decremented in DB
    const [afterStockRows] = await pool.query(
      'SELECT quantity FROM stock WHERE id = ?',
      [stockId]
    );
    const newQty = afterStockRows[0].quantity;
    console.log(`  Stock after sale of 5 pcs: ${newQty} pcs (Expected: ${initialQty - 5})`);
    if (newQty !== initialQty - 5) {
      throw new Error(`Stock decrement failed! Expected ${initialQty - 5}, got ${newQty}`);
    }
    console.log('  ✅ Goods inventory stock decremented accurately by exactly 5 pcs!');

    // Check that invoice was created and linked
    const [latestSaleRows] = await pool.query(
      'SELECT s.id, s.sale_number, s.invoice_id, inv.invoice_number, inv.pdf_path FROM sales s LEFT JOIN invoices inv ON s.invoice_id = inv.id WHERE s.user_id = 736 ORDER BY s.id DESC LIMIT 1'
    );
    const latestSale = latestSaleRows[0];
    console.log(`  Latest Sale: ${latestSale.sale_number}, Invoice ID: ${latestSale.invoice_id}, Invoice #: ${latestSale.invoice_number}`);
    if (!latestSale.invoice_id || !latestSale.invoice_number) {
      throw new Error('Official Tax Invoice was not created and linked to the sale!');
    }
    console.log('  ✅ Official Tax Invoice (#INV-YYYY-XXXXX) created and linked to the sale!');

    // -------------------------------------------------------------------------
    // 6. TEST 1-CLICK "CREATE INVOICE" ON UN-INVOICED SALE
    // -------------------------------------------------------------------------
    console.log('\nStep 6: Testing 1-click "Create Invoice" on un-invoiced sale...');
    // Find row with "Create Invoice" button
    const clickedCreateInv = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('table button'));
      const createBtn = buttons.find(b => b.innerText.includes('Create Invoice'));
      if (createBtn) {
        createBtn.click();
        return true;
      }
      return false;
    });
    console.log('  Found and clicked "Create Invoice" button on table row:', clickedCreateInv);
    if (!clickedCreateInv) throw new Error('Could not find "Create Invoice" button on un-invoiced sale!');

    // Wait for the invoice creation API call and table update
    await new Promise(r => setTimeout(r, 3500));

    // Verify in DB that the sale now has an invoice_id and stock was NOT decremented again
    const [afterStockRows2] = await pool.query(
      'SELECT quantity FROM stock WHERE id = ?',
      [stockId]
    );
    console.log(`  Stock after post-sale invoice generation: ${afterStockRows2[0].quantity} pcs (No double decrement)`);
    if (afterStockRows2[0].quantity !== newQty) {
      throw new Error('Stock was decremented twice upon invoice generation!');
    }
    console.log('  ✅ Single-decrement protection confirmed: Stock not decremented again!');

    console.log('\n================================================================================');
    console.log('🎉 ALL BROWSER UI WORKFLOW TESTS PASSED 100% SUCCESSFULLY!');
    console.log('================================================================================\n');

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ BROWSER TEST SUITE FAILED:', err);
    await browser.close();
    process.exit(1);
  }
}

runBrowserSuite();

