import db from './db.js';
import { assertWritable, isFeatureOn, blockedModes } from './lock-state.js';
import { PAYMENT_CATALOG, CATALOG_BY_ID } from './payment-catalog.js';
import { splitTax, GSTIN, HSN } from './gst.js';
import { makeReturn, useCredit } from './returns.js';
import { checkUdhaar } from './udhaar.js';
import { pathOf } from './categories.js';

const KEYS = ['shop_name', 'shop_tagline', 'shop_address', 'shop_phones', 'gstin', 'bill_footer', 'last_bill_no',
  'whatsapp_billing', 'barcode_billing', 'shop_logo', 'payment_modes', 'bill_theme', 'print_bills', 'bill_format', 'printer_name',
  'gst_billing', 'gst_default_hsn', 'return_days', 'sticker_sheet', 'sticker_dx', 'sticker_dy'];
const BILL_THEMES = ['indigo', 'orange', 'green', 'maroon', 'black'];
const BILL_FORMATS = ['a4', 'thermal_80', 'thermal_58'];
const MAX_OWN_MODES = 20;   // modes a shop adds itself, on top of the built-in list
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 400_000;   // characters; the app shrinks logos well below this
const SWITCHES = ['whatsapp_billing', 'barcode_billing', 'print_bills', 'gst_billing'];   // '1' = on, '0' = off
const OFF_UNTIL_SET = ['gst_billing'];   // off until the shop switches it on; the others start on
// never sent to the screens (login PINs are checked in main/users.js)
const SECRET = new Set(['owner_pin', 'owner_recovery']);
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

// Indian mobile: 10 digits starting 6-9; a leading +91 / 91 / 0 is dropped. Empty is allowed.
export const normalizePhone = (v) => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new Error('Enter a valid 10-digit mobile number');
  return d;
};

// Each shop's payment modes: [{ id, label, active, group }] - what the shop saved (its switches, its own modes,
// a label it kept from before) plus every built-in mode it has not switched on yet (payment-catalog.js).
// A mode used on old bills is switched off, never deleted, so those bills and reports still show its name.
// A mode the vendor blocked (control server) is off with blocked: true, whatever the shop saved.
export function paymentModes() {
  const blocked = blockedModes();
  return savedModes().map((m) => (blocked.has(m.id) ? { ...m, active: false, blocked: true } : m));
}
function savedModes() {
  let saved = [];
  try { const l = JSON.parse(getSetting.get('payment_modes')?.value ?? 'null'); if (Array.isArray(l)) saved = l; } catch { /* none */ }
  // "credit_note" is not a mode the shop switches: credit notes from returns are always a choice on Billing (1.5.3)
  saved = saved.filter((m) => m.id !== 'credit_note');
  if (!saved.length) saved = PAYMENT_CATALOG.filter((m) => m.on).map((m) => ({ id: m.id, label: m.label, active: true }));
  const byId = Object.fromEntries(saved.map((m) => [m.id, m]));
  // built-in modes in the catalog's order (keeping a label the shop had before), then the shop's own
  return [
    ...PAYMENT_CATALOG.map((c) => ({ id: c.id, label: byId[c.id]?.label ?? c.label, active: byId[c.id] ? byId[c.id].active !== false : false, group: c.group })),
    ...saved.filter((m) => !CATALOG_BY_ID[m.id]).map((m) => ({ id: m.id, label: m.label, active: m.active !== false, group: 'own' })),
  ];
}

