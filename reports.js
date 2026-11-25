import { $, rupees, esc, errText, when } from './util.js';
import { onPage } from './page.js';
import { modeLabel } from './shop.js';
import { isOwner, signedIn } from './session.js';
import { rateText, stateName } from './gst.js';
await signedIn;   // Reports are the owner's

const iso = (d) => d.toLocaleDateString('en-CA');
const nice = (s) => s.split('-').reverse().join('/');   // 2026-11-20 -> 20/11/2026
// cells for the Excel file: money as real numbers (1,234.50), headings bold, dates as real dates
const money = (p) => ({ v: p / 100, t: 'money' });
const sec = (v) => [{ v, t: 'section' }];
const hd = (cols) => cols.map((v) => ({ v, t: 'head' }));
const dt = (v) => ({ v, t: 'date' });
const dayCell = (v) => ({ v, t: 'day' });
const shown = { sales: null, stock: null, gst: null };   // the report on screen in each card: title, html, rows (Excel), file

const table = (head, rows, numFrom = 1) =>
  `<table><thead><tr>${head.map((h, i) =>
    `<th${i >= numFrom ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
    `<td${i >= numFrom ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const slug = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'x';

// ---- 1. period ----
function periodDates(kind) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const from = new Date(t);
  if (kind === 'week') from.setDate(t.getDate() - ((t.getDay() + 6) % 7));   // weeks start on Monday
  if (kind === 'month') from.setDate(1);
  if (kind === 'year') from.setMonth(0, 1);
  return { from: iso(from), to: iso(t) };
}

function applyPeriod() {
  const kind = $('#repPeriod').value;
  if (kind !== 'custom') {
    const { from, to } = periodDates(kind);
    $('#repFrom').value = from; $('#repTo').value = to;
  }
  for (const id of ['#repFrom', '#repTo']) $(id).disabled = kind !== 'custom';
  showPeriod();
}
function showPeriod() {
  const from = $('#repFrom').value, to = $('#repTo').value;
  $('#repPeriodText').textContent = from && to ? `Reports below cover ${nice(from)} to ${nice(to)}.` : 'Choose both dates.';
}
const period = () => ({ from: $('#repFrom').value, to: $('#repTo').value });
const periodLabel = () => { const p = period(); return p.from === p.to ? nice(p.from) : `${nice(p.from)} to ${nice(p.to)}`; };

$('#repPeriod').addEventListener('change', applyPeriod);
for (const id of ['#repFrom', '#repTo']) $(id).addEventListener('change', showPeriod);

// ---- 2. sales report ----
function showSalesOptions() {
  const by = $('#salesBy').value;
  for (const e of document.querySelectorAll('#reports .rep-opt')) e.classList.toggle('show', e.dataset.for === by);
}
$('#salesBy').addEventListener('change', showSalesOptions);

async function loadSalesmen() {
  const keep = $('#repSalesman').value;
  const list = await window.api.listAllSalesmen();
  $('#repSalesman').innerHTML = '<option value="">Select salesman</option>' +
    list.map((s) => `<option value="${s.id}">${esc(s.name)}${s.active ? '' : ' (inactive)'}</option>`).join('');
  $('#repSalesman').value = keep;
}

// returns (credit notes) of the period are taken off: "Net after returns" is what the shop really sold
const summaryHtml = (s) => table(['Bills', 'Units', 'Gross ₹', 'Discount ₹', 'Net ₹', 'Returns ₹', 'Net after returns ₹'],
  [[s.bills, s.units, rupees(s.gross), rupees(s.discount), rupees(s.net), rupees(s.returns ?? 0), rupees(s.after_returns ?? s.net)]], 0);
const summaryCsv = (s) => [sec('Summary'), hd(['Bills', 'Units', 'Gross ₹', 'Discount ₹', 'Net ₹', 'Returns ₹', 'Net after returns ₹']),
  [s.bills, s.units, money(s.gross), money(s.discount), money(s.net), money(s.returns ?? 0), money(s.after_returns ?? s.net)], []];
// returns (credit notes) and udhaar payments received in the period, under the sales report
function returnsSection(r) {
  const out = { html: '', csv: [] };
  if (r.returns?.length) {
    const rows = r.returns.map((c) => [`CN-${c.note_no}`, c.created_at, c.bill_no, c.customer_name || '-', c.made_by,
      c.exchange_bill_no ? `exchange bill ${c.exchange_bill_no}` : 'credit note', c.amount, c.balance]);
    const head = ['Credit note', 'Date & time', 'From bill', 'Customer', 'Taken back by', 'Used for', 'Value ₹', 'Balance ₹'];
    out.html += `<h3>Returns (credit notes)</h3>${table(head, rows.map((x) => [x[0], when(x[1]), ...x.slice(2, 6), rupees(x[6]), rupees(x[7])]), 6)}
      <p class="note">Credit notes are given for items that came back (no cash). "Credit note" under payment modes is credit notes used to pay bills.</p>`;
    out.csv.push([], sec('Returns (credit notes)'), hd(head), ...rows.map((x) => [x[0], dt(x[1]), ...x.slice(2, 6), money(x[6]), money(x[7])]));
  }
  if (r.udhaar_received?.length) {
    const rows = r.udhaar_received.map((u) => [`RC-${u.receipt_no}`, u.created_at, u.name || '-', u.phone,
      u.method === 'credit_note' ? 'Credit note' : modeLabel(u.method), u.made_by, u.amount]);
    const head = ['Receipt', 'Date & time', 'Customer', 'Mobile', 'Paid by', 'Received by', 'Amount ₹'];
    const total = rows.reduce((a, x) => a + x[6], 0);
    out.html += `<h3>Udhaar payments received</h3>${table(head, [...rows.map((x) => [x[0], when(x[1]), ...x.slice(2, 6), rupees(x[6])]),
      ['', '', 'TOTAL', '', '', '', rupees(total)]], 6)}
      <p class="note">Money received for earlier udhaar - it is not in "Net" above (that counts bills).</p>`;
    out.csv.push([], sec('Udhaar payments received'), hd(head), ...rows.map((x) => [x[0], dt(x[1]), ...x.slice(2, 6), money(x[6])]));
  }
  return out.html ? out : null;
}

function salesSections(r, by) {
  const s = r.summary;
  const parts = [['Summary', summaryHtml(s)]];
  const csv = [...summaryCsv(s)];
  if (by !== 'salesman') {
    const sm = r.bySalesman.map((x) => [x.name, x.bills, x.units, x.gross, x.discount, x.net]);
    parts.push(['By salesman', table(['Salesman', 'Bills', 'Units', 'Gross ₹', 'Discount ₹', 'Net ₹'],
      sm.map(([n, b, u, g, d, t]) => [n, b, u, rupees(g), rupees(d), rupees(t)]))]);
    csv.push(sec('By salesman'), hd(['Salesman', 'Bills', 'Units', 'Gross ₹', 'Discount ₹', 'Net ₹']),
      ...sm.map(([n, b, u, g, d, t]) => [n, b, u, money(g), money(d), money(t)]), []);
  }
  const pay = r.byPayment.map((x) => [modeLabel(x.method), x.bills, x.amount]);
  parts.push(['By payment mode', `${table(['Mode', 'Bills', 'Amount ₹'], pay.map(([m, b, a]) => [m, b, rupees(a)]))}
    <p class="note">A bill paid with two methods counts under each; the amounts add up to Net.</p>`]);
  csv.push(sec('By payment mode'), hd(['Mode', 'Bills', 'Amount ₹']), ...pay.map(([m, b, a]) => [m, b, money(a)]), []);
  const day = r.byDay.map((x) => [x.day, x.bills, x.units, x.net]);
  parts.push(['By day', table(['Date', 'Bills', 'Units', 'Net ₹'], day.map(([d, b, u, t]) => [nice(d), b, u, rupees(t)]))]);
  csv.push(sec('By day'), hd(['Date', 'Bills', 'Units', 'Net ₹']), ...day.map(([d, b, u, t]) => [dayCell(d), b, u, money(t)]));
  if (r.bills) {
    const bl = r.bills.map((b) => [b.bill_no, when(b.sold_at), b.customer_name || '-', b.salesman,
      (b.methods ?? '').split('+').map((m) => modeLabel(m)).join(' + '), b.units, b.discount, b.total]);
    parts.push(['Bills', table(['Bill No', 'Date & time', 'Customer', 'Salesman', 'Paid by', 'Units', 'Discount ₹', 'Total ₹'],
      bl.map((x) => [...x.slice(0, 6), rupees(x[6]), rupees(x[7])]), 5)]);
    csv.push([], sec('Bills'), hd(['Bill No', 'Date & time', 'Customer', 'Salesman', 'Paid by', 'Units', 'Discount ₹', 'Total ₹']),
      ...bl.map((x, i) => [x[0], dt(r.bills[i].sold_at), ...x.slice(2, 6), money(x[6]), money(x[7])]));
  }
  const ret = returnsSection(r);
  return { html: parts.map(([h, t]) => `<h3>${h}</h3>${t}`).join('') + (ret?.html ?? ''), csv: [...csv, ...(ret?.csv ?? [])] };
}

function codeSections(r) {
  const s = r.summary;
  const lines = r.lines.map((l) => [l.bill_no, when(l.sold_at), l.customer_name || '-', l.salesman, l.qty, l.price, l.amount]);
  const html = `<h3>Summary</h3>${table(['Bills', 'Units sold', 'Amount ₹'], [[s.bills, s.units, rupees(s.amount)]], 0)}
    <h3>Bills with this item</h3>${table(['Bill No', 'Date & time', 'Customer', 'Salesman', 'Qty', 'Price ₹', 'Amount ₹'],
      lines.map((x) => [...x.slice(0, 5), rupees(x[5]), rupees(x[6])]), 4)}`;
  const csv = [sec('Summary'), hd(['Bills', 'Units sold', 'Amount ₹']), [s.bills, s.units, money(s.amount)], [],
    sec('Bills with this item'), hd(['Bill No', 'Date & time', 'Customer', 'Salesman', 'Qty', 'Price ₹', 'Amount ₹']),
    ...lines.map((x, i) => [x[0], dt(r.lines[i].sold_at), ...x.slice(2, 5), money(x[5]), money(x[6])])];
  return { html, csv, empty: !lines.length };
}

async function buildSales() {
  const by = $('#salesBy').value;
  const p = period();
  const filter = { by };
  let what = 'All sales', fileWhat = 'all', when_ = periodLabel(), fileWhen = `${p.from}_to_${p.to}`;
  if (by === 'salesman') {
    filter.salesman_id = Number($('#repSalesman').value);
    if (!filter.salesman_id) throw new Error('Select a salesman');
    what = `Salesman: ${$('#repSalesman').selectedOptions[0].textContent}`; fileWhat = `salesman-${slug($('#repSalesman').selectedOptions[0].textContent)}`;
  }
  if (by === 'code') filter.code = $('#repCode').value.trim();
  if (by === 'bills') {
    filter.bill_from = Number($('#repBillFrom').value); filter.bill_to = Number($('#repBillTo').value);
    what = `Bills ${filter.bill_from} to ${filter.bill_to}`; fileWhat = `bills-${filter.bill_from}-${filter.bill_to}`;
    when_ = ''; fileWhen = '';
  }
  const r = await window.api.salesReport({ ...p, filter });
  let body;
  if (by === 'code') {
    const item = [r.product.name, r.product.size, r.product.colour].filter(Boolean).join(' · ');
    what = `Barcode ${r.product.code}${item ? ` (${item})` : ''}`; fileWhat = `barcode-${slug(r.product.code)}`;
    body = codeSections(r);
    if (body.empty) body.html = '<p>This item was not sold in this period.</p>';
  } else if (by === 'category') {
    what = 'By category'; fileWhat = 'by-category';
    body = categorySections(r);
  } else {
    const ret = returnsSection(r);
    body = r.summary.bills ? salesSections(r, by)
      : { html: `<p>No sales found.</p>${ret?.html ?? ''}`, csv: [...summaryCsv(r.summary), ...(ret?.csv ?? [])] };
  }
  const title = ['Sales report', what, when_].filter(Boolean).join(' · ');
  return { title, html: body.html, rows: body.csv, file: `Report-sales-${[fileWhat, fileWhen].filter(Boolean).join('-')}.xlsx` };
}

// sales by category: every level with its total, sub categories indented under it
const indent = (level) => '    '.repeat(level - 1);
function categorySections(r) {
  if (!r.rows.length) return { html: '<p>No sales found.</p>', csv: [] };
  const head = ['Category', 'Bills', 'Pieces', 'Amount ₹'];
  const rows = r.rows.map((c) => [indent(c.level) + c.name, c.bills, c.qty, c.amount, c.level]);
  const html = `<h3>Sales by category</h3><table class="cat-rep"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((x) => `<tr class="lv${x[4]}"><td>${esc(x[0])}</td><td class="num">${x[1]}</td><td class="num">${x[2]}</td>
      <td class="num">${rupees(x[3])}</td></tr>`).join('')}
    <tr class="lv1"><td><b>TOTAL</b></td><td></td><td class="num"><b>${r.total.qty}</b></td><td class="num"><b>${rupees(r.total.amount)}</b></td></tr></tbody></table>
    <p class="note">Each main category's total includes its sub categories. Amounts are the item prices on the bills, before any
      bill discount, with the category each item had when it was sold.</p>`;
  const csv = [sec('Sales by category'), hd(head), ...rows.map((x) => [x[4] === 1 ? { v: x[0], t: 'section' } : x[0], x[1], x[2], money(x[3])]),
    [{ v: 'TOTAL', t: 'section' }, '', r.total.qty, money(r.total.amount)]];
  return { html, csv };
}

// ---- 3. stock report ----
async function buildStock() {
  const p = period();
  const rows = await window.api.stockReport(p);
  const body = rows.map((x) => [x.code, x.name, x.category ? x.category.replace(/ > /g, ' › ') : '-', x.size, x.colour,
    x.opening, x.stock_in, x.sold, x.returned, x.adjustment, x.closing]);
  const sum = (i) => body.reduce((a, r) => a + r[i], 0);
  const total = ['', 'TOTAL', '', '', '', sum(5), sum(6), sum(7), sum(8), sum(9), sum(10)];
  const head = ['Barcode', 'Name', 'Category', 'Size', 'Colour', 'Opening', 'Stock In', 'Sold', 'Returned', 'Adjustment', 'Closing'];
  // closing stock and its value by category (main category, then its sub categories)
  const byCat = new Map();
  for (const x of rows) {
    const parts = x.category ? x.category.split(' > ').slice(0, 2) : ['(no category)'];
    parts.forEach((_, k) => {
      const key = parts.slice(0, k + 1).join(' > ');
      const n = byCat.get(key) ?? { name: parts[k], level: k + 1, closing: 0, value: 0 };
      n.closing += x.closing; n.value += Math.max(x.closing, 0) * (x.rate ?? 0);
      byCat.set(key, n);
    });
  }
  // tree order: level by level, numbers as numbers (the same as main/categories.js comparePaths)
  const cmp = (a, b) => { const x = a.split(' > '), y = b.split(' > ');
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = x[i].localeCompare(y[i], 'en', { numeric: true, sensitivity: 'base' }); if (c) return c; }
    return x.length - y.length; };
  const cats = [...byCat.entries()].sort(([a], [b]) => (a === '(no category)') - (b === '(no category)') || cmp(a, b));
  const catHead = ['Category', 'Closing stock', 'Stock value ₹ (at rate)'];
  const catHtml = cats.length > 1 || (cats[0] && cats[0][0] !== '(no category)')
    ? `<h3>By category</h3><table class="cat-rep"><thead><tr><th>${catHead[0]}</th><th class="num">${catHead[1]}</th><th class="num">${catHead[2]}</th></tr></thead>
      <tbody>${cats.map(([, c]) => `<tr class="lv${c.level}"><td>${esc(indent(c.level) + c.name)}</td><td class="num">${c.closing}</td>
        <td class="num">${rupees(c.value)}</td></tr>`).join('')}</tbody></table>` : '';
  const title = `Stock report · ${periodLabel()}`;
  return {
    title,
    html: rows.length ? `${catHtml}<h3>Items</h3>${table(head, [...body, total], 5)}` : '<p>No stock movement in this period.</p>',
    rows: [...(catHtml ? [sec('By category'), hd(catHead), ...cats.map(([, c]) => [indent(c.level) + c.name, c.closing, money(c.value)]), [], sec('Items')] : []),
      hd(head), ...body, total.map((v, i) => (i === 1 ? { v, t: 'section' } : v))],
    file: `Report-stock-${p.from}_to_${p.to}.xlsx`,
  };
}

// ---- 4. GST report (only with GST billing on) ----
const place = (c) => (c ? `${stateName(c)} (${c})` : '-');
async function buildGst() {
  const p = period();
  const r = await window.api.gstReport(p);
  const s = r.summary;
  const tax = ['Taxable ₹', 'CGST ₹', 'SGST ₹', 'IGST ₹'];
  const t4 = (x) => [x.taxable, x.cgst, x.sgst, x.igst];
  const parts = [], csv = [];
  const add = (title, head, rows, numFrom, moneyFrom) => {
    parts.push(`<h3>${title}</h3>${rows.length ? table(head, rows.map((x) => x.map((v, i) => (i >= moneyFrom ? rupees(v) : v))), numFrom) : '<p class="note">None.</p>'}`);
    csv.push(sec(title), hd(head), ...rows.map((x) => x.map((v, i) => (i >= moneyFrom ? money(v) : v))), []);
  };
  add('Summary', ['Tax invoices', 'Value ₹', ...tax], [[s.bills, s.value, ...t4(s)]], 0, 1);
  add('B2B - bills to customers with a GSTIN', ['Bill No', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'Value ₹', ...tax],
    r.b2b.map((b) => [b.bill_no, when(b.sold_at), b.customer_name || '-', b.customer_gstin, place(b.supply_state), b.value, ...t4(b)]), 5, 5);
  add('B2C - other bills, by rate and place of supply', ['Place of supply', 'GST rate', 'Bills', ...tax],
    r.b2c.map((b) => [place(b.supply_state), rateText(b.rate), b.bills, ...t4(b)]), 2, 3);
  add('HSN summary', ['HSN', 'Description', 'GST rate', 'Qty (PCS)', 'Value ₹', ...tax],
    r.hsn.map((h) => [h.hsn || '(none)', h.description, rateText(h.rate), h.qty, h.value, ...t4(h)]), 3, 4);
  // credit notes (returns) of tax invoices: taken off the sales above when filing
  const n = r.notes;
  if (n?.summary.notes) {
    add('Credit notes (returns) - summary', ['Credit notes', 'Value ₹', ...tax], [[n.summary.notes, n.summary.value, ...t4(n.summary)]], 0, 1);
    add('Credit notes - B2B (customers with a GSTIN)', ['Credit note', 'Date', 'Bill No', 'Customer', 'GSTIN', 'Place of supply', 'Value ₹', ...tax],
      n.b2b.map((c) => [`CN-${c.note_no}`, when(c.created_at), c.bill_no, c.customer_name || '-', c.customer_gstin, place(c.supply_state), c.value, ...t4(c)]), 6, 6);
    add('Credit notes - B2C, by rate and place of supply', ['Place of supply', 'GST rate', 'Credit notes', ...tax],
      n.b2c.map((c) => [place(c.supply_state), rateText(c.rate), c.notes, ...t4(c)]), 2, 3);
    const netOf = (k) => s[k] - n.summary[k];
    add('Net after credit notes', ['Value ₹', ...tax], [[s.value - n.summary.value, netOf('taxable'), netOf('cgst'), netOf('sgst'), netOf('igst')]], 0, 0);
  }
  return {
    title: `GST report · ${periodLabel()}`,
    html: s.bills || n?.summary.notes ? parts.join('') : '<p>No tax invoices in this period (GST billing may have been off).</p>',
    rows: csv, file: `Report-GST-${p.from}_to_${p.to}.xlsx`,
  };
}

// ---- running, printing and exporting, the same for all cards ----
const msg = (kind, t, ok) => { const m = $(`#${kind}Msg`); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

