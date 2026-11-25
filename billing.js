import { $, toPaise, rupees, esc, errText } from './util.js';
import { finishSale, finishCredit, waNote, billLines } from './bills.js';
import { isOn } from './features.js';
import { onPage } from './page.js';
import { modes, onShop, shop } from './shop.js';
import { me, signedIn } from './session.js';
import { splitTax } from './gst.js';
import { returnRows, billLine } from './returns-ui.js';
await signedIn;   // nothing to bill until someone is logged in (login screen)
const maxLines = () => billLines(shop());   // what the chosen bill format holds
const lines = () => [...$('#lineRows').children];
const pays = () => [...$('#payRows').children];

const setMsg = (t, ok) => { const m = $('#billMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

function recalc() {
  let sub = 0;
  for (const tr of lines()) {
    const amt = (Number(tr.querySelector('.qty').value) || 0) * toPaise(tr.querySelector('.price').value);
    tr.querySelector('.amt').textContent = rupees(amt);
    sub += amt;
  }
  const pct = $('#discountPct').value;
  if (pct !== '') $('#discount').value = (Math.round((sub * Math.min(Number(pct) || 0, 100)) / 100) / 100).toFixed(2);
  const discount = Math.min(toPaise($('#discount').value), sub);
  const total = sub - discount;
  $('#subtotal').textContent = rupees(sub);
  $('#total').textContent = rupees(total);
  if (isOn('gst')) {   // the same sum the bill will make (main/gst.js), shown before saving
    const ls = lines().filter((tr) => tr.dataset.found).map((tr) => ({
      amount: (Number(tr.querySelector('.qty').value) || 0) * toPaise(tr.querySelector('.price').value),
      qty: Number(tr.querySelector('.qty').value) || 0, fixedRate: tr.dataset.gst === '' ? null : Number(tr.dataset.gst) }));
    const t = ls.length ? splitTax(ls, Math.min(discount, ls.reduce((a, l) => a + l.amount, 0))) : null;
    $('#gstPart').textContent = rupees(t ? t.cgst + t.sgst + t.igst : 0);
  }

  // exchange: the items coming back pay first; the customer pays only the rest (any extra stays on the credit note)
  const back = exchange?.total() ?? 0;
  const credit = Math.min(back, total);
  const toPay = total - credit;
  document.body.classList.toggle('has-exchange', back > 0);
  $('#exCredit').textContent = rupees(credit);
  $('#toPay').textContent = rupees(toPay);
  $('#exNote').textContent = back > total ? `The items coming back are worth ₹${rupees(back)}: ₹${rupees(back - total)} stays on the credit note for a later bill.` : '';

  const rows = pays();
  let paid = 0;
  for (const r of rows) {
    const a = r.querySelector('.payamt');
    a.disabled = rows.length === 1;
    if (rows.length === 1) a.value = (toPay / 100).toFixed(2);
    paid += toPaise(a.value);
  }
  $('#remaining').textContent = rows.length > 1 ? `Remaining: ₹${rupees(toPay - paid)}` : '';
}

// ---- udhaar (pay later): needs the customer's mobile; shows what they already owe and their limit ----
async function udhaarHint() {
  const phone = $('#custPhone').value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(phone)) return setMsg('Udhaar needs the customer\'s mobile number', false);
  const d = await window.api.udhaarDue(phone);
  const lim = d.limit == null ? 'no limit' : `limit ₹${rupees(d.limit)}`;
  setMsg(`${d.name || 'This customer'} owes ₹${rupees(d.due)} now (${lim})`, d.limit == null || d.due < d.limit);
}
$('#custPhone').addEventListener('change', () => { if (pays().some((r) => r.querySelector('.method').value === 'udhaar')) udhaarHint(); });

// ---- exchange: items coming back from an old bill (main/returns.js) ----
let exchange = null;   // { bill, rows: returnRows(...) } while the exchange box has a bill
const exchangeOf = () => (exchange?.any() ? { bill_no: exchange.bill.bill_no, items: exchange.picks() } : null);
function clearExchange() {
  exchange = null;
  $('#exchangeBox').hidden = true;
  $('#exBillNo').value = ''; $('#exInfo').textContent = ''; $('#exRows').replaceChildren(); $('#exTable').hidden = true;
  recalc();
}
$('#exchangeBtn').addEventListener('click', () => { $('#exchangeBox').hidden = false; $('#exBillNo').focus(); });
$('#exClear').addEventListener('click', clearExchange);
async function loadExchange() {
  const n = Number($('#exBillNo').value);
  const bill = n ? await window.api.returnable(n) : null;
  if (!bill) { exchange = null; $('#exTable').hidden = true; $('#exInfo').textContent = 'No bill with that number'; recalc(); return; }
  $('#exInfo').textContent = `${billLine(bill)}. Enter how many of each come back.`;
  $('#exTable').hidden = false;
  const rows = returnRows($('#exRows'), bill, recalc);
  exchange = { bill, ...rows };
  // the same customer, unless one is already typed
  if (!$('#custName').value && !$('#custPhone').value) { $('#custName').value = bill.customer_name ?? ''; $('#custPhone').value = bill.customer_phone ?? ''; }
  recalc();
  $('#exRows .rq')?.focus();
}
$('#exLoad').addEventListener('click', loadExchange);
$('#exBillNo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadExchange(); } });

function addLine() {
  if (lines().length >= maxLines()) return setMsg(`This bill format holds up to ${maxLines()} lines`, false);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="code" /></td>
    <td><input class="desc" /></td>
    <td class="sc size"></td>
    <td class="sc colour"></td>
    <td class="num"><input class="qty" type="number" min="1" step="1" value="1" /></td>
    <td class="num"><input class="price" type="number" min="0" step="0.01" /></td>
    <td class="num amt">0.00</td>
    <td><button class="rm">×</button></td>`;
  const code = tr.querySelector('.code');
  code.addEventListener('change', () => lookupLine(tr));   // typed barcode, or exchange: change it, the line follows
  code.addEventListener('keydown', async (e) => {          // scanners type the barcode and press Enter
    if (e.key !== 'Enter' || !isOn('barcode')) return;
    e.preventDefault();
    if (!code.value.trim()) return;
    if (await lookupLine(tr)) nextScanField(tr);
  });
  tr.addEventListener('input', recalc);
  tr.querySelector('.rm').addEventListener('click', () => { tr.remove(); if (!lines().length) addLine(); recalc(); });
  $('#lineRows').append(tr);
  code.focus();
}

// Finds the product for a line's barcode box (a barcode linked before 1.5.0 finds its product too).
// The same product already on another line gets +1 Qty there and this line is emptied for the next scan.
// Returns the line that now holds the product, or null when nothing was found.
async function lookupLine(tr) {
  const code = tr.querySelector('.code');
  const scan = code.value.trim();
  if (!scan || tr.dataset.busy === scan) return null;   // Enter and the change event fire for one scan
  tr.dataset.busy = scan;
  try {
    const hit = await window.api.findProduct(scan);
    code.classList.toggle('bad', !hit);
    if (!hit) {
      showProduct(tr, null);
      setMsg(`Barcode "${scan}" not found - add it in Stock In first`, false);
      code.select();   // the next scan replaces it
      return null;
    }
    const same = isOn('barcode') && lines().find((o) => o !== tr && o.querySelector('.code').value.trim() === hit.code);
    if (same) {
      const q = same.querySelector('.qty');
      q.value = (Number(q.value) || 0) + 1;
      for (const s of ['.code', '.desc', '.price']) tr.querySelector(s).value = '';
      tr.querySelector('.qty').value = 1;
      showProduct(tr, null);
      setMsg(`${hit.name}: Qty ${q.value}`, true);
      recalc();
      return same;
    }
    code.value = hit.code;   // a barcode linked before 1.5.0 becomes the product's barcode on the bill
    tr.querySelector('.desc').value = hit.name;
    showProduct(tr, hit);
    if (hit.rate) tr.querySelector('.price').value = (hit.rate / 100).toFixed(2);   // still editable
    $('#billMsg').textContent = '';
    recalc();
    return tr;
  } finally { delete tr.dataset.busy; }
}

// size and colour come from the product (shown, saved on the bill by main/sales.js); the GST rate for the preview
function showProduct(tr, p) {
  tr.querySelector('.size').textContent = p?.size ?? '';
  tr.querySelector('.colour').textContent = p?.colour ?? '';
  if (p) { tr.dataset.found = '1'; tr.dataset.gst = p.gst_rate ?? ''; } else { delete tr.dataset.found; delete tr.dataset.gst; }
}

// After a scan: go to the empty line for the next item, adding one if needed.
function nextScanField(tr) {
  const empty = lines().find((o) => !o.querySelector('.code').value.trim());
  if (empty) return empty.querySelector('.code').focus();
  if (lines().length < maxLines()) return addLine();
  tr.querySelector('.qty').focus();
}

// the shop's own payment modes (Settings > Payment modes)
const modeOptions = () => modes().map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')
  + '<option value="credit_note">Credit note</option>';   // a customer's credit note from an earlier return
function refreshModes() {
  for (const sel of document.querySelectorAll('#payRows .method')) {
    const keep = sel.value;
    sel.innerHTML = modeOptions();
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}
onShop(() => { refreshModes(); return loadSalesmen(); });   // after setup or a Settings change

function addPay() {
  const existing = pays();
  if (existing.length === 1) existing[0].querySelector('.payamt').value = '';  // splitting: enter each amount
  const d = document.createElement('div');
  d.className = 'payrow';
  d.innerHTML = `<select class="method">${modeOptions()}</select>
    <input class="cnno" placeholder="CN number, e.g. CN-12" hidden />
    <input class="payamt" type="number" min="0" step="0.01" /><button class="rm">×</button>`;
  d.addEventListener('input', recalc);
  // paying with a credit note: its number, and how much is left on it
  const cn = d.querySelector('.cnno');
  d.querySelector('.method').addEventListener('change', (e) => {
    cn.hidden = e.target.value !== 'credit_note';
    if (!cn.hidden) cn.focus();
    if (e.target.value === 'udhaar') udhaarHint();
  });
  cn.addEventListener('change', async () => {
    const note = cn.value.trim() ? await window.api.getCreditNote(cn.value) : null;
    cn.classList.toggle('bad', !!cn.value.trim() && !note?.balance);
    cn.title = note ? `CN-${note.note_no}: ₹${rupees(note.balance)} left` : 'No such credit note';
    if (cn.value.trim()) setMsg(note ? `Credit note CN-${note.note_no}: ₹${rupees(note.balance)} left` : `No credit note ${cn.value}`, !!note?.balance);
  });
  d.querySelector('.rm').addEventListener('click', () => { d.remove(); if (!pays().length) addPay(); recalc(); });
  $('#payRows').append(d);
  recalc();
}

async function loadSalesmen(select) {
  const list = await window.api.listSalesmen();
  const sel = $('#salesman');
  const keep = select ?? sel.value;
  sel.innerHTML = '<option value="">Select salesman</option>' +
    list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = String(keep);
  if (me.role === 'salesman') { sel.value = String(me.id); sel.disabled = true; }   // his own bills only
}

$('#addSalesman').addEventListener('click', async () => {
  try {
    const id = await window.api.addSalesman($('#salesmanName').value);
    $('#salesmanName').value = '';
    await loadSalesmen(id);
  } catch (e) { setMsg(errText(e), false); }
});

$('#saveBill').addEventListener('click', async () => {
  const items = lines()
    .map((tr) => ({
      code: tr.querySelector('.code').value.trim(),
      description: tr.querySelector('.desc').value.trim(),
      qty: Number(tr.querySelector('.qty').value),
      price: toPaise(tr.querySelector('.price').value),
    }))
    .filter((i) => i.code || i.description || i.price);
  const payments = pays()
    .map((r) => ({ method: r.querySelector('.method').value, amount: toPaise(r.querySelector('.payamt').value),
      ...(r.querySelector('.method').value === 'credit_note' ? { note_no: r.querySelector('.cnno').value.trim() } : {}) }))
    .filter((p) => p.amount > 0);
  const btn = $('#saveBill');
  if (btn.disabled) return;   // already saving: a double click must not make two bills
  btn.disabled = true;
  try {
    const billNo = await window.api.createSale({
      salesman_id: Number($('#salesman').value),
      customer_name: $('#custName').value,
      customer_phone: $('#custPhone').value,
      customer_gstin: isOn('gst') ? $('#custGstin').value : '',
      interstate: isOn('gst') && $('#interstate').checked,
      discount: toPaise($('#discount').value),
      items,
      payments,
      exchange: exchangeOf(),
    });
    const [sale, settings] = await Promise.all([window.api.getSale(billNo), window.api.getSettings()]);
    // an exchange made a credit note: keep it as a PDF (the bill itself shows the exchange); say what is left on it
    const exNote = sale.exchange ? ` - exchange credit note CN-${sale.exchange.note_no}${sale.exchange.balance
      ? ` has ₹${rupees(sale.exchange.balance)} left for a later bill` : ' fully used'}` : '';
    if (sale.exchange) { await finishCredit(sale.exchange.note_no, settings, { print: sale.exchange.balance > 0 }); clearExchange(); }
    $('#lineRows').replaceChildren(); $('#payRows').replaceChildren();
    for (const id of ['#discount', '#discountPct', '#custName', '#custPhone', '#custGstin']) $(id).value = '';
    $('#interstate').checked = false;
    addLine(); addPay();
    const wa = isOn('whatsapp') && $('#sendWa').checked && !!sale.customer_phone;
    setMsg(`Bill ${billNo} saved${wa ? ' - opening WhatsApp...' : ''}`, true);
    const r = await finishSale(sale, settings, { whatsapp: wa });
    if (r.problems.length) setMsg(`Bill ${billNo} saved. ${r.problems.join(' · ')}`, false);
    else setMsg([`Bill ${billNo} saved as Bill-${billNo}.pdf`, r.printed && 'sent to printer', wa && waNote(r.whatsapp)]
      .filter(Boolean).join(' - ') + exNote, true);
  } catch (e) { setMsg(errText(e), false); }
  finally { btn.disabled = false; }
});

// Saved-customer suggestions: typing in either field lists matches; picking one fills both name and mobile.
const showPhone = (p) => `${p.slice(0, 5)} ${p.slice(5)}`;
function customerSuggest(input) {
  const list = input.nextElementSibling;
  let items = [], on = -1, seq = 0;
  const close = () => { list.hidden = true; items = []; on = -1; };
  const highlight = (i) => {
    on = i;
    [...list.children].forEach((li, k) => li.classList.toggle('on', k === i));
  };
  const pick = (c) => {
    $('#custName').value = c.name;
    $('#custPhone').value = c.phone;
    close();
  };
  input.addEventListener('input', async () => {
    const mine = ++seq;   // ignore answers that arrive after newer typing
    const found = await window.api.searchCustomers(input.value);
    if (mine !== seq || document.activeElement !== input) return;
    items = found;
    if (!items.length) return close();
    list.innerHTML = items.map((c) => `<li><b>${esc(c.name || '(no name)')}</b><span>${showPhone(c.phone)}</span></li>`).join('');
    [...list.children].forEach((li, k) => li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(items[k]); }));
    list.hidden = false;
    highlight(-1);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((on + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((on - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && on >= 0) { e.preventDefault(); pick(items[on]); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', close);
}
customerSuggest($('#custName'));
customerSuggest($('#custPhone'));

$('#discountPct').addEventListener('input', recalc);
$('#discount').addEventListener('input', () => { $('#discountPct').value = ''; });   // typed ₹ wins over %
try { $('#sendWa').checked = localStorage.getItem('pkg.sendWa') !== '0'; } catch { /* keep default */ }
$('#sendWa').addEventListener('change', () => {
  try { localStorage.setItem('pkg.sendWa', $('#sendWa').checked ? '1' : '0'); } catch { /* not critical */ }
});

$('#addLine').addEventListener('click', addLine);
$('#addPay').addEventListener('click', addPay);
$('#discount').addEventListener('input', recalc);
document.querySelector('[data-view="billing"]').addEventListener('click', () => loadSalesmen());

// lets the updater avoid restarting the app in the middle of a bill
window.__billingBusy = () =>
  lines().some((tr) => tr.querySelector('.code').value.trim() || tr.querySelector('.price').value);

addLine(); addPay(); loadSalesmen();

// right-click Refresh keeps the bill being typed; Reset page starts a new empty bill (asks first)
onPage('billing', {
  refresh: () => loadSalesmen(),
  reset: () => {
    const typed = lines().some((tr) => [...tr.querySelectorAll('.code, .desc, .price')].some((i) => i.value.trim()))
      || ['#custName', '#custPhone', '#discount', '#discountPct', '#custGstin'].some((id) => $(id).value.trim());
    if (typed && !confirm('Clear this bill? It has not been saved.')) return false;
    $('#lineRows').replaceChildren(); $('#payRows').replaceChildren();
    for (const id of ['#discount', '#discountPct', '#custName', '#custPhone', '#custGstin', '#salesmanName']) $(id).value = '';
    $('#interstate').checked = false;
    clearExchange();
    $('#billMsg').textContent = '';
    addLine(); addPay();
    return loadSalesmen('');
  },
});
