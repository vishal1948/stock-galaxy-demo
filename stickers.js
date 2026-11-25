// Barcode stickers on A4 sticker sheets (Products > Barcode stickers), printed on the shop's normal printer at
// 100% (actual size). Each sticker: the barcode (Code 128), the price and the barcode's number - nothing else.
// Scanning the sticker on Billing finds the item, so it is for items without a maker's barcode (or a damaged one).
// Default sheet: the shop's own A4 label sheet, 4 x 12 = 48 stickers, measured as 2 mm side margins, 3 mm top and
// bottom margins, no gap between rows and 1.5-2 mm (1.75 mm used) between columns. The sticker size follows from
// that: (210 - 2x2 - 3x1.75) / 4 = 50.19 mm wide, (297 - 2x3) / 12 = 24.25 mm tall.
// Also the usual pre-cut label sheets (Avery sizes). "Start at sticker" uses a part-used sheet; "move" shifts
// everything a little if a printer prints slightly off.
import { $, rupees, esc, errText } from './util.js';
import { code128Values, code128Svg } from './barcode.js';
import { shop, loadShop } from './shop.js';
import { resetPrintPage } from './bills.js';

// The shop's sheet, from its margins and gaps (mm)
const SHOP_SHEET = { across: 4, down: 12, side: 2, topBottom: 3, colGap: 1.75, rowGap: 0 };
const shopSheet = () => {
  const { across, down, side, topBottom, colGap, rowGap } = SHOP_SHEET;
  const w = (210 - 2 * side - (across - 1) * colGap) / across;
  const h = (297 - 2 * topBottom - (down - 1) * rowGap) / down;
  return [`Shop's sheet: 48 per sheet - ${w.toFixed(1)} x ${h.toFixed(2)} mm (4 x 12, 2 mm sides, 3 mm top/bottom)`,
    across, down, w, h, topBottom, side, w + colGap, h + rowGap];
};
// [label, across, down, sticker width, height, top margin, left margin, distance to next across, next down] in mm
export const SHEETS = {
  a4_48x24: shopSheet(),
  // standard pre-cut label sheets (Avery sizes)
  a4_65: ['Standard pre-cut: 65 per sheet - 38.1 x 21.2 mm (5 x 13)', 5, 13, 38.1, 21.2, 10.7, 4.65, 40.6, 21.2],
  a4_48: ['Standard pre-cut: 48 per sheet - 45.7 x 21.2 mm (4 x 12)', 4, 12, 45.7, 21.2, 21.6, 9.75, 48.3, 21.2],
  a4_40: ['Standard pre-cut: 40 per sheet - 45.7 x 25.4 mm (4 x 10)', 4, 10, 45.7, 25.4, 21.5, 9.75, 48.3, 25.4],
  a4_24: ['Standard pre-cut: 24 per sheet - 63.5 x 33.9 mm (3 x 8)', 3, 8, 63.5, 33.9, 12.9, 7.25, 66.0, 33.9],
  a4_21: ['Standard pre-cut: 21 per sheet - 63.5 x 38.1 mm (3 x 7)', 3, 7, 63.5, 38.1, 15.15, 7.25, 66.0, 38.1],
};
const sheetOf = (s = shop()) => SHEETS[s.sticker_sheet] ? s.sticker_sheet : 'a4_48x24';
const dims = (id) => SHEETS[id];
const perSheet = (id) => dims(id)[1] * dims(id)[2];