async function run(kind) {
  msg(kind, '', true);
  try {
    const shop = (await window.api.getSettings()).shop_name;
    const out = await { sales: buildSales, stock: buildStock, gst: buildGst }[kind]();
    shown[kind] = { ...out, title: `${shop} - ${out.title}` };
    $(`#${kind}Out`).innerHTML = `<div class="rep-head"><b>${esc(out.title)}</b></div>${out.html}`;
    $(`#${kind}Actions`).hidden = false;
  } catch (e) {
    shown[kind] = null;
    $(`#${kind}Out`).replaceChildren();
    $(`#${kind}Actions`).hidden = true;
    msg(kind, errText(e), false);
  }
}

function print(kind) {
  const r = shown[kind];
  if (!r) return;
  const area = $('#printArea');
  area.innerHTML = `<div class="report-sheet"><h2>${esc(r.title)}</h2>${r.html}</div>`;
  window.addEventListener('afterprint', () => area.replaceChildren(), { once: true });
  window.print();
}

async function exportXlsx(kind) {
  const r = shown[kind];
  if (!r) return;
  const grid = [[{ v: r.title, t: 'title' }], [{ v: `Made ${new Date().toLocaleString('en-IN')}`, t: 'text' }], [], ...r.rows];
  try { msg(kind, `Saved ${await window.api.saveReportXlsx({ kind, name: r.file, grid })}`, true); }
  catch (e) { msg(kind, errText(e), false); }
}

