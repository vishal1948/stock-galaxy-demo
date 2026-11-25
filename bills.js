import { $, rupees, esc, errText, when } from './util.js';
import { onPage } from './page.js';
import { modeLabel, logoSrc } from './shop.js';
import { byRate, rateText, stateName } from './gst.js';
import { returnRows, billLine } from './returns-ui.js';

export const BILL_LINES = 12;   // rows ruled on an A4 bill copy; also the most such a bill can hold
// rows on each bill format (Settings > Bill & printing); Billing lets a bill hold no more than its format fits.
// An A4 GST bill keeps 2 rows for its tax table; a thermal receipt is as long as the bill.
const FORMAT_LINES = { a4: BILL_LINES, thermal_80: 40, thermal_58: 40 };
const isThermal = (s) => String(s?.bill_format ?? '').startsWith('thermal_') && !!FORMAT_LINES[s.bill_format];
const a4Lines = (gst) => (gst ? BILL_LINES - 2 : BILL_LINES);
export const billLines = (s) => (isThermal(s) ? FORMAT_LINES[s.bill_format] : a4Lines(s?.gst_billing === '1'));

// ---- amount in words (Indian system: thousand, lakh, crore) ----
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`.trim());
const three = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
function words(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  for (const [size, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) {
    if (n >= size) { parts.push(`${words(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n) parts.push(three(n));
  return parts.join(' ');
}
export const amountInWords = (paise) => {
  const r = Math.floor(paise / 100), p = paise % 100;
  return `Rupees ${words(r)}${p ? ` and ${two(p)} Paise` : ''} Only`;
};

// ---- what every layout shows the same way ----
const variant = (i) => [i.size, i.colour].filter(Boolean).join(' · ');   // "M · Blue"
// the line's category on the bill: its first two levels, as it was when sold ("Pants · Cargo pants")
const catOf = (i) => String(i.category ?? '').split(' > ').slice(0, 2).join(' · ');
const phoneText = (p) => (p ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : '');
// a credit note payment names its credit note; on an exchange bill it says where the items came back from
const payName = (sale, p) => (p.method !== 'credit_note' ? modeLabel(p.method)
  : sale.exchange?.note_no === p.note_no ? `Exchange CN-${p.note_no} (bill ${sale.exchange.bill_no})` : `Credit note CN-${p.note_no}`);
const paidText = (sale, rs) => sale.payments.map((p) =>
  sale.payments.length === 1 ? payName(sale, p) : `${payName(sale, p)} ${rs}${rupees(p.amount)}`).join(' + ');
const dateText = (sale) => {
  const d = new Date(sale.sold_at.replace(' ', 'T'));
  return { date: d.toLocaleDateString('en-GB'), time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) };
};
const isGstBill = (sale) => sale.gst === 1;   // made while GST billing was on; old bills stay as they were made
const billTitle = (sale) => (isGstBill(sale) ? 'TAX INVOICE' : 'INVOICE');
const igstBill = (sale) => sale.items.some((i) => i.igst);
const supplyText = (sale) => (sale.supply_state ? `${stateName(sale.supply_state)} (${sale.supply_state})` : '');