const queue = new Map();   // barcode -> { code, name, size, colour, rate, copies }
const msg = (t, ok) => { const m = $('#stkMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

function count() {
  const n = [...queue.values()].reduce((a, l) => a + l.copies, 0);
  const id = sheetOf();
  const start = Math.min(Math.max(1, Math.floor(Number($('#stkStart').value) || 1)), perSheet(id));
  const sheets = n ? Math.ceil((n + start - 1) / perSheet(id)) : 0;
  $('#stkTotal').textContent = n ? `${n} sticker(s) on ${sheets} sheet(s)` : 'No stickers yet - scan a barcode or add the last stock entry';
  $('#stkPrint').disabled = $('#stkPdf').disabled = !n;
  return { n, start, sheets };
}

function draw() {
  $('#stkRows').replaceChildren(...[...queue.values()].map((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(l.code)}</td><td>${esc(l.name)}</td><td>${esc(l.size)}</td><td>${esc(l.colour)}</td>
      <td class="num">${l.rate ? rupees(l.rate) : '-'}</td>
      <td class="num"><input class="copies" type="number" min="0" step="1" value="${l.copies}" /></td>
      <td><button class="rm" title="Remove">×</button></td>`;
    tr.querySelector('.copies').addEventListener('input', (e) => { l.copies = Math.max(0, Math.floor(Number(e.target.value) || 0)); count(); });
    tr.querySelector('.rm').addEventListener('click', () => { queue.delete(l.code); draw(); });
    return tr;
  }));
  $('#stkTable').hidden = !queue.size;
  count();
}

/** Adds stickers for items; copies add up if the item is already in the list. */
async function add(items) {
  let added = 0;
  for (const { code, copies } of items) {
    const p = await window.api.findProduct(code);
    if (!p) throw new Error(`Barcode "${code}" not found - add it in Stock In first`);
    code128Values(p.code);   // throws if the barcode has characters a sticker cannot hold
    const l = queue.get(p.code) ?? { code: p.code, name: p.name, size: p.size, colour: p.colour, rate: p.rate, copies: 0 };
    l.copies += Math.max(0, copies);
    queue.set(p.code, l);
    added += copies;
  }
  draw();
  return added;
}

// one sticker: the barcode, the price, and the barcode's number (small margins all round)
const stickerHtml = (l) => `<div class="stk-in">
  <div class="stk-bars">${code128Svg(l.code)}</div>
  ${l.rate ? `<div class="stk-mrp">₹ ${rupees(l.rate)}</div>` : ''}
  <div class="stk-code">${esc(l.code)}</div></div>`;

/** Fills the print area with the A4 sheets. */
function render() {
  const s = shop();
  const id = sheetOf(s);
  const [, across, down, w, h, top, left, px, py] = dims(id);
  const dx = Number(s.sticker_dx) || 0, dy = Number(s.sticker_dy) || 0;
  const { start } = count();
  const all = [...queue.values()].flatMap((l) => Array(l.copies).fill(l));
  const slots = [...Array(start - 1).fill(null), ...all];
  const pages = [];
  for (let i = 0; i < slots.length; i += across * down) pages.push(slots.slice(i, i + across * down));
  resetPrintPage();   // A4, also after a thermal receipt
  $('#printArea').innerHTML = pages.map((page) => `<div class="stk-page f-${id}">${page.map((l, k) => (l == null ? '' : `<div class="stk"
    data-x="${(left + dx + (k % across) * px).toFixed(2)}" data-y="${(top + dy + Math.floor(k / across) * py).toFixed(2)}"
    data-w="${w.toFixed(3)}" data-h="${h.toFixed(3)}">${stickerHtml(l)}</div>`)).join('')}</div>`).join('');
  // positions in mm (set here: the page's security rules allow no inline style attributes)
  for (const e of document.querySelectorAll('#printArea .stk')) {
    Object.assign(e.style, { left: `${e.dataset.x}mm`, top: `${e.dataset.y}mm`, width: `${e.dataset.w}mm`, height: `${e.dataset.h}mm` });
  }
}

async function out(kind) {
  if (!count().n) return;
  const btn = $(kind === 'pdf' ? '#stkPdf' : '#stkPrint');
  btn.disabled = true;
  try {
    render();
    if (kind === 'pdf') msg(`Saved and opened ${await window.api.saveStickerPdf()} - check it before printing on sticker sheets`, true);
    else {
      const r = await window.api.printStickers();
      msg(r.printed ? `Sent ${count().n} sticker(s) to the printer` : r.reason, !!r.printed);
    }
  } catch (e) { msg(errText(e), false); }
  finally { $('#printArea').replaceChildren(); btn.disabled = false; count(); }
}

// ---- the screen ----
function showSheet(s = shop()) {
  const id = sheetOf(s);
  const [, across, down, w, h] = dims(id);
  $('#stkSheet').value = id;
  $('#stkStart').max = perSheet(id);
  $('#stkDx').value = s.sticker_dx || '0';
  $('#stkDy').value = s.sticker_dy || '0';
  $('#stkSize').textContent = `${across} x ${down} = ${across * down} stickers per sheet, each ${w.toFixed(1)} x ${h.toFixed(2)} mm, printed at 100%`;
  count();
}
const saveSheet = async (o, done) => {
  try { await window.api.saveSettings(o); showSheet(await loadShop()); msg(done, true); }
  catch (e) { msg(errText(e), false); showSheet(); }
};

$('#stkSheet').innerHTML = Object.entries(SHEETS).map(([id, [label]]) => `<option value="${id}">${esc(label)}</option>`).join('');
$('#stkSheet').addEventListener('change', (e) => saveSheet({ sticker_sheet: e.target.value }, 'Sticker sheet saved'));
for (const [sel, key] of [['#stkDx', 'sticker_dx'], ['#stkDy', 'sticker_dy']])
  $(sel).addEventListener('change', (e) => saveSheet({ [key]: e.target.value.trim() || '0' }, 'Position saved'));
$('#stkStart').addEventListener('input', count);
$('#stkScan').addEventListener('keydown', async (e) => {   // a scanner types the barcode and presses Enter
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  if (!code) return;
  try { await add([{ code, copies: 1 }]); e.target.value = ''; msg('', true); }
  catch (err) { msg(errText(err), false); e.target.select(); }
});
$('#stkLast').addEventListener('click', async () => {
  try {
    const last = await window.api.lastStockEntry();
    if (!last) return msg('No stock entry yet', false);
    msg(`Added ${await add(last.items.map((i) => ({ code: i.code, copies: i.qty })))} sticker(s) from the last stock entry`, true);
  } catch (e) { msg(errText(e), false); }
});
$('#stkClear').addEventListener('click', () => { queue.clear(); draw(); msg('', true); });
$('#stkPdf').addEventListener('click', () => out('pdf'));
$('#stkPrint').addEventListener('click', () => out('print'));
document.querySelector('[data-view="products"]')?.addEventListener('click', () => showSheet());

// tests
window.__stickers = { add, render, count, clear: () => { queue.clear(); draw(); } };
draw();
