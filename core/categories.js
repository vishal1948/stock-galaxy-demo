// Product categories (Settings > Categories, owner only): a tree up to 3 levels, e.g.
//   Pants > Cargo pants > Rs 500-999
// An item belongs to one category (the deepest level chosen). A category can give default HSN and GST to new items
// under it; a sub category without its own uses its parent's. A category used by items is switched off, never
// deleted, so old bills and reports keep its name. Bills keep the category path they were sold with (sale_items).
import db from './db.js';
import { HSN, RATES } from './gst.js';

export const MAX_DEPTH = 3;
const SEP = ' > ';
const NAME_MAX = 40;

const all = () => db.prepare('SELECT * FROM categories ORDER BY sort, name COLLATE NOCASE').all();
const byIdMap = () => new Map(all().map((c) => [c.id, c]));

/** The chain from the top: [Pants, Cargo pants, Rs 500-999] (category rows). */
function chain(id, map = byIdMap()) {
  const out = [];
  for (let c = map.get(id), n = 0; c && n < 10; c = map.get(c.parent_id), n++) out.unshift(c);
  return out;
}
export const pathOf = (id, map) => (id ? chain(id, map).map((c) => c.name).join(SEP) : '');

/** The HSN and GST an item under this category gets by default (its own, else the nearest parent's). */
export function defaultsFor(id, map = byIdMap()) {
  const up = chain(id, map).reverse();
  return { hsn: up.find((c) => c.hsn)?.hsn ?? '', gst_rate: up.find((c) => c.gst_rate)?.gst_rate ?? '' };
}

/** Every category with its path, level (1-3), how many items use it (also through its sub categories). */
export function listCategories() {
  const map = byIdMap();
  const direct = Object.fromEntries(db.prepare(`SELECT category_id AS id, COUNT(*) AS n FROM products
    WHERE category_id IS NOT NULL AND active = 1 GROUP BY category_id`).all().map((r) => [r.id, r.n]));
  const rows = [...map.values()].map((c) => {
    const ch = chain(c.id, map);
    return { ...c, path: ch.map((x) => x.name).join(SEP), level: ch.length, items: direct[c.id] ?? 0,
      children: [...map.values()].filter((x) => x.parent_id === c.id).length, defaults: defaultsFor(c.id, map) };
  });
  // with sub categories' items added in
  for (const r of rows) r.allItems = rows.filter((x) => x.path === r.path || x.path.startsWith(r.path + SEP)).reduce((a, x) => a + x.items, 0);
  // tree order: each category followed by its sub categories
  return rows.sort((a, b) => comparePaths(a.path, b.path));
}

const levelOf = (id, map) => chain(id, map).length;
const depthBelow = (id, map) => {   // how many levels a category's sub tree has under it
  const kids = [...map.values()].filter((c) => c.parent_id === id);
  return kids.length ? 1 + Math.max(...kids.map((k) => depthBelow(k.id, map))) : 0;
};

function clean({ name, hsn, gst_rate }) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Enter the category name');
  if (n.length > NAME_MAX) throw new Error(`Category names: ${NAME_MAX} letters max`);
  if (n.includes('>')) throw new Error('A category name cannot contain ">"');
  const h = String(hsn ?? '').trim();
  if (h && !HSN.test(h)) throw new Error('The HSN code must be 4 to 8 digits');
  let g = String(gst_rate ?? '').trim().replace('%', '');
  if (g && g !== 'auto') {
    if (!RATES.includes(Math.round(Number(g) * 100))) throw new Error(`GST must be one of ${RATES.map((r) => r / 100).join(', ')} %`);
    g = String(Number(g));
  }
  return { name: n, hsn: h, gst_rate: g };
}
const unique = (e, name) => { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error(`"${name}" is already there at this level`); throw e; };

/** Adds a category (parentId null = a main category). Returns its id. */
export function addCategory({ name, parent_id = null, hsn = '', gst_rate = '' }) {
  const c = clean({ name, hsn, gst_rate });
  const map = byIdMap();
  const parent = parent_id == null || parent_id === '' ? null : Number(parent_id);
  if (parent != null && !map.has(parent)) throw new Error('That parent category is not there');
  if (parent != null && levelOf(parent, map) >= MAX_DEPTH) throw new Error(`Categories go ${MAX_DEPTH} levels deep at most`);
  try {
    return Number(db.prepare('INSERT INTO categories (name, parent_id, hsn, gst_rate) VALUES (?, ?, ?, ?)')
      .run(c.name, parent, c.hsn, c.gst_rate).lastInsertRowid);
  } catch (e) { return unique(e, c.name); }
}

