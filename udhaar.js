// Udhaar tab (owner): who owes what, each customer's account, payments received (with a receipt), credit limits.
// The money rules are in main/udhaar.js.
import { $, esc, errText, toPaise, rupees, when } from './util.js';
import { onPage } from './page.js';
import { modes, modeLabel } from './shop.js';
import { signedIn } from './session.js';
import { finishReceipt } from './bills.js';

await signedIn;
const msg = (t, ok) => { const m = $('#udMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
const phoneText = (p) => `${p.slice(0, 5)} ${p.slice(5)}`;
let list = [];
let open = null;   // the phone of the account on screen

async function loadList() {
  const r = await window.api.udhaarList();
  list = r.rows;
  $('#udTotal').textContent = rupees(r.total);
  $('#udCount').textContent = r.customers;
  $('#udOff').hidden = modes().some((m) => m.id === 'udhaar');
  drawList();
}

function drawList() {
  const q = $('#udSearch').value.trim().toLowerCase();
  const rows = list.filter((r) => !q || r.name.toLowerCase().includes(q) || r.phone.includes(q.replace(/\D/g, '') || '§'));
  $('#udList').innerHTML = !rows.length ? '<p class="note">Nobody owes anything. Bills paid with "Pay Later (Udhaar)" show up here.</p>'
    : `<table><thead><tr><th>Customer</th><th>Mobile</th><th class="num">Owes ₹</th><th class="num">Limit ₹</th><th>Last udhaar</th><th>Last payment</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-phone="${r.phone}" class="${r.credit_limit != null && r.due > r.credit_limit ? 'over' : ''}">
        <td><b>${esc(r.name || '(no name)')}</b></td><td>${phoneText(r.phone)}</td><td class="num">${rupees(r.due)}</td>
        <td class="num">${r.credit_limit == null ? '-' : rupees(r.credit_limit)}</td>
        <td>${esc(r.last_udhaar ? when(r.last_udhaar) : '-')}</td><td>${esc(r.last_paid ? when(r.last_paid) : '-')}</td></tr>`).join('')}</tbody></table>`;
  for (const tr of $('#udList').querySelectorAll('tr[data-phone]')) tr.addEventListener('click', () => openAccount(tr.dataset.phone));
}

async function openAccount(phone) {
  const a = await window.api.udhaarAccount(phone);
  open = phone;
  $('#udAccount').hidden = false;
  $('#udName').textContent = a.name || '(no name)';
  $('#udPhone').textContent = `+91 ${phoneText(a.phone)}`;
  $('#udDue').textContent = rupees(a.due);
  $('#udLimitShow').textContent = a.limit == null ? 'No limit' : `₹ ${rupees(a.limit)}`;
  $('#udLimit').value = a.limit == null ? '' : String(a.limit / 100);
  $('#udAmount').value = a.due > 0 ? (a.due / 100).toFixed(2) : '';
  // how it was paid: the shop's modes (not udhaar itself), or a credit note from a return
  $('#udMethod').innerHTML = modes().filter((m) => m.id !== 'udhaar').map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')
    + '<option value="credit_note">Credit note</option>';
  $('#udNoteNo').hidden = true;
  $('#udHistory').innerHTML = !a.history.length ? '<p class="note">No udhaar yet.</p>'
    : `<table><thead><tr><th>Date</th><th>What</th><th class="num">Udhaar ₹</th><th class="num">Paid ₹</th><th class="num">Owes ₹</th></tr></thead>
      <tbody>${a.history.map((h) => `<tr><td>${esc(when(h.at))}</td>
        <td>${h.kind === 'bill' ? `Bill ${h.ref}` : `Receipt RC-${h.ref} · ${esc(h.method === 'credit_note' ? 'Credit note' : modeLabel(h.method))}${h.note ? ` · ${esc(h.note)}` : ''}`}</td>
        <td class="num">${h.kind === 'bill' ? rupees(h.amount) : ''}</td><td class="num">${h.kind === 'payment' ? rupees(h.amount) : ''}</td>
        <td class="num">${rupees(h.balance)}</td></tr>`).join('')}</tbody></table>`;
  $('#udAccount').scrollIntoView({ block: 'nearest' });
}

$('#udMethod').addEventListener('change', (e) => { $('#udNoteNo').hidden = e.target.value !== 'credit_note'; });
$('#udReceive').addEventListener('click', async () => {
  const btn = $('#udReceive');
  if (btn.disabled || !open) return;
  btn.disabled = true;
  try {
    const no = await window.api.udhaarReceive(open, { amount: toPaise($('#udAmount').value), method: $('#udMethod').value,
      note_no: $('#udNoteNo').value.trim(), note: $('#udNote').value });
    const r = await finishReceipt(no, await window.api.getSettings());
    $('#udNote').value = ''; $('#udNoteNo').value = '';
    await loadList(); await openAccount(open);
    msg(r.problems.length ? `Receipt RC-${no} saved. ${r.problems.join(' · ')}`
      : `Receipt RC-${no} saved as Receipt-${no}.pdf${r.printed ? ' and sent to the printer' : ''}`, !r.problems.length);
  } catch (e) { msg(errText(e), false); }
  finally { btn.disabled = false; }
});
$('#udLimitSave').addEventListener('click', async () => {
  if (!open) return;
  try {
    const v = $('#udLimit').value.trim();
    await window.api.udhaarLimit(open, v === '' ? null : toPaise(v));
    await loadList(); await openAccount(open);
    msg(v === '' ? 'No credit limit' : `Credit limit ₹${rupees(toPaise(v))}`, true);
  } catch (e) { msg(errText(e), false); }
});
$('#udClose').addEventListener('click', () => { open = null; $('#udAccount').hidden = true; msg('', true); });
$('#udSearch').addEventListener('input', drawList);
document.querySelector('[data-view="udhaar"]').addEventListener('click', loadList);
window.__udhaar = { openAccount };   // tests

onPage('udhaar', {
  refresh: async () => { await loadList(); if (open) await openAccount(open); },
  reset: () => { open = null; $('#udAccount').hidden = true; $('#udSearch').value = ''; return loadList(); },
});
