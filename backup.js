import { $, esc, errText } from './util.js';

export function showBackup(s) {
  $('#backupInfo').innerHTML =
    `Folder: <b>${esc(s.dir)}</b><br>` +
    (s.at ? `Last backup: ${esc(s.at)}` : 'No backup completed yet') +
    (s.error ? `<br><span class="err">Last attempt failed: ${esc(s.error)}</span>` : '');
}

// ---- Google Drive copy ----
export async function showCloud() {
  const c = await window.api.cloudStatus();
  const box = $('#cloudInfo');
  if (!c.dir) {
    box.className = 'lic warn';
    box.textContent = c.suggested ? `Not set up yet. Google Drive found at ${c.suggested} - choose a folder in it.`
      : 'Not set up yet. Install Google Drive for Desktop and sign in, then choose a folder in "My Drive".';
  } else if (c.error) {
    box.className = 'lic lock';
    box.textContent = `Copying to ${c.dir} - last attempt failed: ${c.error}`;
  } else {
    box.className = 'lic good';
    box.textContent = `Copying to ${c.dir}${c.at ? ` - last copied ${c.at}${c.copied ? ` (${c.copied} new file(s))` : ', up to date'}` : ''}`;
  }
  $('#cloudChoose').textContent = c.dir ? 'Change folder...' : 'Choose Google Drive folder...';
  $('#cloudNow').hidden = !c.dir;
  $('#cloudStop').hidden = !c.dir;
}
const msg = (t, ok) => { const m = $('#cloudMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
const act = (fn) => async () => { try { const t = await fn(); if (t) msg(t, true); } catch (e) { msg(errText(e), false); } await showCloud(); };
$('#cloudChoose').addEventListener('click', act(async () => (await window.api.chooseCloudDir()) ? 'Google Drive copy is set up - copying now' : ''));
$('#cloudNow').addEventListener('click', act(async () => { const r = await window.api.copyToCloudNow(); return r.error ? '' : 'Copied'; }));
$('#cloudStop').addEventListener('click', act(async () => {
  if (!confirm('Stop copying to Google Drive? Files already there stay there.')) return '';
  await window.api.stopCloudCopy();
  return 'Google Drive copy stopped';
}));

// ---- restore (also used by the first-run setup screen) ----
export async function restoreFlow(show) {
  try {
    const b = await window.api.pickBackup();
    if (!b) return;
    const last = b.lastBill ? `last bill ${b.lastBill} on ${b.lastBillAt}` : 'no bills';
    if (!confirm(`Restore this backup?\n\nShop: ${b.shop}\nBills: ${b.bills} (${last})\nProducts: ${b.products}\nBackup saved: ${b.savedAt}\n\n`
      + 'The data in use now is saved first in the Backups folder, so this can be undone. The app restarts afterwards.')) return;
    const r = await window.api.restoreBackup(b.file);
    show(`Restored. The data from before is kept as ${r.safety}. Restarting...`, true);
  } catch (e) { show(errText(e), false); }
}
$('#restoreBtn').addEventListener('click', () => restoreFlow(msg));

$('#backupNow').addEventListener('click', async () => showBackup(await window.api.runBackup()));
document.querySelector('[data-view="settings"]').addEventListener('click', async () => {
  showBackup(await window.api.backupStatus());
  showCloud();
});
