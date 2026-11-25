import db from './db.js';
import { findProduct } from './products.js';
import { receivedBetween } from './udhaar.js';
import { pathFinder, comparePaths } from './categories.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const range = (from, to) => {
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error('Choose a valid date range');
  return { from, to };
};

// Which bills a sales report covers. by: 'all' | 'salesman' (salesman_id) | 'bills' (bill_from..bill_to).
// A bill number range picks the bills itself, so the dates are not used for it.
function billFilter(from, to, f = {}) {
  const p = { from: null, to: null, sid: null, bf: null, bt: null };
  if (f.by === 'bills') {
    const bf = Number(f.bill_from), bt = Number(f.bill_to);
    if (!Number.isInteger(bf) || !Number.isInteger(bt) || bf <= 0 || bt < bf)
      throw new Error('Enter a valid bill number range (from must not be above to)');
    Object.assign(p, { bf, bt });
  } else {
    Object.assign(p, range(from, to));
  }
  if (f.by === 'salesman') {
    p.sid = Number(f.salesman_id);
    if (!db.prepare('SELECT 1 FROM salesmen WHERE id = ?').get(p.sid)) throw new Error('Select a salesman');
  }
  return p;
}
const WHERE = `(CASE WHEN @bf IS NULL THEN date(s.sold_at) BETWEEN @from AND @to ELSE s.bill_no BETWEEN @bf AND @bt END)
  AND (@sid IS NULL OR s.salesman_id = @sid)`;

const SALES_CTE = `
  WITH r AS (
    SELECT s.id, s.bill_no, s.sold_at, s.customer_name, s.salesman_id, s.subtotal, s.discount, s.total,
      date(s.sold_at) AS day, (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = s.id) AS units
    FROM sales s WHERE ${WHERE}
  )`;

export function salesReport(from, to, filter = {}) {
  if (filter.by === 'code') return codeReport(from, to, filter.code);
  if (filter.by === 'category') return categoryReport(from, to);
  const p = billFilter(from, to, filter);
  const q = (sql) => db.prepare(`${SALES_CTE} ${sql}`).all(p);
  const out = {
    summary: q(`SELECT COUNT(*) AS bills, COALESCE(SUM(units), 0) AS units,
                COALESCE(SUM(subtotal), 0) AS gross, COALESCE(SUM(discount), 0) AS discount,
                COALESCE(SUM(total), 0) AS net FROM r`)[0],
    bySalesman: q(`SELECT m.name AS name, COUNT(*) AS bills, SUM(r.units) AS units,
                   SUM(r.subtotal) AS gross, SUM(r.discount) AS discount, SUM(r.total) AS net
                   FROM r JOIN salesmen m ON m.id = r.salesman_id
                   GROUP BY m.id ORDER BY net DESC`),
    byDay: q(`SELECT day, COUNT(*) AS bills, SUM(units) AS units, SUM(total) AS net
              FROM r GROUP BY day ORDER BY day`),
    byPayment: db.prepare(`
      SELECT p.method, COUNT(DISTINCT p.sale_id) AS bills, SUM(p.amount) AS amount
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE ${WHERE}
      GROUP BY p.method ORDER BY amount DESC`).all(p),
  };
  // a salesman's or a bill range's report also lists every bill
  if (filter.by === 'salesman' || filter.by === 'bills') {
    out.bills = q(`SELECT r.bill_no, r.sold_at, r.customer_name, m.name AS salesman, r.units, r.discount, r.total,
                     (SELECT GROUP_CONCAT(method, '+') FROM payments WHERE sale_id = r.id) AS methods
                   FROM r JOIN salesmen m ON m.id = r.salesman_id ORDER BY r.bill_no`);
  }
  // returns (credit notes) made in the period - for a salesman, of his bills; for a bill range, of those bills
  out.returns = db.prepare(`SELECT c.note_no, c.created_at, c.amount, c.balance, c.made_by, s.bill_no, s.customer_name,
      x.bill_no AS exchange_bill_no
    FROM returns c JOIN sales s ON s.id = c.sale_id LEFT JOIN sales x ON x.id = c.exchange_sale_id
    WHERE (CASE WHEN @bf IS NULL THEN date(c.created_at) BETWEEN @from AND @to ELSE s.bill_no BETWEEN @bf AND @bt END)
      AND (@sid IS NULL OR s.salesman_id = @sid) ORDER BY c.note_no`).all(p);
  out.summary.returns = out.returns.reduce((a, c) => a + c.amount, 0);
  out.summary.after_returns = out.summary.net - out.summary.returns;
  // udhaar payments received in the period (not for a bill number range or one salesman's bills)
  out.udhaar_received = !p.bf && !p.sid ? receivedBetween(p.from, p.to) : [];
  return out;
}

