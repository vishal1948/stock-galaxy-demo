// Returns and exchanges (1.5.3). Items come back from a saved bill; the customer gets a credit note CN-<no> for
// exactly what they paid for those items (their share of the bill discount taken off) - never cash.
//   - exchange: on Billing, the credit note pays (part of) the new bill at once (sales.js createSale)
//   - return only: Find Bill > Return items; the credit note is used on a later bill (payment mode "Credit note")
// The stock comes back. A GST bill's credit note reverses the tax of the returned items.
// Time limit (Settings, default 7 days, 0 = none): after it only the owner can take items back.
import db from './db.js';
import { assertWritable } from './lock-state.js';
import { lineNets, returnShare } from './gst.js';

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
export const returnDays = () => { const v = Number(getSetting('return_days') ?? 7); return Number.isInteger(v) && v >= 0 ? v : 7; };

/** A bill and what can still come back from it. null if there is no such bill. */
export function returnable(billNo) {
  const sale = db.prepare(`SELECT s.*, CAST(julianday(date('now','localtime')) - julianday(date(s.sold_at)) AS INTEGER) AS age
    FROM sales s WHERE s.bill_no = ?`).get(Number(billNo));
  if (!sale) return null;
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
  const done = Object.fromEntries(db.prepare(`SELECT ri.sale_item_id AS id, SUM(ri.qty) AS q FROM return_items ri
    JOIN sale_items si ON si.id = ri.sale_item_id WHERE si.sale_id = ? GROUP BY ri.sale_item_id`).all(sale.id).map((r) => [r.id, r.q]));
  const nets = lineNets(items, sale.discount, sale.subtotal, sale.gst === 1);
  const limit = returnDays();
  return {
    bill_no: sale.bill_no, sale_id: sale.id, sold_at: sale.sold_at, customer_name: sale.customer_name, customer_phone: sale.customer_phone,
    customer_gstin: sale.customer_gstin, gst: sale.gst, total: sale.total, age: sale.age, limit, overLimit: limit > 0 && sale.age > limit,
    lines: items.map((i, n) => ({
      sale_item_id: i.id, code: i.code, description: i.description, size: i.size, colour: i.colour, hsn: i.hsn, gst_rate: i.gst_rate,
      product_id: i.product_id, qty: i.qty, price: i.price, returned: done[i.id] ?? 0, left: i.qty - (done[i.id] ?? 0), ...nets[n],
    })),
    notes: db.prepare('SELECT note_no, created_at, amount, balance FROM returns WHERE sale_id = ? ORDER BY id').all(sale.id),
  };
}

/** Takes items back from a bill and makes the credit note. Call inside a transaction.
 *  picks: [{ sale_item_id, qty }]; who: { role, id, name } of the person doing it (default: the owner). */
export function makeReturn(billNo, picks, who = {}) {
  assertWritable();
  const bill = returnable(billNo);
  if (!bill) throw new Error(`Bill ${billNo} not found`);
  if (bill.overLimit && who.role === 'salesman')
    throw new Error(`Bill ${bill.bill_no} is ${bill.age} days old - returns are allowed for ${bill.limit} days. Ask the owner.`);
  const chosen = (Array.isArray(picks) ? picks : []).filter((p) => Number(p?.qty) > 0);
  if (!chosen.length) throw new Error('Choose the items coming back and how many');
  const seen = new Set();
  const lines = chosen.map((p) => {
    const line = bill.lines.find((l) => l.sale_item_id === Number(p.sale_item_id));
    const q = Number(p.qty);
    if (!line || seen.has(line.sale_item_id)) throw new Error('That item is not on this bill');
    seen.add(line.sale_item_id);
    if (!Number.isInteger(q) || q > line.left)
      throw new Error(`Only ${line.left} of ${line.description} (${line.code}) can still come back from bill ${bill.bill_no}`);
    return { line, q, ...returnShare(line, line.qty, line.returned, q) };
  });
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  const amount = sum('amount');
  if (amount <= 0) throw new Error('These items were free on the bill - there is nothing to give back');

  const noteNo = Number(getSetting('last_note_no') ?? 0) + 1;
  setSetting('last_note_no', noteNo);
  const id = Number(db.prepare(`INSERT INTO returns (note_no, sale_id, made_by, salesman_id, amount, gst, taxable, cgst, sgst, igst, balance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(noteNo, bill.sale_id, who.name ?? 'Owner', who.role === 'salesman' ? who.id : null,
    amount, bill.gst, sum('taxable'), sum('cgst'), sum('sgst'), sum('igst'), amount).lastInsertRowid);
  const addItem = db.prepare(`INSERT INTO return_items (return_id, sale_item_id, product_id, code, description, size, colour, hsn, qty,
    amount, gst_rate, taxable, cgst, sgst, igst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const move = db.prepare("INSERT INTO stock_movements (product_id, qty, type, ref_id) VALUES (?, ?, 'return', ?)");
  for (const { line: l, q, amount: a, taxable, cgst, sgst, igst } of lines) {
    addItem.run(id, l.sale_item_id, l.product_id, l.code, l.description, l.size, l.colour, l.hsn, q, a, l.gst_rate, taxable, cgst, sgst, igst);
    if (l.product_id) move.run(l.product_id, q, id);   // the stock comes back
  }
  return { id, note_no: noteNo, amount };
}

/** Find Bill > Return items: a return without a new bill. Returns the credit note number. */
export const createReturn = db.transaction((billNo, picks, who = {}) => makeReturn(billNo, picks, who).note_no);

/** A credit note with its items and its bill, or null. Accepts 5, "5" or "CN-5". */
export function getCreditNote(no) {
  const n = Number(String(no ?? '').replace(/^\s*cn[-\s]*/i, ''));
  if (!Number.isInteger(n) || n <= 0) return null;
  const note = db.prepare(`SELECT r.*, s.bill_no, s.sold_at AS bill_date, s.customer_name, s.customer_phone, s.customer_gstin, s.supply_state,
      x.bill_no AS exchange_bill_no
    FROM returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN sales x ON x.id = r.exchange_sale_id WHERE r.note_no = ?`).get(n);
  if (!note) return null;
  note.items = db.prepare(`SELECT code, description, size, colour, hsn, qty, amount, gst_rate, taxable, cgst, sgst, igst
    FROM return_items WHERE return_id = ? ORDER BY id`).all(note.id);
  note.used_on = db.prepare(`SELECT s.bill_no, p.amount FROM payments p JOIN sales s ON s.id = p.sale_id
    WHERE p.credit_note_id = ? ORDER BY p.id`).all(note.id);
  return note;
}

/** Takes `amount` off a credit note's balance for a new bill. Call inside a transaction. Returns its id. */
export function useCredit(no, amount) {
  const note = getCreditNote(no);
  if (!note) throw new Error(`Credit note ${no} not found`);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter the amount to use from the credit note');
  if (amount > note.balance) throw new Error(`Credit note CN-${note.note_no} has only Rs ${(note.balance / 100).toFixed(2)} left`);
  db.prepare('UPDATE returns SET balance = balance - ? WHERE id = ?').run(amount, note.id);
  return note.id;
}

/** Last credit notes, newest first (Find Bill). */
export const recentReturns = (limit = 10) => db.prepare(`SELECT r.note_no, r.created_at, r.amount, r.balance, r.made_by, s.bill_no,
    s.customer_name, s.customer_phone, x.bill_no AS exchange_bill_no
  FROM returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN sales x ON x.id = r.exchange_sale_id ORDER BY r.id DESC LIMIT ?`).all(limit);
