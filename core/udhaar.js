// Udhaar (pay later). A bill paid (fully or partly) with the "Pay Later (Udhaar)" mode is owed by the customer whose
// mobile number is on the bill. Payments received later bring it down; each gets a receipt RC-<receipt_no>.
//   owed = udhaar on the customer's bills - payments received (worked out from the bills; nothing stored twice)
// Credit limit per customer (owner sets it; none = no limit): over it, only the owner can bill on udhaar.
// Only the owner records payments received.
import db from './db.js';
import { assertWritable } from './lock-state.js';
import { useCredit } from './returns.js';

export const UDHAAR = 'udhaar';   // the payment mode id (main/payment-catalog.js)
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const PHONE = /^[6-9]\d{9}$/;
const rs = (p) => `Rs ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const given = db.prepare(`SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN sales s ON s.id = p.sale_id
  WHERE p.method = 'udhaar' AND s.customer_phone = ?`);
const received = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM udhaar_payments WHERE phone = ?');

/** What a customer owes now, and their limit. phone: 10 digits. */
export function dueOf(phone) {
  const p = String(phone ?? '');
  const c = db.prepare('SELECT name, credit_limit FROM customers WHERE phone = ?').get(p);
  const g = given.get(p).v, r = received.get(p).v;
  return { phone: p, name: c?.name ?? '', given: g, received: r, due: g - r, limit: c?.credit_limit ?? null };
}

/** Called by createSale (inside its transaction) for a bill with an udhaar payment. */
export function checkUdhaar(phone, amount, who = {}) {
  if (!PHONE.test(String(phone ?? ''))) throw new Error("Udhaar needs the customer's mobile number on the bill");
  const d = dueOf(phone);
  if (d.limit != null && d.due + amount > d.limit && who.role === 'salesman')
    throw new Error(`Over ${d.name || 'this customer'}'s udhaar limit (${rs(d.limit)}; already owes ${rs(d.due)}). Ask the owner.`);
}

/** Customers who owe something (or have a limit), biggest first, and the total owed. */
export function udhaarList() {
  const rows = db.prepare(`
    SELECT c.phone, c.name, c.credit_limit,
      COALESCE((SELECT SUM(p.amount) FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE p.method = 'udhaar' AND s.customer_phone = c.phone), 0) AS given,
      COALESCE((SELECT SUM(u.amount) FROM udhaar_payments u WHERE u.phone = c.phone), 0) AS received,
      (SELECT MAX(s.sold_at) FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE p.method = 'udhaar' AND s.customer_phone = c.phone) AS last_udhaar,
      (SELECT MAX(u.created_at) FROM udhaar_payments u WHERE u.phone = c.phone) AS last_paid
    FROM customers c`).all()
    .map((r) => ({ ...r, due: r.given - r.received }))
    .filter((r) => r.due !== 0 || r.credit_limit != null)
    .sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));
  return { rows, total: rows.reduce((a, r) => a + Math.max(0, r.due), 0), customers: rows.filter((r) => r.due > 0).length };
}

/** One customer's udhaar account: every udhaar bill and payment received, oldest first, with the running balance. */
export function account(phone) {
  const d = dueOf(phone);
  const bills = db.prepare(`SELECT s.sold_at AS at, 'bill' AS kind, s.bill_no AS ref, p.amount, s.total
    FROM payments p JOIN sales s ON s.id = p.sale_id WHERE p.method = 'udhaar' AND s.customer_phone = ?
    ORDER BY s.sold_at, s.id`).all(d.phone);   // bills in the same second stay in the order they were made
  const pays = db.prepare(`SELECT created_at AS at, 'payment' AS kind, receipt_no AS ref, amount, method, note, made_by
    FROM udhaar_payments WHERE phone = ? ORDER BY created_at, id`).all(d.phone);
  let bal = 0;
  // by time; in the same second a bill before a payment, otherwise the order they were made (the sort keeps it)
  const history = [...bills, ...pays].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === 'bill' ? -1 : 1))
    .map((h) => { bal += h.kind === 'bill' ? h.amount : -h.amount; return { ...h, balance: bal }; });
  return { ...d, history };
}

/** Owner: payment received. pay = { amount (paise), method, note_no (credit note), note }. Returns the receipt number. */
export const receivePayment = db.transaction((phone, pay, who = {}, activeModes = []) => {
  assertWritable();
  const d = dueOf(phone);
  if (!PHONE.test(d.phone)) throw new Error('Choose a customer');
  const amount = Number(pay?.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter the amount received');
  if (amount > d.due) throw new Error(`${d.name || 'This customer'} owes only ${rs(Math.max(0, d.due))}`);
  const method = String(pay?.method ?? '');
  if (method === UDHAAR || !(method === 'credit_note' || activeModes.includes(method))) throw new Error('Choose how it was paid');
  const noteId = method === 'credit_note' ? useCredit(pay.note_no, amount) : null;
  const no = Number(getSetting('last_receipt_no') ?? 0) + 1;
  setSetting('last_receipt_no', no);
  db.prepare(`INSERT INTO udhaar_payments (receipt_no, phone, amount, method, credit_note_id, note, made_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(no, d.phone, amount, method, noteId, String(pay?.note ?? '').trim().slice(0, 100), who.name ?? 'Owner');
  return no;
});

/** Owner: a customer's credit limit in paise; null / '' = no limit. */
export function setLimit(phone, limit) {
  const p = String(phone ?? '');
  if (!db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(p)) throw new Error('Customer not found');
  const v = limit === null || limit === '' || limit === undefined ? null : Number(limit);
  if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error('Enter the limit in rupees, or leave it empty for no limit');
  db.prepare('UPDATE customers SET credit_limit = ? WHERE phone = ?').run(v, p);
  return dueOf(p);
}

/** A receipt, for printing: the payment, the customer and what is still owed after it. */
export function getReceipt(no) {
  const r = db.prepare(`SELECT u.*, c.name, x.note_no FROM udhaar_payments u LEFT JOIN customers c ON c.phone = u.phone
    LEFT JOIN returns x ON x.id = u.credit_note_id WHERE u.receipt_no = ?`).get(Number(String(no ?? '').replace(/^\s*rc[-\s]*/i, '')));
  if (!r) return null;
  const owedAfter = given.get(r.phone).v - db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM udhaar_payments WHERE phone = ? AND id <= ?').get(r.phone, r.id).v;
  return { ...r, owed_after: owedAfter, owed_before: owedAfter + r.amount };
}

/** Payments received in a period (sales report). */
export const receivedBetween = (from, to) => db.prepare(`SELECT u.receipt_no, u.created_at, u.phone, c.name, u.amount, u.method, u.made_by
  FROM udhaar_payments u LEFT JOIN customers c ON c.phone = u.phone WHERE date(u.created_at) BETWEEN ? AND ? ORDER BY u.receipt_no`).all(from, to);