// Sales of one product (its barcode) in the period, line by line.
function codeReport(from, to, code) {
  const p = range(from, to);
  const scan = String(code ?? '').trim();
  if (!scan) throw new Error('Enter or scan a barcode');
  const prod = findProduct(scan);
  const c = prod?.code ?? scan;
  const lines = db.prepare(`
    SELECT s.bill_no, s.sold_at, s.customer_name, m.name AS salesman, i.description, i.size, i.colour, i.qty, i.price, i.amount
    FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN salesmen m ON m.id = s.salesman_id
    WHERE i.code = @c AND date(s.sold_at) BETWEEN @from AND @to ORDER BY s.bill_no, i.id`).all({ ...p, c });
  if (!prod && !lines.length) throw new Error(`Barcode "${scan}" not found`);
  return {
    product: { code: c, name: prod?.name ?? lines[0]?.description ?? '', size: prod?.size ?? '', colour: prod?.colour ?? '' },
    summary: { bills: new Set(lines.map((l) => l.bill_no)).size, units: lines.reduce((a, l) => a + l.qty, 0),
      amount: lines.reduce((a, l) => a + l.amount, 0) },
    lines,
  };
}

// Sales by category in the period: totals at every level (Pants, Pants > Cargo pants, ... > Rs 500-999), using the
// category each bill line had when it was sold. Amounts are the item prices on the bills, before any bill discount.
const NO_CAT = '(no category)';
function categoryReport(from, to) {
  const p = range(from, to);
  const lines = db.prepare(`SELECT i.category, i.qty, i.amount, s.id AS sale_id FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE date(s.sold_at) BETWEEN @from AND @to`).all(p);
  const nodes = new Map();
  for (const l of lines) {
    const parts = l.category ? l.category.split(' > ') : [NO_CAT];
    parts.forEach((_, k) => {
      const path = parts.slice(0, k + 1).join(' > ');
      const n = nodes.get(path) ?? { path, name: parts[k], level: k + 1, qty: 0, amount: 0, bills: new Set() };
      n.qty += l.qty; n.amount += l.amount; n.bills.add(l.sale_id);
      nodes.set(path, n);
    });
  }
  const rows = [...nodes.values()].map((n) => ({ ...n, bills: n.bills.size }))
    .sort((a, b) => (a.path === NO_CAT) - (b.path === NO_CAT) || comparePaths(a.path, b.path));
  return { byCategory: true, rows, total: { qty: lines.reduce((a, l) => a + l.qty, 0), amount: lines.reduce((a, l) => a + l.amount, 0) } };
}

export function stockReport(from, to) {
  const p = range(from, to);
  const pathOf = pathFinder();
  return db.prepare(`
    SELECT p.code, p.name, p.size, p.colour, p.category_id, p.rate,
      COALESCE(SUM(CASE WHEN date(m.created_at) < @from THEN m.qty END), 0) AS opening,
      COALESCE(SUM(CASE WHEN date(m.created_at) BETWEEN @from AND @to AND m.type = 'stock_in' THEN m.qty END), 0) AS stock_in,
      COALESCE(-SUM(CASE WHEN date(m.created_at) BETWEEN @from AND @to AND m.type = 'sale' THEN m.qty END), 0) AS sold,
      COALESCE(SUM(CASE WHEN date(m.created_at) BETWEEN @from AND @to AND m.type = 'adjustment' THEN m.qty END), 0) AS adjustment,
      COALESCE(SUM(CASE WHEN date(m.created_at) BETWEEN @from AND @to AND m.type = 'return' THEN m.qty END), 0) AS returned,
      COALESCE(SUM(CASE WHEN date(m.created_at) <= @to THEN m.qty END), 0) AS closing
    FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
    GROUP BY p.id
    HAVING opening != 0 OR stock_in != 0 OR sold != 0 OR adjustment != 0 OR returned != 0 OR closing != 0
    ORDER BY p.name COLLATE NOCASE, p.size, p.colour, p.code`).all(p)
    .map(({ category_id, ...r }) => ({ ...r, category: pathOf(category_id) }));
}