function checkModes(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Keep at least one payment mode');
  if (list.filter((m) => !CATALOG_BY_ID[m?.id]).length > MAX_OWN_MODES) throw new Error(`You can add up to ${MAX_OWN_MODES} payment modes of your own`);
  const ids = new Set();
  const blocked = blockedModes();
  const clean = list.map((m) => {
    const label = String(m?.label ?? '').trim().replace(/\s+/g, ' ');
    if (!label || label.length > 30) throw new Error('Each payment mode needs a name (30 letters max)');
    if (!/^[a-z0-9_]{1,30}$/.test(String(m?.id)) || ids.has(m.id)) throw new Error('Invalid payment mode');
    ids.add(m.id);
    if (blocked.has(m.id) && m.active !== false) throw new Error(`${label} is switched off by your vendor`);
    return { id: m.id, label, active: m.active !== false };
  });
  if (!clean.some((m) => m.active)) throw new Error('Keep at least one payment mode switched on');
  const labels = clean.filter((m) => m.active).map((m) => m.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error('Two payment modes have the same name');
  // built-in modes always come back (switched off); a mode the shop added itself must never vanish from old bills
  for (const old of paymentModes())
    if (!ids.has(old.id) && !CATALOG_BY_ID[old.id]) throw new Error(`"${old.label}" is on saved bills - switch it off instead of removing it`);
  return JSON.stringify(clean);
}

// s: the bill from the Billing screen. who: the person logged in ({ role, id, name }); a logged-in salesman's bills
// are always his own. s.exchange = { bill_no, items: [{ sale_item_id, qty }] }: items coming back from an old bill -
// their credit note pays this bill first (any rest stays on the credit note). s.payments may use an older credit
// note: { method: 'credit_note', note_no, amount }.
export const createSale = db.transaction((s, who = {}) => {
  assertWritable();
  if (who.salesmanId) who = { role: 'salesman', id: who.salesmanId, name: who.name };   // older callers
  if (who.role === 'salesman') s = { ...s, salesman_id: who.id };
  const st = getSettings();
  const gstOn = st.gst_billing === '1';
  const customerGstin = gstOn ? String(s.customer_gstin ?? '').trim().toUpperCase() : '';
  if (customerGstin && !GSTIN.test(customerGstin)) throw new Error("The customer's GSTIN does not look right (15 characters, e.g. 27ABCDE1234F1Z5)");
  const interstate = gstOn && !!s.interstate;
  const customerName = String(s.customer_name ?? '').trim().replace(/\s+/g, ' ');
  if (customerName.length > 60) throw new Error('Customer name is too long (60 letters max)');
  const customerPhone = normalizePhone(s.customer_phone);
  const items = s.items ?? [];
  if (!items.length) throw new Error('Add at least one item');
  if (!db.prepare('SELECT 1 FROM salesmen WHERE id = ? AND active = 1').get(s.salesman_id))
    throw new Error('Select a salesman');

  const findProduct = db.prepare('SELECT id, size, colour, hsn, gst_rate, category_id FROM products WHERE code = ? AND active = 1');
  let subtotal = 0;
  const lines = items.map((i) => {
    const qty = Number(i.qty), price = Number(i.price);
    if (!i.code?.trim() || !i.description?.trim()) throw new Error('Every line needs a barcode and description');
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Invalid quantity for ${i.code}`);
    if (!Number.isInteger(price) || price < 0) throw new Error(`Invalid price for ${i.code}`);
    const p = findProduct.get(i.code.trim());
    if (!p) throw new Error(`Barcode "${i.code}" is not in the product list`);
    subtotal += qty * price;
    // size, colour, HSN and GST rate come from the product as it is now and stay on the bill as they were
    return { product_id: p.id, code: i.code.trim(), description: i.description.trim(), qty, price, amount: qty * price,
      size: p.size, colour: p.colour, hsn: p.hsn || st.gst_default_hsn || '', fixedRate: p.gst_rate, category: pathOf(p.category_id) };
  });

  const discount = Number(s.discount ?? 0);
  if (!Number.isInteger(discount) || discount < 0 || discount > subtotal) throw new Error('Invalid discount');
  const total = subtotal - discount;
  if (total <= 0) throw new Error('Bill total must be above zero');
  const tax = gstOn ? splitTax(lines, discount, interstate) : null;

  // exchange: the items coming back become a credit note that pays this bill first
  const exchange = s.exchange?.bill_no ? makeReturn(s.exchange.bill_no, s.exchange.items, who) : null;
  const credit = exchange ? Math.min(exchange.amount, total) : 0;

  const pays = s.payments ?? [];
  const methods = paymentModes().filter((m) => m.active).map((m) => m.id);
  if ((!pays.length && credit < total) || pays.some((p) => !(methods.includes(p.method) || p.method === 'credit_note')
    || !Number.isInteger(p.amount) || p.amount <= 0)) throw new Error('Invalid payment entry');
  if (credit + pays.reduce((a, p) => a + p.amount, 0) !== total)
    throw new Error(credit ? 'Payments must add up to the bill total less the exchange credit' : 'Payments must add up to the bill total');
  // older credit notes used as payment: their balance goes down
  const notes = pays.map((p) => (p.method === 'credit_note' ? useCredit(p.note_no, p.amount) : null));
  // udhaar (pay later): needs the customer's mobile; over their credit limit only the owner may give it
  const udhaar = pays.filter((p) => p.method === 'udhaar').reduce((a, p) => a + p.amount, 0);
  if (udhaar) checkUdhaar(customerPhone, udhaar, who);

  const billNo = Number(getSetting.get('last_bill_no').value) + 1;
  setSetting.run('last_bill_no', String(billNo));
  const saleId = db
    .prepare(`INSERT INTO sales (bill_no, salesman_id, subtotal, discount, total, customer_name, customer_phone,
      gst, customer_gstin, supply_state, taxable, cgst, sgst, igst) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(billNo, s.salesman_id, subtotal, discount, total, customerName, customerPhone,
      gstOn ? 1 : 0, customerGstin,
      // place of supply: the shop's state for a sale at the counter; the customer's (from the GSTIN) for IGST
      gstOn ? (interstate && customerGstin ? customerGstin.slice(0, 2) : String(st.gstin).slice(0, 2)) : '',
      tax?.taxable ?? 0, tax?.cgst ?? 0, tax?.sgst ?? 0, tax?.igst ?? 0).lastInsertRowid;

  const addItem = db.prepare(`INSERT INTO sale_items
    (sale_id, product_id, code, description, qty, price, amount, size, colour, hsn, gst_rate, taxable, cgst, sgst, igst, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const move = db.prepare("INSERT INTO stock_movements (product_id, qty, type, ref_id) VALUES (?, ?, 'sale', ?)");
  for (const [n, l] of lines.entries()) {
    const t = tax?.lines[n] ?? { rate: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    addItem.run(saleId, l.product_id, l.code, l.description, l.qty, l.price, l.amount, l.size, l.colour, gstOn ? l.hsn : '',
      t.rate, t.taxable, t.cgst, t.sgst, t.igst, l.category);   // the category as it was when sold
    move.run(l.product_id, -l.qty, saleId);
  }
  const addPay = db.prepare('INSERT INTO payments (sale_id, method, amount, credit_note_id) VALUES (?, ?, ?, ?)');
  if (credit) {
    addPay.run(saleId, 'credit_note', credit, exchange.id);
    db.prepare('UPDATE returns SET balance = balance - ?, exchange_sale_id = ? WHERE id = ?').run(credit, saleId, exchange.id);
  }
  for (const [n, p] of pays.entries()) addPay.run(saleId, p.method, p.amount, notes[n]);
  if (customerPhone) saveCustomer.run(customerPhone, customerName);
  return billNo;
});

// A blank name on a later bill keeps the name already saved for that mobile number.
const saveCustomer = db.prepare(`INSERT INTO customers (phone, name, visits) VALUES (?, ?, 1)
  ON CONFLICT(phone) DO UPDATE SET
    name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
    visits = customers.visits + 1, last_seen = datetime('now','localtime')`);

// Full customer list for the Customers CSV: total spent and bill count come from the bills themselves.
export const listCustomers = () => db.prepare(`
  SELECT c.name, c.phone, COUNT(s.id) AS bills, COALESCE(SUM(s.total), 0) AS spent,
    MIN(s.sold_at) AS first_bill, MAX(s.sold_at) AS last_bill,
    COALESCE((SELECT SUM(p.amount) FROM payments p JOIN sales x ON x.id = p.sale_id
      WHERE p.method = 'udhaar' AND x.customer_phone = c.phone), 0)
      - COALESCE((SELECT SUM(u.amount) FROM udhaar_payments u WHERE u.phone = c.phone), 0) AS udhaar_due
  FROM customers c LEFT JOIN sales s ON s.customer_phone = c.phone
  GROUP BY c.phone ORDER BY c.name COLLATE NOCASE, c.phone`).all();

// Suggestions while typing: digits match the start of the mobile number, letters match any part of the name.
export const searchCustomers = (q) => {
  const text = String(q ?? '').trim();
  const digits = text.replace(/\D/g, '');
  const like = (s) => s.replace(/[\\%_]/g, '\\$&');
  if (/^[\d\s+-]+$/.test(text)) {
    if (digits.length < 2) return [];
    const d = text.startsWith('+') || digits.length > 10 ? digits.replace(/^(91|0)/, '') : digits.replace(/^0/, '');
    return db.prepare(`SELECT phone, name FROM customers WHERE phone LIKE ? ESCAPE '\\'
      ORDER BY last_seen DESC LIMIT 8`).all(like(d) + '%');
  }
  if (text.length < 2) return [];
  return db.prepare(`SELECT phone, name FROM customers WHERE name LIKE ? ESCAPE '\\'
    ORDER BY (name LIKE ? ESCAPE '\\') DESC, last_seen DESC LIMIT 8`).all(`%${like(text)}%`, `${like(text)}%`);
};

export const getSale = (billNo) => {
  const sale = db.prepare(`SELECT s.*, m.name AS salesman FROM sales s
    JOIN salesmen m ON m.id = s.salesman_id WHERE s.bill_no = ?`).get(billNo);
  if (!sale) return null;
  sale.items = db.prepare(
    `SELECT code, description, qty, price, amount, size, colour, hsn, gst_rate, taxable, cgst, sgst, igst, category
     FROM sale_items WHERE sale_id = ? ORDER BY id`).all(sale.id);
  // a credit note payment names its credit note (CN-<note_no>)
  sale.payments = db.prepare(`SELECT p.method, p.amount, r.note_no FROM payments p LEFT JOIN returns r ON r.id = p.credit_note_id
    WHERE p.sale_id = ? ORDER BY p.id`).all(sale.id).map(({ note_no, ...p }) => (note_no == null ? p : { ...p, note_no }));
  // an exchange bill: the items that came back for it; and the credit notes made from this bill's items
  sale.exchange = db.prepare(`SELECT r.note_no, r.amount, r.balance, s.bill_no FROM returns r JOIN sales s ON s.id = r.sale_id
    WHERE r.exchange_sale_id = ?`).get(sale.id) ?? null;
  if (sale.exchange) sale.exchange.items = db.prepare(`SELECT ri.code, ri.description, ri.size, ri.colour, ri.qty, ri.amount
    FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.exchange_sale_id = ? ORDER BY ri.id`).all(sale.id);
  sale.returns = db.prepare('SELECT note_no, created_at, amount, balance FROM returns WHERE sale_id = ? ORDER BY id').all(sale.id);
  return sale;
};

export const recentBills = (limit = 10) =>
  db.prepare(`
    SELECT s.bill_no, s.sold_at, s.customer_name, s.customer_phone, s.total, m.name AS salesman,
      (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = s.id) AS units
    FROM sales s JOIN salesmen m ON m.id = s.salesman_id
    ORDER BY s.bill_no DESC LIMIT ?`).all(limit);

export const listSalesmen = () =>
  db.prepare('SELECT id, name FROM salesmen WHERE active = 1 ORDER BY name').all();

export const addSalesman = (name) => {
  const n = name?.trim();
  if (!n) throw new Error('Enter a name');
  try {
    return Number(db.prepare('INSERT INTO salesmen (name) VALUES (?)').run(n).lastInsertRowid);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('Salesman already exists');
    throw e;
  }
};

export const listAllSalesmen = () =>
  db.prepare("SELECT id, name, active, pin <> '' AS has_pin FROM salesmen ORDER BY active DESC, name").all();

export const setSalesmanActive = (id, active) => {
  const r = db.prepare('UPDATE salesmen SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (!r.changes) throw new Error('Salesman not found');
};

// switches the vendor can block from the control server (blocked = off, the shop cannot switch it on)
const VENDOR_SWITCHES = ['whatsapp_billing', 'barcode_billing', 'gst_billing'];
const blockedSwitches = () => VENDOR_SWITCHES.filter((k) => !isFeatureOn(k));

export const getSettings = () => {
  const blocked = blockedSwitches();
  return {
    ...Object.fromEntries(SWITCHES.map((k) => [k, OFF_UNTIL_SET.includes(k) ? '0' : '1'])),
    bill_format: 'a4', printer_name: '', gst_default_hsn: '', login_on: '0', return_days: '7',
    // barcode stickers: the shop's A4 label sheet, 4 x 12 (2 mm sides, 3 mm top/bottom, 1.75 mm between columns), not moved
    sticker_sheet: 'a4_48x24', sticker_dx: '0', sticker_dy: '0',
    ...Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().filter((r) => !SECRET.has(r.key)).map((r) => [r.key, r.value])),
    ...Object.fromEntries(blocked.map((k) => [k, '0'])),
    blocked_features: JSON.stringify(blocked),
    payment_modes: JSON.stringify(paymentModes()),   // the full list with built-in modes and their groups
  };
};

export const saveSettings = db.transaction((obj) => {
  const maxBill = db.prepare('SELECT COALESCE(MAX(bill_no), 0) AS m FROM sales').get().m;
  for (let [k, v] of Object.entries(obj)) {
    if (!KEYS.includes(k)) continue;
    if (SWITCHES.includes(k) && !['0', '1'].includes(String(v))) throw new Error('Invalid on/off setting');
    if (VENDOR_SWITCHES.includes(k) && String(v) === '1' && !isFeatureOn(k)) throw new Error('This is switched off by your vendor');
    if (k === 'last_bill_no' && (!Number.isInteger(Number(v)) || Number(v) < maxBill))
      throw new Error(`Last bill number must be a whole number, ${maxBill} or higher`);
    if (k === 'shop_name' && !String(v).trim()) throw new Error('Enter the shop name');
    if (k === 'bill_theme' && !BILL_THEMES.includes(String(v))) throw new Error('Unknown bill colour');
    if (k === 'bill_format' && !BILL_FORMATS.includes(String(v))) throw new Error('Unknown bill format');
    if (k === 'printer_name' && String(v).length > 200) throw new Error('Printer name is too long');
    if (k === 'gstin') {
      v = String(v).trim().toUpperCase();
      if (v && !GSTIN.test(v)) throw new Error('The GSTIN does not look right (15 characters, e.g. 27ABCDE1234F1Z5)');
    }
    if (k === 'gst_default_hsn' && String(v).trim() && !HSN.test(String(v).trim())) throw new Error('The HSN code must be 4 to 8 digits');
    if (k === 'return_days' && !/^\d{1,3}$/.test(String(v).trim())) throw new Error('Return days must be a whole number from 0 to 999 (0 = no limit)');
    if (k === 'sticker_sheet' && !/^a4_(\d{2}|48x24)$/.test(String(v))) throw new Error('Unknown sticker sheet');
    if ((k === 'sticker_dx' || k === 'sticker_dy') && !(String(v).trim() !== '' && Math.abs(Number(v)) <= 10))
      throw new Error('Move the stickers by -10 to 10 mm');
    if (k === 'shop_logo' && v !== '' && !String(v).startsWith('legacy:') && (!LOGO.test(String(v)) || String(v).length > MAX_LOGO))
      throw new Error('The logo must be a PNG or JPG picture');
    if (k === 'payment_modes') { setSetting.run(k, checkModes(typeof v === 'string' ? JSON.parse(v) : v)); continue; }
    setSetting.run(k, String(v));
  }
  // GST billing needs the shop's own GSTIN (it prints on every tax invoice and gives the shop's state)
  const now = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key IN ('gst_billing', 'gstin')").all().map((r) => [r.key, r.value]));
  if (now.gst_billing === '1' && !GSTIN.test(now.gstin ?? '')) throw new Error("Enter the shop's GSTIN in Shop details first - GST billing needs it");
});

// First start of a new install: shop details + the first salesman, all at once.
export const completeSetup = db.transaction((o) => {
  const name = String(o?.shop_name ?? '').trim();
  if (!name) throw new Error('Enter the shop name');
  const salesman = String(o?.salesman ?? '').trim();
  const haveSalesman = db.prepare('SELECT 1 FROM salesmen WHERE active = 1').get();
  if (!salesman && !haveSalesman) throw new Error('Enter at least one salesman (it can be your own name)');
  const firstBill = o?.first_bill_no === '' || o?.first_bill_no == null ? 1 : Number(o.first_bill_no);
  if (!Number.isInteger(firstBill) || firstBill < 1) throw new Error('The first bill number must be 1 or more');
  const fields = Object.fromEntries(['shop_name', 'shop_tagline', 'shop_address', 'shop_phones', 'gstin', 'shop_logo']
    .filter((k) => o[k] != null).map((k) => [k, o[k]]));
  saveSettings({ ...fields, shop_name: name, last_bill_no: String(firstBill - 1) });
  if (salesman && !db.prepare('SELECT 1 FROM salesmen WHERE name = ?').get(salesman)) addSalesman(salesman);
});