// rate-wise tax table (CGST + SGST, or IGST for another state)
function taxTable(sale, cls) {
  const ig = igstBill(sale);
  const rows = byRate(sale.items).map((r) => `<tr><td>${rateText(r.rate)}</td><td class="n">${rupees(r.taxable)}</td>${ig
    ? `<td class="n">${rupees(r.igst)}</td>` : `<td class="n">${rupees(r.cgst)}</td><td class="n">${rupees(r.sgst)}</td>`}</tr>`);
  return `<table class="${cls}"><thead><tr><th>GST</th><th class="n">Taxable</th>${ig ? '<th class="n">IGST</th>'
    : '<th class="n">CGST</th><th class="n">SGST</th>'}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// ---- one bill copy (half A4) ----
function copyHtml(sale, s, label, duplicate) {
  const { date, time } = dateText(sale);
  const gst = isGstBill(sale);
  const qty = sale.items.reduce((a, i) => a + i.qty, 0);
  const cols = gst ? 8 : 6;
  const rows = sale.items.map((i, n) => `<tr><td class="c">${n + 1}</td>
    <td>${catOf(i) ? `<span class="b-cat">${esc(catOf(i))}</span> ` : ''}${esc(i.description)}${variant(i) ? ` <span class="b-var">${esc(variant(i))}</span>` : ''}</td>
    <td>${esc(i.code)}</td>${gst ? `<td>${esc(i.hsn)}</td>` : ''}<td class="n">${i.qty}</td><td class="n">${rupees(i.price)}</td>
    ${gst ? `<td class="n">${rateText(i.gst_rate)}</td>` : ''}<td class="n">${rupees(i.amount)}</td></tr>`);
  while (rows.length < a4Lines(gst)) rows.push(`<tr class="blank">${'<td></td>'.repeat(cols)}</tr>`);
  const pct = sale.discount ? Math.round((sale.discount / sale.subtotal) * 1000) / 10 : 0;
  return `
  <div class="copy t-${['indigo', 'orange', 'green', 'maroon', 'black'].includes(s.bill_theme) ? s.bill_theme : 'indigo'}${gst ? ' gst' : ''}">
    ${duplicate ? '<div class="b-stamp">DUPLICATE</div>' : ''}
    <header class="b-head${logoSrc(s) ? '' : ' no-logo'}">
      ${logoSrc(s) ? `<img class="b-logo" src="${logoSrc(s)}" alt="" />` : ''}
      <div class="b-shop">
        <div class="b-name">${esc(s.shop_name)}</div>
        <div class="b-tag">${esc(s.shop_tagline)}</div>
        <div>${esc(s.shop_address)}</div>
        <div>Ph: ${esc(s.shop_phones)}</div>
        ${s.gstin ? `<div>GSTIN: <b>${esc(s.gstin)}</b>${gst && supplyText(sale) ? ` · Place of supply: ${esc(supplyText(sale))}` : ''}</div>` : ''}
      </div>
      <div class="b-box">
        <div class="b-title">${billTitle(sale)}</div>
        <div class="b-kv"><span>Bill No.</span><b class="b-no">${sale.bill_no}</b></div>
        <div class="b-kv"><span>Date</span><b>${date}</b></div>
        <div class="b-kv"><span>Time</span><b>${time}</b></div>
      </div>
    </header>
    <div class="b-cust${sale.customer_gstin ? ' with-gstin' : ''}">
      <div class="f wide"><label>Customer</label><span>${esc(sale.customer_name)}</span></div>
      <div class="f"><label>Mobile</label><span>${esc(phoneText(sale.customer_phone))}</span></div>
      ${sale.customer_gstin ? `<div class="f"><label>Customer GSTIN</label><span>${esc(sale.customer_gstin)}</span></div>` : ''}
      <div class="f"><label>Salesman</label><span>${esc(sale.salesman)}</span></div>
      <div class="tag">${label}${duplicate ? ' · DUPLICATE' : ''}</div>
    </div>
    <table class="b-items${gst ? ' gst' : ''}">
      <colgroup>${'<col>'.repeat(cols)}</colgroup>
      <thead><tr><th class="c">Sr.</th><th>Particulars</th><th>Barcode</th>${gst ? '<th>HSN</th>' : ''}<th class="n">Qty</th>
        <th class="n">Rate ₹</th>${gst ? '<th class="n">GST</th>' : ''}<th class="n">Amount ₹</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="b-bottom">
      <div class="b-info">
        <div><label>Amount in words</label><b>${amountInWords(sale.total)}</b></div>
        <div class="b-pair"><span><label>Paid by</label><b>${esc(paidText(sale, '₹'))}</b></span><span><label>Total qty</label><b>${qty}</b></span></div>
        ${gst ? `<div class="b-tax">${taxTable(sale, 'b-taxt')}</div>` : ''}
      </div>
      <div class="b-sum">
        <div><span>Subtotal</span><b>₹ ${rupees(sale.subtotal)}</b></div>
        <div><span>Discount${pct ? ` (${pct}%)` : ''}</span><b>− ₹ ${rupees(sale.discount)}</b></div>
        ${gst ? `<div><span>Taxable value</span><b>₹ ${rupees(sale.taxable)}</b></div>
        <div><span>GST (${igstBill(sale) ? 'IGST' : 'CGST + SGST'})</span><b>₹ ${rupees(sale.cgst + sale.sgst + sale.igst)}</b></div>` : ''}
        <div class="b-grand"><span>TOTAL</span><b>₹ ${rupees(sale.total)}</b></div>
      </div>
    </div>
    <footer class="b-foot">
      <div class="b-terms">${gst ? 'Prices include GST. ' : ''}${esc(s.bill_footer)}<div class="b-thanks">Thank you for shopping with us! Visit again.</div></div>
      <div class="b-sign">For ${esc(s.shop_name)}<span>Authorised Signatory</span></div>
    </footer>
  </div>`;
}

// ---- thermal receipt: 80 mm or 58 mm paper roll, black only, as long as the bill ----
function thermalHtml(sale, s, duplicate) {
  const { date, time } = dateText(sale);
  const gst = isGstBill(sale);
  const qty = sale.items.reduce((a, i) => a + i.qty, 0);
  const items = sale.items.map((i, n) => `<div class="t-item">
      <div class="t-desc">${n + 1}. ${catOf(i) ? `<span class="t-cat">${esc(catOf(i))}</span> ` : ''}${esc(i.description)}${variant(i) ? ` (${esc(variant(i))})` : ''}</div>
      <div class="t-line"><span>${esc(i.code)}${gst && i.hsn ? ` · HSN ${esc(i.hsn)}` : ''}${gst ? ` · ${rateText(i.gst_rate)}` : ''}</span>
        <span>${i.qty} x ${rupees(i.price)}</span><b>${rupees(i.amount)}</b></div></div>`).join('');
  const pct = sale.discount ? Math.round((sale.discount / sale.subtotal) * 1000) / 10 : 0;
  const kv = (k, v, cls = '') => `<div class="t-kv ${cls}"><span>${k}</span><b>${v}</b></div>`;
  return `
  <div class="tsheet f-${s.bill_format}${gst ? ' t-gst' : ''}">
    ${logoSrc(s) ? `<img class="t-logo" src="${logoSrc(s)}" alt="" />` : ''}
    <div class="t-name">${esc(s.shop_name)}</div>
    ${s.shop_tagline ? `<div class="t-c">${esc(s.shop_tagline)}</div>` : ''}
    ${s.shop_address ? `<div class="t-c">${esc(s.shop_address)}</div>` : ''}
    ${s.shop_phones ? `<div class="t-c">Ph: ${esc(s.shop_phones)}</div>` : ''}
    ${s.gstin ? `<div class="t-c">GSTIN: <b>${esc(s.gstin)}</b></div>` : ''}
    <div class="t-title">${billTitle(sale)}${duplicate ? ' - DUPLICATE' : ''}</div>
    ${kv('Bill No.', sale.bill_no)}
    ${kv('Date', `${date} ${time}`)}
    ${sale.customer_name ? kv('Customer', esc(sale.customer_name)) : ''}
    ${sale.customer_phone ? kv('Mobile', esc(phoneText(sale.customer_phone))) : ''}
    ${sale.customer_gstin ? kv('Customer GSTIN', esc(sale.customer_gstin)) : ''}
    ${gst && supplyText(sale) ? kv('Place of supply', esc(supplyText(sale))) : ''}
    ${kv('Salesman', esc(sale.salesman))}
    <div class="t-rule"></div>
    <div class="t-line t-head"><span>Item / Barcode</span><span>Qty x Rate</span><b>Amount</b></div>
    ${items}
    <div class="t-rule"></div>
    ${kv('Subtotal', rupees(sale.subtotal))}
    ${sale.discount ? kv(`Discount${pct ? ` (${pct}%)` : ''}`, `- ${rupees(sale.discount)}`) : ''}
    ${kv('TOTAL Rs.', rupees(sale.total), 't-grand')}
    ${kv('Total qty', qty)}
    ${kv('Paid by', esc(paidText(sale, 'Rs.')))}
    <div class="t-words">${amountInWords(sale.total)}</div>
    ${gst ? `<div class="t-rule"></div>${taxTable(sale, 't-tax')}
      ${kv('Taxable value', rupees(sale.taxable))}${kv('Total GST', rupees(sale.cgst + sale.sgst + sale.igst))}
      <div class="t-c t-small">Prices include GST</div>` : ''}
    <div class="t-rule"></div>
    ${s.bill_footer ? `<div class="t-c t-small">${esc(s.bill_footer)}</div>` : ''}
    <div class="t-c t-thanks">Thank you for shopping with us! Visit again.</div>
  </div>`;
}

// Clears the print area after printing. Chromium also fires 'afterprint' while making a PDF,
// so a pending clear-up is cancelled whenever new content is rendered.
const clearArea = () => $('#printArea').replaceChildren();

// A thermal receipt's page is the roll width x the receipt's own length. The length is measured here, then
// given to the PDF and the printer (paper), and also set as the page size for printing (pageRule).
let paper = {};
let pageRule = null;
function setRollPage(widthMm, heightMm) {
  try {
    pageRule ??= new CSSStyleSheet();
    pageRule.replaceSync(heightMm ? `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }` : '');
    if (!document.adoptedStyleSheets.includes(pageRule)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageRule];
  } catch { /* the size also goes to the printer and the PDF directly */ }
}

// Fills the hidden print area and waits for the logo so PDFs never miss it.
async function render(sale, settings, { duplicate = false, single = false } = {}) {
  window.removeEventListener('afterprint', clearArea);
  const area = $('#printArea');
  paper = {};
  setRollPage(0, 0);
  if (!single && isThermal(settings)) {   // thermal: one receipt; the WhatsApp copy below always stays half A4
    area.innerHTML = thermalHtml(sale, settings, duplicate);
    await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
    area.classList.add('measure');   // laid out off screen, at its printed width, to measure its length
    const mm = (area.firstElementChild.getBoundingClientRect().height * 25.4) / 96;
    area.classList.remove('measure');
    const widthMm = settings.bill_format === 'thermal_58' ? 58 : 80;
    paper = { heightMm: Math.ceil(mm + 4) };
    setRollPage(widthMm, paper.heightMm);
    return;
  }
  const copies = single ? ['CUSTOMER COPY'] : ['CUSTOMER COPY', 'SHOP COPY'];
  area.innerHTML = `<div class="sheet${single ? ' single' : ''}">${copies
    .map((l) => copyHtml(sale, settings, l, duplicate)).join('')}</div>`;
  await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
}
const savePdf = (billNo, kind) => window.api.saveBillPdf(billNo, kind, paper);


export async function sendBillOnWhatsApp(sale, settings) {
  await render(sale, settings, { single: true });
  const half = $('#halfPage');
  half.disabled = false;
  try { await window.api.saveBillPdf(sale.bill_no, 'customer'); } finally { half.disabled = true; }
  return window.api.sendWhatsApp(sale.bill_no);
}

// Prints the print area on the printer chosen in Settings (no dialog). Printing switched off, or only a
// "Print to PDF" printer, is not a problem (the PDF is saved anyway); a missing or failing printer is.
const QUIET = /switched off|only saves files|^No printer$/;
export async function printBill() {
  const r = await window.api.printBill(paper);
  clearArea();
  return { printed: !!r.printed, problem: r.printed || QUIET.test(r.reason ?? '') ? null : r.reason };
}

// Settings > Print a test bill: a made-up bill in the chosen format on the chosen printer.
export async function testPrint(settings) {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const gst = settings.gst_billing === '1';
  const sale = { bill_no: 'TEST', salesman: '-', customer_name: 'Test print', customer_phone: '', customer_gstin: '',
    sold_at: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:00`,
    items: [{ code: 'TEST-1', description: 'Test item - check the lines and margins', size: 'M', colour: 'Blue', hsn: gst ? '6205' : '',
      qty: 1, price: 10500, amount: 10500, gst_rate: gst ? 500 : 0, taxable: gst ? 10000 : 0, cgst: gst ? 250 : 0, sgst: gst ? 250 : 0, igst: 0 }],
    payments: [{ method: 'cash', amount: 10500 }], subtotal: 10500, discount: 0, total: 10500,
    gst: gst ? 1 : 0, supply_state: gst ? String(settings.gstin).slice(0, 2) : '', taxable: gst ? 10000 : 0,
    cgst: gst ? 250 : 0, sgst: gst ? 250 : 0, igst: 0 };
  await render(sale, settings);
  return printBill();
}