// GST report for filing (GSTR-1 style) from the tax invoices made while GST billing was on. Every figure is
// what was printed on the bills; bills made with GST billing off are not in it.
//   summary  - all tax invoices in the period
//   b2b      - bills with the customer's GSTIN, one row each
//   b2c      - the other bills, by GST rate and place of supply
//   hsn      - by HSN code and rate
//   notes    - credit notes (returns) of tax invoices made in the period: business buyers one by one (CDNR),
//              the rest by rate and place of supply; to be taken off the sales above when filing
export function gstReport(from, to) {
  const p = range(from, to);
  const BILLS = `FROM sales s WHERE s.gst = 1 AND date(s.sold_at) BETWEEN @from AND @to`;
  const ITEMS = `FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.gst = 1 AND date(s.sold_at) BETWEEN @from AND @to`;
  const TAX = `SUM(i.taxable) AS taxable, SUM(i.cgst) AS cgst, SUM(i.sgst) AS sgst, SUM(i.igst) AS igst`;
  return {
    summary: db.prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(s.total), 0) AS value, COALESCE(SUM(s.taxable), 0) AS taxable,
      COALESCE(SUM(s.cgst), 0) AS cgst, COALESCE(SUM(s.sgst), 0) AS sgst, COALESCE(SUM(s.igst), 0) AS igst ${BILLS}`).get(p),
    b2b: db.prepare(`SELECT s.bill_no, s.sold_at, s.customer_name, s.customer_gstin, s.supply_state, s.total AS value,
      s.taxable, s.cgst, s.sgst, s.igst ${BILLS} AND s.customer_gstin <> '' ORDER BY s.bill_no`).all(p),
    b2c: db.prepare(`SELECT i.gst_rate AS rate, s.supply_state, COUNT(DISTINCT s.id) AS bills, ${TAX}
      ${ITEMS} AND s.customer_gstin = '' GROUP BY i.gst_rate, s.supply_state ORDER BY s.supply_state, i.gst_rate`).all(p),
    hsn: db.prepare(`SELECT i.hsn, i.gst_rate AS rate, MIN(i.description) AS description, SUM(i.qty) AS qty,
      SUM(i.taxable + i.cgst + i.sgst + i.igst) AS value, ${TAX}
      ${ITEMS} GROUP BY i.hsn, i.gst_rate ORDER BY i.hsn, i.gst_rate`).all(p),
    notes: {
      summary: db.prepare(`SELECT COUNT(*) AS notes, COALESCE(SUM(c.amount), 0) AS value, COALESCE(SUM(c.taxable), 0) AS taxable,
        COALESCE(SUM(c.cgst), 0) AS cgst, COALESCE(SUM(c.sgst), 0) AS sgst, COALESCE(SUM(c.igst), 0) AS igst
        FROM returns c WHERE c.gst = 1 AND date(c.created_at) BETWEEN @from AND @to`).get(p),
      b2b: db.prepare(`SELECT c.note_no, c.created_at, s.bill_no, s.sold_at, s.customer_name, s.customer_gstin, s.supply_state,
        c.amount AS value, c.taxable, c.cgst, c.sgst, c.igst
        FROM returns c JOIN sales s ON s.id = c.sale_id
        WHERE c.gst = 1 AND date(c.created_at) BETWEEN @from AND @to AND s.customer_gstin <> '' ORDER BY c.note_no`).all(p),
      b2c: db.prepare(`SELECT ri.gst_rate AS rate, s.supply_state, COUNT(DISTINCT c.id) AS notes, SUM(ri.taxable) AS taxable,
        SUM(ri.cgst) AS cgst, SUM(ri.sgst) AS sgst, SUM(ri.igst) AS igst
        FROM return_items ri JOIN returns c ON c.id = ri.return_id JOIN sales s ON s.id = c.sale_id
        WHERE c.gst = 1 AND date(c.created_at) BETWEEN @from AND @to AND s.customer_gstin = ''
        GROUP BY ri.gst_rate, s.supply_state ORDER BY s.supply_state, ri.gst_rate`).all(p),
    },
  };
}