for (const kind of ['sales', 'stock', 'gst']) {
  $(`#run${kind[0].toUpperCase()}${kind.slice(1)}`).addEventListener('click', () => run(kind));
  $(`#${kind}Print`).addEventListener('click', () => print(kind));
  $(`#${kind}Csv`).addEventListener('click', () => exportXlsx(kind));
}
$('#repCode').addEventListener('keydown', (e) => e.key === 'Enter' && run('sales'));
document.querySelector('[data-view="reports"]').addEventListener('click', () => {
  loadSalesmen();
  if ($('#repPeriod').value !== 'custom') applyPeriod();   // "today" moves on if the app stays open overnight
});

applyPeriod();
showSalesOptions();
if (isOwner()) loadSalesmen();

// right-click Refresh: the reports on screen run again with the same choices (new bills show up);
// Reset page: This month, All sales, nothing shown
onPage('reports', {
  refresh: async () => {
    await loadSalesmen();
    if ($('#repPeriod').value !== 'custom') applyPeriod();
    for (const kind of ['sales', 'stock', 'gst']) if (shown[kind]) await run(kind);
  },
  reset: () => {
    $('#repPeriod').value = 'month'; applyPeriod();
    $('#salesBy').value = 'all'; showSalesOptions();
    for (const id of ['#repSalesman', '#repCode', '#repBillFrom', '#repBillTo']) $(id).value = '';
    for (const kind of ['sales', 'stock', 'gst']) {
      shown[kind] = null;
      $(`#${kind}Out`).replaceChildren();
      $(`#${kind}Actions`).hidden = true;
      msg(kind, '', true);
    }
  },
});