// After a new bill is saved in the database, in this order:
//   1. save Bill-<no>.pdf   2. open the customer's WhatsApp chat   3. print (only on a real printer).
// The bill itself is already safely saved; `problems` lists anything that went wrong after that.
export async function finishSale(sale, settings, { whatsapp }) {
  const r = { problems: [], whatsapp: null, printed: false };
  try {
    await render(sale, settings);
    await savePdf(sale.bill_no, 'original');
  } catch (e) { r.problems.push(`PDF not saved: ${errText(e)}`); }
  if (whatsapp && sale.customer_phone) {
    try { r.whatsapp = await sendBillOnWhatsApp(sale, settings); } catch (e) { r.problems.push(`WhatsApp: ${errText(e)}`); }
  }
  await render(sale, settings);
  const pr = await printBill();
  r.printed = pr.printed;
  if (pr.problem) r.problems.push(pr.problem);
  return r;
}

// Reprint: saves Bill-<no>-DUPLICATE.pdf, then prints it (only on a real printer).
export async function reprintSale(sale, settings) {
  await render(sale, settings, { duplicate: true });
  try { await savePdf(sale.bill_no, 'duplicate'); }
  catch (e) { return { problem: `PDF not saved: ${errText(e)}` }; }
  const pr = await printBill();
  return { printed: pr.printed, problem: pr.problem };
}

