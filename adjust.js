import { $, esc, errText, when } from './util.js';
import { onPage } from './page.js';

const TYPE = { stock_in: 'Stock in', sale: 'Sale', adjustment: 'Adjustment' };
const setMsg = (t, ok) => { const m = $('#adjMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

async function lookup() {
  const code = $('#adjCode').value.trim();
  if (!code) {
    $('#adjName').textContent = '';
    $('#adjHistory').replaceChildren();
    $('#adjHistTitle').hidden = true;
    return false;
  }
  const found = await window.api.findProduct(code);   // also a barcode linked before 1.5.0
  if (found && found.code !== code) $('#adjCode').value = found.code;
  const hit = found && (await window.api.listProducts(found.code)).find((p) => p.code === found.code);
  $('#adjName').textContent = hit ? [hit.name, hit.size, hit.colour].filter(Boolean).join(' · ') + ` · stock ${hit.stock}` : 'Barcode not found';
  const rows = hit ? await window.api.stockHistory(hit.code) : [];
  $('#adjHistTitle').textContent = `All movements for ${hit?.code ?? code}`;
  $('#adjHistTitle').hidden = !rows.length;
  $('#adjHistory').innerHTML = rows.length
    ? `<table><thead><tr><th>Date</th><th>Type</th><th class="num">Qty</th><th>Details</th></tr></thead><tbody>${
        rows.map((r) => `<tr><td>${esc(when(r.created_at))}</td><td>${TYPE[r.type]}</td>
          <td class="num">${r.qty > 0 ? '+' : ''}${r.qty}</td>
          <td>${esc(r.bill_no ? `Bill ${r.bill_no}` : r.note ?? '')}</td></tr>`).join('')
      }</tbody></table>`
    : '';
  return !!hit;
}

$('#adjCode').addEventListener('change', lookup);
$('#adjCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup().then((ok) => ok && $('#adjQty').focus()); } });

$('#adjSave').addEventListener('click', async () => {
  const qty = Number($('#adjQty').value);
  const note = $('#adjNote').value.trim();
  if (!(await lookup())) return setMsg('Scan or type a barcode that is saved', false);
  const code = $('#adjCode').value.trim();
  if (!confirm(`Adjust ${code} by ${qty > 0 ? '+' : ''}${qty}?\nReason: ${note || '(none)'}`)) return;
  try {
    await window.api.adjustStock({ code, qty, note });
    $('#adjQty').value = '';
    $('#adjNote').value = '';
    await lookup();
    await loadAdjustments();
    setMsg('Adjustment saved', true);
  } catch (e) { setMsg(errText(e), false); }
});

// ---- last 10 adjustments, all products ----
async function loadAdjustments() {
  const rows = await window.api.recentAdjustments();
  $('#adjRecent').innerHTML = !rows.length ? '<p class="note">No adjustments yet.</p>'
    : `<table><thead><tr><th>Date &amp; time</th><th>Barcode</th><th>Name</th><th>Size</th><th>Colour</th><th class="num">Change</th><th>Reason</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(when(r.created_at))}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.size)}</td><td>${esc(r.colour)}</td>
        <td class="num ${r.qty < 0 ? 'low' : ''}">${r.qty > 0 ? '+' : ''}${r.qty}</td><td>${esc(r.note ?? '')}</td></tr>`).join('')}</tbody></table>`;
}
document.querySelector('[data-view="adjust"]').addEventListener('click', loadAdjustments);

onPage('adjust', {
  refresh: async () => { await loadAdjustments(); if ($('#adjCode').value.trim()) await lookup(); },
  reset: async () => {
    for (const id of ['#adjCode', '#adjQty', '#adjNote']) $(id).value = '';
    $('#adjMsg').textContent = '';
    await lookup();
    return loadAdjustments();
  },
});
