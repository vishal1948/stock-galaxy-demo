// Products and stock. Every product has ONE number, its Barcode (the "code" column): the maker's barcode on
// the tag or the shop's own number, scanned or typed. Barcodes linked to a product before 1.5.0 (the old
// product_barcodes table) still find it when scanned, so nothing a shop already labelled stops working.
import db from './db.js';
import { assertWritable } from './lock-state.js';
import { RATES, HSN } from './gst.js';
import { defaultsFor, withSubCategories, pathFinder } from './categories.js';

const BARCODE = /^[!-~]{1,40}$/;   // letters, digits and signs, no spaces (what scanners send)
const FIELD_MAX = 20;              // size / colour

// q: text to look for; category: a category id (its sub categories too), 'none' = items without one, '' = all
export function listProducts(q = '', category = '') {
  const cats = category && category !== 'none' ? withSubCategories(category) : null;
  const pathOf = pathFinder();
  return db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.colour, p.hsn, p.gst_rate, p.rate, p.category_id, COALESCE(SUM(m.qty), 0) AS stock
    FROM products p
    LEFT JOIN stock_movements m ON m.product_id = p.id
    WHERE p.active = 1 AND (p.code LIKE @like OR p.name LIKE @like OR p.size LIKE @like OR p.colour LIKE @like
      OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE @like))
      AND (@none = 0 OR p.category_id IS NULL)
      ${cats ? `AND p.category_id IN (${cats.map((c) => Number(c) || 0).join(',')})` : ''}
    GROUP BY p.id
    ORDER BY (p.code = @exact) DESC, p.name COLLATE NOCASE, p.size, p.colour, p.code
    LIMIT 500
  `).all({ like: `%${q}%`, exact: q, none: category === 'none' ? 1 : 0 })
    .map((p) => ({ ...p, category: pathOf(p.category_id) }));
}

// What a scanner (or typing) gives: the product's barcode (or one linked before 1.5.0). Returns the product or null.
export const findProduct = (scan) => {
  const v = String(scan ?? '').trim();
  if (!v) return null;
  return db.prepare(`
    SELECT p.id, p.code, p.name, p.size, p.colour, p.hsn, p.gst_rate, p.rate, p.category_id FROM products p
    WHERE p.active = 1 AND (p.code = @v OR p.id = (SELECT product_id FROM product_barcodes WHERE barcode = @v))
    ORDER BY (p.code = @v) DESC LIMIT 1`).get({ v }) ?? null;
};

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

// GST rate from Stock In: '' / null / 'auto' = garment rule; otherwise a percent like 5 or 12 -> 500 / 1200.
function parseRate(v, code) {
  if (v == null || v === '' || v === 'auto') return null;
  const bp = Math.round(Number(v) * 100);
  if (!RATES.includes(bp)) throw new Error(`GST rate for barcode "${code}" must be one of ${RATES.map((r) => r / 100).join(', ')} %`);
  return bp;
}

/** Stock In. items: [{ code (barcode), name, size, colour, hsn, gst_rate, qty, rate }].
 *  A new barcode needs a name. For a barcode already saved, the name stays; rate, size, colour, HSN and GST
 *  rate are updated when given (left empty = keep what is saved). All rows save together or none. */
export const addStock = db.transaction((items) => stockIn(items));

// Excel import (main/import.js): the same rules as Stock In, but Qty 0 is allowed - the item is saved
// with no stock (a shop can load its whole catalogue before counting).
export const importStock = db.transaction((items) => stockIn(items, { allowZero: true }));

function stockIn(items, { allowZero = false } = {}) {
  assertWritable();
  const find = db.prepare('SELECT id FROM products WHERE code = ?');
  const alias = db.prepare(`SELECT p.id, p.code, p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.barcode = ?`);
  const create = db.prepare('INSERT INTO products (code, name, size, colour, hsn, gst_rate, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const catOk = db.prepare('SELECT 1 FROM categories WHERE id = ? AND active = 1');
  const update = (field) => db.prepare(`UPDATE products SET ${field} = ? WHERE id = ?`);
  const set = { rate: update('rate'), size: update('size'), colour: update('colour'), hsn: update('hsn'), gst_rate: update('gst_rate'),
    category_id: update('category_id') };
  // every save is one stock entry: its rows share ref_id (entry number) so "last entry" can show them together
  const entry = db.prepare(
    "SELECT COALESCE(MAX(ref_id), 0) + 1 AS n FROM stock_movements WHERE type = 'stock_in'").get().n;
  const move = db.prepare("INSERT INTO stock_movements (product_id, qty, type, ref_id) VALUES (?, ?, 'stock_in', ?)");
  for (const it of items) {
    const { qty, rate } = it;
    let code = String(it.code ?? '').trim();
    if (!code || !Number.isInteger(qty) || qty < (allowZero ? 0 : 1)) throw new Error(`Invalid entry for barcode "${code}"`);
    // rate is in paise; leaving it out (null) keeps the rate already saved for that barcode
    if (rate != null && (!Number.isInteger(rate) || rate < 0)) throw new Error(`Invalid rate for barcode "${code}"`);
    const size = clean(it.size), colour = clean(it.colour), hsn = clean(it.hsn);
    if (size.length > FIELD_MAX || colour.length > FIELD_MAX) throw new Error(`Size and colour: ${FIELD_MAX} letters max (barcode "${code}")`);
    if (hsn && !HSN.test(hsn)) throw new Error(`HSN code for barcode "${code}" must be 4 to 8 digits`);
    // category: given (an id) -> must be switched on; its HSN / GST fill in what this row leaves empty
    const cat = it.category_id == null || it.category_id === '' ? null : Number(it.category_id);
    if (cat != null && !catOk.get(cat)) throw new Error(`The category for barcode "${code}" is not there or switched off`);
    const def = cat != null ? defaultsFor(cat) : { hsn: '', gst_rate: '' };
    const gstGiven = it.gst_rate != null && it.gst_rate !== '';
    const gst = parseRate(gstGiven ? it.gst_rate : def.gst_rate, code);
    let p = find.get(code);
    if (!p) {
      const old = alias.get(code);   // a barcode linked before 1.5.0: it is that product
      if (old) { p = { id: old.id }; code = old.code; }
    }
    if (!p) {
      // checked for new products only: numbers saved by older versions keep working as they are
      if (!BARCODE.test(code)) throw new Error(`Barcode "${code}" does not look right (no spaces, 40 characters max)`);
      if (!clean(it.name)) throw new Error(`New barcode "${code}" needs a name`);
      p = { id: create.run(code, clean(it.name), size, colour, hsn || def.hsn, gst, cat).lastInsertRowid };
    } else {
      if (size) set.size.run(size, p.id);
      if (colour) set.colour.run(colour, p.id);
      if (hsn) set.hsn.run(hsn, p.id);
      if (gstGiven) set.gst_rate.run(gst, p.id);
      if (cat != null) {
        set.category_id.run(cat, p.id);
        // the category's defaults fill an existing item's HSN / GST only where it has none of its own
        if (!hsn && def.hsn) db.prepare("UPDATE products SET hsn = ? WHERE id = ? AND hsn = ''").run(def.hsn, p.id);
      }
    }
    if (rate != null) set.rate.run(rate, p.id);
    if (qty > 0) move.run(p.id, qty, entry);
  }
}

// The most recent Stock In save, all its rows. Entries saved before entry numbers existed
// are grouped by their save time instead.
export function lastStockEntry() {
  const last = db.prepare(`SELECT ref_id, created_at FROM stock_movements
    WHERE type = 'stock_in' ORDER BY id DESC LIMIT 1`).get();
  if (!last) return null;
  const items = db.prepare(`
    SELECT p.code, p.name, p.size, p.colour, m.qty, p.rate FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'stock_in' AND ${last.ref_id == null ? 'm.ref_id IS NULL AND m.created_at = @created_at' : 'm.ref_id = @ref_id'}
    ORDER BY m.id`).all(last);
  return { at: last.created_at, items, units: items.reduce((a, i) => a + i.qty, 0) };
}

export const recentAdjustments = (limit = 10) =>
  db.prepare(`
    SELECT m.created_at, p.code, p.name, p.size, p.colour, m.qty, m.note
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'adjustment' ORDER BY m.id DESC LIMIT ?`).all(limit);

export const adjustStock = db.transaction(({ code, qty, note }) => {
  assertWritable();
  const p = findProduct(code);
  if (!p) throw new Error(`Barcode "${code}" not found`);
  if (!Number.isInteger(qty) || qty === 0) throw new Error('Enter a quantity above or below zero');
  if (!note?.trim()) throw new Error('Enter a reason');
  db.prepare(
    "INSERT INTO stock_movements (product_id, qty, type, note) VALUES (?, ?, 'adjustment', ?)"
  ).run(p.id, qty, note.trim());
});

export const recentMovements = (code) =>
  db.prepare(`
    SELECT m.created_at, m.type, m.qty, m.note, s.bill_no
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN sales s ON m.type = 'sale' AND s.id = m.ref_id
    WHERE p.id = ? ORDER BY m.id DESC LIMIT 20
  `).all(findProduct(code)?.id ?? -1);