// ---- credit note (return / exchange): half an A4 page, or a thermal receipt ----
const noteSaid = 'Use this credit note to pay for any bill at our shop. No cash refund.';
function creditA4Html(note, s) {
  const d = new Date(note.created_at.replace(' ', 'T'));
  const gst = note.gst === 1;
  const cols = gst ? 7 : 5;
  const rows = note.items.map((i, n) => `<tr><td class="c">${n + 1}</td>
    <td>${esc(i.description)}${variant(i) ? ` <span class="b-var">${esc(variant(i))}</span>` : ''}</td><td>${esc(i.code)}</td>
    ${gst ? `<td>${esc(i.hsn)}</td>` : ''}<td class="n">${i.qty}</td>${gst ? `<td class="n">${rateText(i.gst_rate)}</td>` : ''}
    <td class="n">${rupees(i.amount)}</td></tr>`);
  while (rows.length < 6) rows.push(`<tr class="blank">${'<td></td>'.repeat(cols)}</tr>`);
  const used = note.amount - note.balance;
  return `<div class="sheet single"><div class="copy cnote t-${['indigo', 'orange', 'green', 'maroon', 'black'].includes(s.bill_theme) ? s.bill_theme : 'indigo'}">
    <header class="b-head${logoSrc(s) ? '' : ' no-logo'}">
      ${logoSrc(s) ? `<img class="b-logo" src="${logoSrc(s)}" alt="" />` : ''}
      <div class="b-shop"><div class="b-name">${esc(s.shop_name)}</div><div class="b-tag">${esc(s.shop_tagline)}</div>
        <div>${esc(s.shop_address)}</div><div>Ph: ${esc(s.shop_phones)}</div>${s.gstin ? `<div>GSTIN: <b>${esc(s.gstin)}</b></div>` : ''}</div>
      <div class="b-box"><div class="b-title">CREDIT NOTE</div>
        <div class="b-kv"><span>No.</span><b class="b-no">CN-${note.note_no}</b></div>
        <div class="b-kv"><span>Date</span><b>${d.toLocaleDateString('en-GB')}</b></div>
        <div class="b-kv"><span>Against bill</span><b>${note.bill_no} (${new Date(note.bill_date.replace(' ', 'T')).toLocaleDateString('en-GB')})</b></div></div>
    </header>
    <div class="b-cust${note.customer_gstin ? ' with-gstin' : ''}">
      <div class="f wide"><label>Customer</label><span>${esc(note.customer_name)}</span></div>
      <div class="f"><label>Mobile</label><span>${esc(phoneText(note.customer_phone))}</span></div>
      ${note.customer_gstin ? `<div class="f"><label>Customer GSTIN</label><span>${esc(note.customer_gstin)}</span></div>` : ''}
      <div class="f"><label>Taken back by</label><span>${esc(note.made_by)}</span></div>
      <div class="tag">ITEMS RETURNED</div>
    </div>
    <table class="b-items cn${gst ? ' gst' : ''}"><colgroup>${'<col>'.repeat(cols)}</colgroup>
      <thead><tr><th class="c">Sr.</th><th>Particulars</th><th>Barcode</th>${gst ? '<th>HSN</th>' : ''}<th class="n">Qty</th>
        ${gst ? '<th class="n">GST</th>' : ''}<th class="n">Value ₹</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <div class="b-bottom">
      <div class="b-info">
        <div><label>Amount in words</label><b>${amountInWords(note.amount)}</b></div>
        <div>${noteSaid}${note.exchange_bill_no ? ` Used on exchange bill ${note.exchange_bill_no}.` : ''}</div>
        ${gst ? `<div class="b-tax">${taxTable(note, 'b-taxt')}</div>` : ''}
      </div>
      <div class="b-sum">
        <div><span>Credit</span><b>₹ ${rupees(note.amount)}</b></div>
        ${gst ? `<div><span>Taxable value</span><b>₹ ${rupees(note.taxable)}</b></div>
          <div><span>GST reversed</span><b>₹ ${rupees(note.cgst + note.sgst + note.igst)}</b></div>` : ''}
        <div><span>Used</span><b>− ₹ ${rupees(used)}</b></div>
        <div class="b-grand"><span>BALANCE</span><b>₹ ${rupees(note.balance)}</b></div>
      </div>
    </div>
    <footer class="b-foot"><div class="b-terms">${esc(s.bill_footer)}</div>
      <div class="b-sign">For ${esc(s.shop_name)}<span>Authorised Signatory</span></div></footer>
  </div></div>`;
}