/** Renames, moves (parent_id) or changes the defaults of a category; active switches it on or off. */
export function updateCategory(id, changes) {
  const map = byIdMap();
  const cur = map.get(Number(id));
  if (!cur) throw new Error('Category not found');
  const c = clean({ name: changes.name ?? cur.name, hsn: changes.hsn ?? cur.hsn, gst_rate: changes.gst_rate ?? cur.gst_rate });
  let parent = 'parent_id' in changes ? (changes.parent_id == null || changes.parent_id === '' ? null : Number(changes.parent_id)) : cur.parent_id;
  if (parent != null) {
    if (!map.has(parent)) throw new Error('That parent category is not there');
    if (parent === cur.id || chain(parent, map).some((x) => x.id === cur.id)) throw new Error('A category cannot go under itself or its own sub category');
    if (levelOf(parent, map) + 1 + depthBelow(cur.id, map) > MAX_DEPTH) throw new Error(`Categories go ${MAX_DEPTH} levels deep at most`);
  }
  const active = 'active' in changes ? (changes.active ? 1 : 0) : cur.active;
  try {
    db.prepare('UPDATE categories SET name = ?, parent_id = ?, hsn = ?, gst_rate = ?, active = ? WHERE id = ?')
      .run(c.name, parent, c.hsn, c.gst_rate, active, cur.id);
  } catch (e) { unique(e, c.name); }
}

/** Deletes a category nobody uses (no items, no sub categories). Otherwise: switch it off. */
export function deleteCategory(id) {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id));
  if (!c) throw new Error('Category not found');
  if (db.prepare('SELECT 1 FROM categories WHERE parent_id = ?').get(c.id)) throw new Error(`"${c.name}" has sub categories - delete or move them first`);
  if (db.prepare('SELECT 1 FROM products WHERE category_id = ?').get(c.id)) throw new Error(`Items use "${c.name}" - switch it off instead`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
}

/** "Pants > Cargo pants" (also "/" or "»" between levels, any case) -> category id, or null. */
export function findByPath(text) {
  const parts = String(text ?? '').split(/\s*(?:>|»|\/)\s*/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  let parent = null, found = null;
  for (const p of parts) {
    found = db.prepare(`SELECT id FROM categories WHERE COALESCE(parent_id, 0) = ? AND lower(name) = ?`).get(parent ?? 0, p);
    if (!found) return null;
    parent = found.id;
  }
  return found.id;
}

/** This category and every category under it (for "show me all Pants"). */
export function withSubCategories(id) {
  const map = byIdMap();
  const out = [Number(id)];
  for (let i = 0; i < out.length; i++) for (const c of map.values()) if (c.parent_id === out[i]) out.push(c.id);
  return out;
}

/** Products > Set category: gives these items one category (null = no category). Returns how many changed. */
export function setCategory(codes, id) {
  const cat = id == null || id === '' ? null : Number(id);
  if (cat != null && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND active = 1').get(cat)) throw new Error('Choose a category that is switched on');
  const list = (Array.isArray(codes) ? codes : []).map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('Tick the items first');
  const upd = db.prepare('UPDATE products SET category_id = ? WHERE code = ?');
  return db.transaction(() => list.reduce((n, code) => n + upd.run(cat, code).changes, 0))();
}

/** A bill line's category as it shows on the bill: the first two levels ("Pants · Cargo pants"). */
export const billCategory = (path) => String(path ?? '').split(SEP).slice(0, 2).join(' · ');

/** For long lists: reads the tree once, then gives each category id's path. */
export function pathFinder() {
  const map = byIdMap();
  return (id) => pathOf(id, map);
}

/** Tree order for paths: level by level, numbers as numbers (Rs 500-999 before Rs 1000-1999), a category before its sub categories. */
export function comparePaths(a, b) {
  const x = String(a).split(SEP), y = String(b).split(SEP);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i], 'en', { numeric: true, sensitivity: 'base' });
    if (c) return c;
  }
  return x.length - y.length;
}
