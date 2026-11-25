// Stock In > Import from Excel: choose a file, look at every row, then Import (main/import.js).
import { $, esc, errText, rupees } from './util.js';
import { isOwner } from './session.js';

const STATE = {
  new: ['New item', 'ok'], existing: ['Adds to existing item', 'ok'], merged: ['Same barcode as another row - qty added there', 'dim'],
  problem: ['', 'err'],
};
const msg = (t, ok) => { const m = $('#importMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function show(p) {
  const c = p.counts;
  const good = c.new + c.existing;
  $('#importSummary').innerHTML = `<b>${esc(p.file)}</b>: ${plural(c.rows, 'row')} - `
    + `<span class="ok">${plural(c.new, 'new item')}, ${plural(c.existing, 'existing item')}</span>`
    + (c.merged ? `, ${plural(c.merged, 'repeated row')} added together` : '')
    + (c.problems ? `, <span class="err">${plural(c.problems, 'row')} with a problem (not imported - fix them in Excel and import again)</span>` : '')
    + `. Stock to add: ${c.units} piece(s).`
    + (c.rows > p.rows.length ? ` <span class="note">Showing the first ${p.rows.length} rows; problems are listed first.</span>` : '');
  $('#importRows').innerHTML = p.rows.map((r) => {
    const [text, cls] = STATE[r.state] ?? ['', ''];
    return `<tr class="${r.state === 'problem' ? 'bad-row' : ''}"><td>${r.row}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.size)}</td>
      <td>${esc(r.colour)}</td><td class="num">${Number.isFinite(r.qty) ? r.qty : esc(r.qty)}</td><td class="num">${r.rate == null ? '-' : Number.isFinite(r.rate) ? rupees(r.rate) : '?'}</td>
      <td class="${cls}">${esc(r.state === 'problem' ? r.problem : text)}</td></tr>`;
  }).join('');
  $('#importGo').textContent = good ? `Import ${plural(good, 'item')}` : 'Nothing to import';
  $('#importGo').disabled = !good;
  $('#importPreview').hidden = false;
  msg('', true);
}

function close() {
  $('#importPreview').hidden = true;
  $('#importRows').replaceChildren();
}

$('#importTemplate').addEventListener('click', async () => {
  try { msg(`Template saved and opened: ${await window.api.importTemplate()}`, true); }
  catch (e) { msg(errText(e), false); }
});

$('#importPick').addEventListener('click', async () => {
  try {
    msg('Reading the file...', true);
    const p = await window.api.importPick();
    if (!p) return msg('', true);   // no file chosen
    show(p);
  } catch (e) { close(); msg(errText(e), false); }
});
// tests: the same preview for a file path
window.__importFile = async (file) => show(await window.api.importFile(file));

$('#importGo').addEventListener('click', async () => {
  const btn = $('#importGo');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await window.api.importConfirm();
    close();
    msg(`Imported ${plural(r.items, 'item')} (${r.units} piece(s) added to stock)`, true);
    document.dispatchEvent(new CustomEvent('stock-imported'));   // the last entry and products list refresh
  } catch (e) { msg(errText(e), false); btn.disabled = false; }
});

$('#importCancel').addEventListener('click', async () => { await window.api.importCancel(); close(); msg('Import cancelled - nothing was saved', true); });

if (!isOwner()) close();