function creditThermalHtml(note, s) {
  const d = new Date(note.created_at.replace(' ', 'T'));
  const gst = note.gst === 1;
  const kv = (k, v, cls = '') => `<div class="t-kv ${cls}"><span>${k}</span><b>${v}</b></div>`;
  return `<div class="tsheet f-${s.bill_format}${gst ? ' t-gst' : ''}">
    ${logoSrc(s) ? `<img class="t-logo" src="${logoSrc(s)}" alt="" />` : ''}
    <div class="t-name">${esc(s.shop_name)}</div>
    ${s.shop_phones ? `<div class="t-c">Ph: ${esc(s.shop_phones)}</div>` : ''}
    ${s.gstin ? `<div class="t-c">GSTIN: <b>${esc(s.gstin)}</b></div>` : ''}
    <div class="t-title">CREDIT NOTE</div>
    ${kv('No.', `CN-${note.note_no}`)}${kv('Date', d.toLocaleDateString('en-GB'))}${kv('Against bill', note.bill_no)}
    ${note.customer_name ? kv('Customer', esc(note.customer_name)) : ''}${note.customer_phone ? kv('Mobile', esc(phoneText(note.customer_phone))) : ''}
    ${kv('Taken back by', esc(note.made_by))}
    <div class="t-rule"></div>
    ${note.items.map((i, n) => `<div class="t-item"><div class="t-desc">${n + 1}. ${esc(i.description)}${variant(i) ? ` (${esc(variant(i))})` : ''}</div>
      <div class="t-line"><span>${esc(i.code)}${gst ? ` · ${rateText(i.gst_rate)}` : ''}</span><span>x ${i.qty}</span><b>${rupees(i.amount)}</b></div></div>`).join('')}
    <div class="t-rule"></div>
    ${kv('Credit', rupees(note.amount))}${kv('Used', `- ${rupees(note.amount - note.balance)}`)}
    ${kv('BALANCE Rs.', rupees(note.balance), 't-grand')}
    ${gst ? `<div class="t-rule"></div>${taxTable(note, 't-tax')}` : ''}
    <div class="t-rule"></div><div class="t-c t-small">${noteSaid}</div>
  </div>`;
}

/** Draws a credit note in the print area (measured like a bill on thermal paper). */
export async function renderCredit(note, settings) {
  window.removeEventListener('afterprint', clearArea);
  const area = $('#printArea');
  paper = {};
  setRollPage(0, 0);
  area.innerHTML = isThermal(settings) ? creditThermalHtml(note, settings) : creditA4Html(note, settings);
  await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
  if (isThermal(settings)) {
    area.classList.add('measure');
    const mm = (area.firstElementChild.getBoundingClientRect().height * 25.4) / 96;
    area.classList.remove('measure');
    paper = { heightMm: Math.ceil(mm + 4) };
    setRollPage(settings.bill_format === 'thermal_58' ? 58 : 80, paper.heightMm);
  }
}

/** Saves CreditNote-<no>.pdf and, when asked, prints it. */
export async function finishCredit(noteNo, settings, { print = true } = {}) {
  const note = await window.api.getCreditNote(noteNo);
  const r = { problems: [], printed: false, note };
  try { await renderCredit(note, settings); await window.api.saveCreditPdf(note.note_no, paper); }
  catch (e) { r.problems.push(`PDF not saved: ${errText(e)}`); }
  if (print) {
    await renderCredit(note, settings);
    const pr = await printBill();
    r.printed = pr.printed;
    if (pr.problem) r.problems.push(pr.problem);
  } else clearArea();
  return r;
}

