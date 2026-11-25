import { $, esc, errText, toPaise, rupees, when } from './util.js';
import { onPage } from './page.js';
import './scan.js';   // scanner-first Billing and Stock In
import { loadFeatures, isOn } from './features.js';
import { isOwner, signedIn } from './session.js';
import { rateText, RATES } from './gst.js';
import { catIdByPath, pathById, defaultsOf, showTicked } from './categories.js';

// ---- sidebar: ☰ collapses it to icons only; remembered on this PC ----
const applySide = (collapsed) => {
  document.body.classList.toggle('side-collapsed', collapsed);
  $('#sideToggle').title = collapsed ? 'Show the menu names' : 'Hide the menu names';
};
try { applySide(localStorage.getItem('sg.side') === 'collapsed'); } catch { /* default: open */ }
$('#sideToggle').addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('side-collapsed');
  applySide(collapsed);
  try { localStorage.setItem('sg.side', collapsed ? 'collapsed' : 'open'); } catch { /* not critical */ }
});

// ---- tabs ----
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab, .view').forEach((e) => e.classList.remove('active'));
    t.classList.add('active');
    $('#' + t.dataset.view).classList.add('active');
    if (t.dataset.view === 'products') loadProducts();
  })
);

// ---- products ----
const cell = (text, cls) => {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};

async function loadProducts() {
  const rows = await window.api.listProducts($('#search').value.trim(), $('#prodCat').value);
  const body = $('#productRows');
  body.replaceChildren(...rows.map((p) => {
    const tr = document.createElement('tr');
    // a tick box per item, for "Set category" on many items at once
    const tick = document.createElement('td');
    tick.className = 'tick';
    const box = document.createElement('input');
    Object.assign(box, { type: 'checkbox', className: 'tick' });
    box.dataset.code = p.code;
    tick.append(box);
    tr.append(tick, cell(p.code), cell(p.name), cell(p.category ? p.category.replace(/ > /g, ' › ') : '-', p.category ? 'cat' : 'dim'),
      cell(p.size), cell(p.colour), cell(p.hsn, 'gst-only'),
      cell(p.gst_rate == null ? 'Garment' : rateText(p.gst_rate), 'gst-only'), cell(p.rate ? rupees(p.rate) : '-', 'num'),
      cell(p.stock, p.stock <= 0 ? 'num low' : 'num'));
    return tr;
  }));
  $('#prodTickAll').checked = false;
  showTicked();
}
$('#prodCat').addEventListener('change', loadProducts);
$('#prodTickAll').addEventListener('change', (e) => {
  for (const b of document.querySelectorAll('#productRows input.tick')) b.checked = e.target.checked;
  showTicked();
});
document.addEventListener('products-changed', loadProducts);   // after "Set category"

let timer;
$('#search').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(loadProducts, 200);
});

// ---- stock in ----
// Columns: barcode (scanned from the tag, or the shop's own number), name, size, colour, HSN and GST (only with
// GST billing on), qty, selling rate. A barcode already saved fills its row; Enter moves to the next box.
const GST_OPTIONS = '<option value="auto">Garment</option>'
  + RATES.map((r) => `<option value="${r / 100}">${rateText(r)}</option>`).join('');
function addRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="code" placeholder="Scan or type" /></td>
    <td><input class="name" /></td>
    <td class="catc"><input class="cat" list="catPaths" placeholder="Type to find" autocomplete="off" /></td>
    <td class="sc"><input class="size" maxlength="20" placeholder="M, 32, XL" /></td>
    <td class="sc"><input class="colour" maxlength="20" /></td>
    <td class="hsn gst-only"><input class="hsnv" maxlength="8" inputmode="numeric" /></td>
    <td class="gstc gst-only"><select class="gst">${GST_OPTIONS}</select></td>
    <td class="num"><input class="qty" type="number" min="1" step="1" /></td>
    <td class="num"><input class="rate" type="number" min="0" step="0.01" /></td>
    <td><button class="rm" title="Remove">×</button></td>`;
  const code = tr.querySelector('.code');
  const name = tr.querySelector('.name');
  const rate = tr.querySelector('.rate');
  const box = (c) => tr.querySelector(c);

  const fill = (hit) => {
    name.value = hit ? hit.name : name.value;
    name.disabled = !!hit;   // a saved barcode: its name is locked
    name.placeholder = hit ? '' : 'New product name';
    // what is saved shows; changing it here updates the product (the rate is also the one Billing uses)
    if (hit) {
      for (const [c, v] of [['.size', hit.size], ['.colour', hit.colour], ['.hsnv', hit.hsn]]) if (box(c).value === '') box(c).value = v ?? '';
      box('.gst').value = hit.gst_rate == null ? 'auto' : String(hit.gst_rate / 100);
      if (box('.cat').value === '' && hit.category_id) box('.cat').value = pathById(hit.category_id);
    }
    if (hit?.rate && rate.value === '') rate.value = (hit.rate / 100).toFixed(2);
    rate.placeholder = hit?.rate ? '' : 'Selling rate';
  };
  let looked = '';   // the scan's Enter and the blur that follows must not look it up twice
  const fromCode = async () => {
    const c = code.value.trim();
    if (!c || c === looked) return null;
    looked = c;
    const hit = await window.api.findProduct(c);
    if (hit && hit.code !== c) { code.value = hit.code; looked = hit.code; }   // a barcode linked before 1.5.0
    fill(hit);
    return hit;
  };
  code.addEventListener('blur', fromCode);
  // a category picked: its HSN fills an empty HSN box, its GST the GST box (both can still be changed)
  box('.cat').addEventListener('change', () => {
    const id = catIdByPath(box('.cat').value);
    box('.cat').classList.toggle('bad', id === undefined);
    if (!id) return;
    const d = defaultsOf(id);
    if (d.hsn && !box('.hsnv').value) box('.hsnv').value = d.hsn;
    if (d.gst_rate) box('.gst').value = d.gst_rate;
  });
  // a scan ends with Enter: a known item goes straight to Qty, a new one to its name
  code.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!code.value.trim()) return;
    await fromCode();
    (name.disabled ? box('.qty') : name).focus();
  });
  tr.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const boxes = [...tr.querySelectorAll('input')].filter((i) => !i.disabled && i.offsetParent !== null);
    const next = boxes[boxes.indexOf(e.target) + 1];
    if (next) next.focus();
    else addRow();
  });
  box('.rm').addEventListener('click', () => tr.remove());
  $('#entryRows').append(tr);
  code.focus();
}

function setMsg(text, ok) {
  const m = $('#msg');
  m.textContent = text;
  m.className = ok ? 'ok' : 'err';
}

$('#addRow').addEventListener('click', addRow);

$('#save').addEventListener('click', async () => {
  const items = [...$('#entryRows').children]
    .map((tr) => ({
      code: tr.querySelector('.code').value.trim(),
      name: tr.querySelector('.name').value.trim(),
      size: tr.querySelector('.size').value.trim(),
      colour: tr.querySelector('.colour').value.trim(),
      category: tr.querySelector('.cat').value.trim(),
      // GST columns count only while GST billing is on (hidden otherwise)
      ...(isOn('gst') ? { hsn: tr.querySelector('.hsnv').value.trim(), gst_rate: tr.querySelector('.gst').value } : {}),
      qty: Number(tr.querySelector('.qty').value),
      rate: tr.querySelector('.rate').value === '' ? null : toPaise(tr.querySelector('.rate').value),
    }))
    .filter((i) => i.code || i.qty)
    // the category typed or picked -> its id; empty = keep the item's category as it is
    .map(({ category, ...i }) => ({ ...i, ...(category ? { category_id: catIdByPath(category) ?? -1, categoryText: category } : {}) }));
  const badCat = items.find((i) => i.category_id === -1);
  if (badCat) return setMsg(`Category "${badCat.categoryText}" not found - pick one from the list (Settings > Categories adds new ones)`, false);

  if (!items.length) return setMsg('Add at least one item', false);
  try {
    await window.api.addStock(items);
    $('#entryRows').replaceChildren();
    addRow();
    loadLastEntry();
    setMsg(`Saved ${items.length} item(s)`, true);
  } catch (e) {
    setMsg(errText(e), false);
  }
});

// ---- last stock entry: every row of the most recent save ----
async function loadLastEntry() {
  const e = await window.api.lastStockEntry();
  $('#lastEntry').innerHTML = !e ? '<p class="note">No stock entered yet.</p>'
    : `<p class="note">Saved ${esc(when(e.at))} · ${e.items.length} line(s) · ${e.units} unit(s)</p>
      <table><thead><tr><th>Barcode</th><th>Name</th><th>Size</th><th>Colour</th><th class="num">Qty</th><th class="num">Rate ₹</th></tr></thead><tbody>${
        e.items.map((i) => `<tr><td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.size)}</td><td>${esc(i.colour)}</td><td class="num">${i.qty}</td>
          <td class="num">${i.rate ? rupees(i.rate) : '-'}</td></tr>`).join('')}</tbody></table>`;
}
document.querySelector('[data-view="stockin"]').addEventListener('click', loadLastEntry);
document.addEventListener('stock-imported', () => { loadLastEntry(); loadProducts(); });   // after an Excel import

loadFeatures();   // WhatsApp / barcode / GST switches from Settings

// start with one empty stock-in row, without stealing focus from Billing
addRow();
document.activeElement?.blur();
await signedIn;
if (isOwner()) loadProducts();   // Products and Stock In are the owner's

// ---- right-click Refresh / Reset page ----
onPage('products', {
  refresh: () => loadProducts(),
  reset: () => { $('#search').value = ''; return loadProducts(); },
});
onPage('stockin', {
  refresh: () => loadLastEntry(),
  reset: () => {
    const typed = [...$('#entryRows').querySelectorAll('input')].some((i) => !i.disabled && i.value.trim());
    if (typed && !confirm('Clear the rows that are not saved yet?')) return false;
    $('#entryRows').replaceChildren();
    addRow();
    setMsg('', true);
    return loadLastEntry();
  },
});
