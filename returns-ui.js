// "Which items are coming back?" - the table used by Billing (exchange) and Find Bill (return only).
// Each line of the old bill gets a Qty box (0 up to what can still come back); its value is what the customer
// paid for those pieces (main/gst.js returnShare - the same sum the credit note will use).
import { esc, rupees } from './util.js';
import { returnShare } from './gst.js';

/** Fills a <tbody> with the bill's lines. Returns { picks(), total(), any() }; onChange() runs on every change. */
export function returnRows(tbody, bill, onChange = () => {}) {
  tbody.innerHTML = bill.lines.map((l, n) => `<tr data-n="${n}" class="${l.left ? '' : 'dim'}">
    <td>${esc(l.code)}</td><td>${esc(l.description)}</td><td class="sc">${esc(l.size)}</td><td class="sc">${esc(l.colour)}</td>
    <td class="num">${l.qty}</td><td class="num">${l.returned || '-'}</td>
    <td class="num">${l.left ? `<input class="rq" type="number" min="0" max="${l.left}" step="1" value="0" />` : 'all back'}</td>
    <td class="num rv">0.00</td></tr>`).join('');
  const rows = [...tbody.querySelectorAll('tr')];
  const qtyOf = (tr) => {
    const i = tr.querySelector('.rq');
    if (!i) return 0;
    const l = bill.lines[tr.dataset.n];
    const q = Math.max(0, Math.min(l.left, Math.floor(Number(i.value) || 0)));
    if (String(q) !== i.value && i.value !== '') i.value = q;   // never more than can come back
    return q;
  };
  const value = (tr) => { const l = bill.lines[tr.dataset.n]; const q = qtyOf(tr); return q ? returnShare(l, l.qty, l.returned, q).amount : 0; };
  const update = () => { for (const tr of rows) tr.querySelector('.rv').textContent = rupees(value(tr)); onChange(); };
  for (const i of tbody.querySelectorAll('.rq')) i.addEventListener('input', update);
  return {
    picks: () => rows.map((tr) => ({ sale_item_id: bill.lines[tr.dataset.n].sale_item_id, qty: qtyOf(tr) })).filter((p) => p.qty > 0),
    total: () => rows.reduce((a, tr) => a + value(tr), 0),
    any: () => rows.some((tr) => qtyOf(tr) > 0),
  };
}

/** One line about the bill: date, customer, and the time limit for returns. */
export function billLine(bill) {
  const who = [bill.customer_name, bill.customer_phone].filter(Boolean).join(' · ');
  const age = bill.age === 0 ? 'today' : `${bill.age} day${bill.age === 1 ? '' : 's'} ago`;
  const limit = bill.overLimit ? ` - older than the ${bill.limit}-day limit: only the owner can take items back` : '';
  return `Bill ${bill.bill_no}, ${age}${who ? `, ${who}` : ''}${bill.gst ? ', tax invoice' : ''}${limit}`;
}