// via 'web': the app's own WhatsApp window (first time only: scan its QR code with the shop's phone)
export const waNote = (w) => `WhatsApp opened${w?.via === 'web' ? ' in its window' : ''} - ${w?.copied
  ? 'press Ctrl+V in the chat to attach the bill, then Send' : 'attach the bill from the bills folder'}`;

// ---- search & reprint; returns without a new bill; credit notes ----
async function findBill() {
  const out = $('#billResult');
  const q = $('#billNo').value.trim();
  if (/^cn/i.test(q)) return showNote(q);
  const n = Number(q);
  const sale = Number.isInteger(n) && n > 0 ? await window.api.getSale(n) : null;
  if (!sale) { out.textContent = q ? 'No bill found with that number' : 'Enter a bill number, or CN-5 for a credit note'; return; }
  const who = [sale.customer_name, sale.customer_phone].filter(Boolean).map(esc).join(' · ');
  out.innerHTML = `<p>Bill <b>${sale.bill_no}</b> · ${esc(sale.sold_at)} · ${esc(sale.salesman)}
    · ₹${rupees(sale.total)} · ${sale.items.length} line(s)${who ? ` · ${who}` : ''}</p>
    ${sale.exchange ? `<p class="note">Exchange bill: items came back from bill ${sale.exchange.bill_no} (credit note CN-${sale.exchange.note_no}).</p>` : ''}
    ${sale.returns.length ? `<p class="note">Items returned from this bill: ${sale.returns.map((c) =>
      `<a href="#" data-cn="${c.note_no}">CN-${c.note_no}</a> (₹${rupees(c.amount)})`).join(', ')}</p>` : ''}
    <div class="actions">
      <button id="reprint">Reprint (Duplicate)</button>
      <button id="billWa" class="ghost wa wa-only" ${sale.customer_phone ? '' : 'disabled title="No mobile number on this bill"'}>Send on WhatsApp</button>
      <button id="billPdf" class="ghost">Open PDF</button>
      <button id="billReturn" class="ghost">Return items</button>
      <span id="findMsg"></span>
    </div>
    <div id="returnBox" class="card exch" hidden>
      <div class="exch-head"><b>Items coming back - the customer gets a credit note (no cash)</b></div>
      <p id="retInfo" class="note"></p>
      <table><thead><tr><th>Barcode</th><th>Item</th><th class="sc">Size</th><th class="sc">Colour</th><th class="num">Sold</th>
        <th class="num">Back before</th><th class="num">Coming back</th><th class="num">Value ₹</th></tr></thead><tbody id="retRows"></tbody></table>
      <div class="actions"><button id="retSave" disabled>Make credit note</button><b id="retTotal"></b></div>
    </div>`;
  const msg = (t, ok) => { const m = $('#findMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
  for (const a of out.querySelectorAll('[data-cn]')) a.addEventListener('click', (e) => { e.preventDefault(); showNote(a.dataset.cn); });
  $('#reprint').addEventListener('click', async () => {
    const r = await reprintSale(sale, await window.api.getSettings());
    if (r.problem) msg(r.problem, false);
    else msg(`Saved Bill-${sale.bill_no}-DUPLICATE.pdf${r.printed ? ' and sent to printer' : ''}`, true);
  });
  $('#billWa').addEventListener('click', async () => {
    try { msg(waNote(await sendBillOnWhatsApp(sale, await window.api.getSettings())), true); }
    catch (e) { msg(errText(e), false); }
  });
  $('#billPdf').addEventListener('click', async () => {
    try {
      try { await window.api.openBillPdf(sale.bill_no, 'original'); }
      catch {   // bills made before PDFs were saved: create it now
        await render(sale, await window.api.getSettings());
        await savePdf(sale.bill_no, 'original');
        $('#printArea').replaceChildren();
        await window.api.openBillPdf(sale.bill_no, 'original');
      }
    } catch (e) { msg(errText(e), false); }
  });
  // Return items: pick what comes back, then the credit note is made, saved as PDF and printed
  $('#billReturn').addEventListener('click', async () => {
    const bill = await window.api.returnable(sale.bill_no);
    $('#returnBox').hidden = false;
    $('#retInfo').textContent = billLine(bill);
    const t = returnRows($('#retRows'), bill, () => {
      $('#retTotal').textContent = t.any() ? `Credit note: ₹${rupees(t.total())}` : '';
      $('#retSave').disabled = !t.any();
    });
    $('#retSave').onclick = async () => {
      const btn = $('#retSave');
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const no = await window.api.createReturn(sale.bill_no, t.picks());
        const r = await finishCredit(no, await window.api.getSettings(), { print: true });
        await findBill();
        await loadRecentNotes();
        msg(r.problems.length ? `Credit note CN-${no} made. ${r.problems.join(' · ')}`
          : `Credit note CN-${no} for ₹${rupees(r.note.amount)} made - saved as CreditNote-${no}.pdf${r.printed ? ', sent to printer' : ''}`,
        !r.problems.length);
      } catch (e) { msg(errText(e), false); btn.disabled = false; }
    };
    $('#returnBox').scrollIntoView({ block: 'nearest' });
  });
}
$('#findBill').addEventListener('click', findBill);

// a credit note: what came back, what is left on it, reprint
async function showNote(no) {
  const out = $('#billResult');
  const note = await window.api.getCreditNote(no);
  if (!note) { out.textContent = `No credit note ${esc(String(no).toUpperCase())}`; return; }
  $('#billNo').value = `CN-${note.note_no}`;
  out.innerHTML = `<p>Credit note <b>CN-${note.note_no}</b> · ${esc(when(note.created_at))} · against bill
    <a href="#" id="cnBill">${note.bill_no}</a> · taken back by ${esc(note.made_by)}${note.customer_name ? ` · ${esc(note.customer_name)}` : ''}</p>
    <table><thead><tr><th>Barcode</th><th>Item</th><th class="sc">Size</th><th class="sc">Colour</th><th class="num">Qty</th><th class="num">Value ₹</th></tr></thead>
      <tbody>${note.items.map((i) => `<tr><td>${esc(i.code)}</td><td>${esc(i.description)}</td><td class="sc">${esc(i.size)}</td>
        <td class="sc">${esc(i.colour)}</td><td class="num">${i.qty}</td><td class="num">${rupees(i.amount)}</td></tr>`).join('')}</tbody></table>
    <p>Credit ₹${rupees(note.amount)}${note.used_on.length ? ` · used on ${note.used_on.map((u) => `bill ${u.bill_no} (₹${rupees(u.amount)})`).join(', ')}` : ''}
      · <b class="${note.balance ? 'ok' : ''}">balance ₹${rupees(note.balance)}</b></p>
    <div class="actions"><button id="cnPrint">Reprint credit note</button><button id="cnPdf" class="ghost">Open PDF</button><span id="findMsg"></span></div>`;
  const msg = (t, ok) => { const m = $('#findMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
  $('#cnBill').addEventListener('click', (e) => { e.preventDefault(); $('#billNo').value = note.bill_no; findBill(); });
  $('#cnPrint').addEventListener('click', async () => {
    const r = await finishCredit(note.note_no, await window.api.getSettings(), { print: true });
    msg(r.problems.length ? r.problems.join(' · ') : `Saved CreditNote-${note.note_no}.pdf${r.printed ? ' and sent to printer' : ''}`, !r.problems.length);
  });
  $('#cnPdf').addEventListener('click', async () => {
    try {
      try { await window.api.openCreditPdf(note.note_no); }
      catch { await finishCredit(note.note_no, await window.api.getSettings(), { print: false }); await window.api.openCreditPdf(note.note_no); }
    } catch (e) { msg(errText(e), false); }
  });
}

// ---- last 10 bills and credit notes: click one to open it ----
async function loadRecentBills() {
  const rows = await window.api.recentBills();
  $('#recentBills').innerHTML = !rows.length ? '<p class="note">No bills yet.</p>'
    : `<table class="pick"><thead><tr><th>Bill No</th><th>Date &amp; time</th><th>Customer</th><th>Salesman</th>
        <th class="num">Items</th><th class="num">Total ₹</th></tr></thead><tbody>${rows.map((b) =>
      `<tr data-bill="${b.bill_no}"><td><b>${b.bill_no}</b></td><td>${esc(when(b.sold_at))}</td>
        <td>${esc([b.customer_name, b.customer_phone].filter(Boolean).join(' · ') || '-')}</td><td>${esc(b.salesman)}</td>
        <td class="num">${b.units}</td><td class="num">${rupees(b.total)}</td></tr>`).join('')}</tbody></table>`;
  for (const tr of $('#recentBills').querySelectorAll('tr[data-bill]')) {
    tr.addEventListener('click', () => { $('#billNo').value = tr.dataset.bill; findBill(); });
  }
}
async function loadRecentNotes() {
  const rows = await window.api.recentReturns();
  $('#recentNotes').innerHTML = !rows.length ? '<p class="note">No credit notes yet.</p>'
    : `<table class="pick"><thead><tr><th>Credit note</th><th>Date &amp; time</th><th>From bill</th><th>Customer</th><th>Taken back by</th>
        <th class="num">Value ₹</th><th class="num">Balance ₹</th></tr></thead><tbody>${rows.map((c) =>
      `<tr data-cn="${c.note_no}"><td><b>CN-${c.note_no}</b></td><td>${esc(when(c.created_at))}</td>
        <td>${c.bill_no}${c.exchange_bill_no ? ` → exchange bill ${c.exchange_bill_no}` : ''}</td>
        <td>${esc([c.customer_name, c.customer_phone].filter(Boolean).join(' · ') || '-')}</td><td>${esc(c.made_by)}</td>
        <td class="num">${rupees(c.amount)}</td><td class="num">${rupees(c.balance)}</td></tr>`).join('')}</tbody></table>`;
  for (const tr of $('#recentNotes').querySelectorAll('tr[data-cn]')) tr.addEventListener('click', () => showNote(tr.dataset.cn));
}
document.querySelector('[data-view="bills"]').addEventListener('click', () => { loadRecentBills(); loadRecentNotes(); });
$('#billNo').addEventListener('keydown', (e) => e.key === 'Enter' && findBill());

onPage('bills', {
  refresh: async () => {
    await loadRecentBills();
    await loadRecentNotes();
    if ($('#billNo').value && $('#billResult').childElementCount) await findBill();   // keep the open bill, freshly loaded
  },
  reset: () => { $('#billNo').value = ''; $('#billResult').replaceChildren(); loadRecentNotes(); return loadRecentBills(); },
});

// used by the screenshot/visual checks: draw a bill into the print area without printing it
export { render as renderBill };

/** Back to plain A4 pages (no thermal receipt size) - for barcode sticker sheets. */
export function resetPrintPage() {
  window.removeEventListener('afterprint', clearArea);
  paper = {};
  setRollPage(0, 0);
}

// ---- udhaar payment receipt: half an A4 page, or a thermal slip ----
function receiptA4Html(r, s) {
  const d = new Date(r.created_at.replace(' ', 'T'));
  const how = r.method === 'credit_note' ? `Credit note CN-${r.note_no}` : modeLabel(r.method);
  return `<div class="sheet single"><div class="copy rcpt t-${['indigo', 'orange', 'green', 'maroon', 'black'].includes(s.bill_theme) ? s.bill_theme : 'indigo'}">
    <header class="b-head${logoSrc(s) ? '' : ' no-logo'}">
      ${logoSrc(s) ? `<img class="b-logo" src="${logoSrc(s)}" alt="" />` : ''}
      <div class="b-shop"><div class="b-name">${esc(s.shop_name)}</div><div class="b-tag">${esc(s.shop_tagline)}</div>
        <div>${esc(s.shop_address)}</div><div>Ph: ${esc(s.shop_phones)}</div></div>
      <div class="b-box"><div class="b-title">RECEIPT</div>
        <div class="b-kv"><span>No.</span><b class="b-no">RC-${r.receipt_no}</b></div>
        <div class="b-kv"><span>Date</span><b>${d.toLocaleDateString('en-GB')}</b></div>
        <div class="b-kv"><span>Time</span><b>${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</b></div></div>
    </header>
    <div class="rc-body">
      <p>Received with thanks from <b>${esc(r.name || 'customer')}</b> (${esc(phoneText(r.phone))})</p>
      <p class="rc-amt">₹ ${rupees(r.amount)}</p>
      <p><b>${amountInWords(r.amount)}</b></p>
      <p>Paid by: <b>${esc(how)}</b>${r.note ? ` · ${esc(r.note)}` : ''} · towards udhaar (pay later)</p>
      <div class="rc-sum"><div><span>Owed before</span><b>₹ ${rupees(r.owed_before)}</b></div>
        <div><span>Paid now</span><b>− ₹ ${rupees(r.amount)}</b></div>
        <div class="b-grand"><span>STILL OWED</span><b>₹ ${rupees(r.owed_after)}</b></div></div>
    </div>
    <footer class="b-foot"><div class="b-terms">Received by ${esc(r.made_by)}</div>
      <div class="b-sign">For ${esc(s.shop_name)}<span>Authorised Signatory</span></div></footer>
  </div></div>`;
}

function receiptThermalHtml(r, s) {
  const d = new Date(r.created_at.replace(' ', 'T'));
  const kv = (k, v, cls = '') => `<div class="t-kv ${cls}"><span>${k}</span><b>${v}</b></div>`;
  return `<div class="tsheet f-${s.bill_format}">
    <div class="t-name">${esc(s.shop_name)}</div>${s.shop_phones ? `<div class="t-c">Ph: ${esc(s.shop_phones)}</div>` : ''}
    <div class="t-title">RECEIPT</div>
    ${kv('No.', `RC-${r.receipt_no}`)}${kv('Date', `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`)}
    ${kv('From', esc(r.name || '-'))}${kv('Mobile', esc(phoneText(r.phone)))}
    <div class="t-rule"></div>
    ${kv('Received Rs.', rupees(r.amount), 't-grand')}
    ${kv('Paid by', esc(r.method === 'credit_note' ? `Credit note CN-${r.note_no}` : modeLabel(r.method)))}
    <div class="t-words">${amountInWords(r.amount)}</div>
    <div class="t-rule"></div>
    ${kv('Owed before', rupees(r.owed_before))}${kv('Still owed', rupees(r.owed_after))}
    <div class="t-rule"></div><div class="t-c t-small">Received by ${esc(r.made_by)} - thank you!</div>
  </div>`;
}

/** Saves Receipt-<no>.pdf and prints it (like a bill). */
export async function finishReceipt(no, settings) {
  const r = await window.api.udhaarReceipt(no);
  const out = { problems: [], printed: false };
  const draw = async () => {
    window.removeEventListener('afterprint', clearArea);
    const area = $('#printArea');
    paper = {};
    setRollPage(0, 0);
    area.innerHTML = isThermal(settings) ? receiptThermalHtml(r, settings) : receiptA4Html(r, settings);
    await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
    if (isThermal(settings)) {
      area.classList.add('measure');
      const mm = (area.firstElementChild.getBoundingClientRect().height * 25.4) / 96;
      area.classList.remove('measure');
      paper = { heightMm: Math.ceil(mm + 4) };
      setRollPage(settings.bill_format === 'thermal_58' ? 58 : 80, paper.heightMm);
    }
  };
  try { await draw(); await window.api.saveReceiptPdf(r.receipt_no, paper); } catch (e) { out.problems.push(`PDF not saved: ${errText(e)}`); }
  await draw();
  const pr = await printBill();
  out.printed = pr.printed;
  if (pr.problem) out.problems.push(pr.problem);
  return out;
}
