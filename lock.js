// The lock screen (lock.html): why the app is locked, the shop key, "Contact now" and updates.
// main/main.js swaps back to the app on its own once the lock lifts.
import { $, errText } from './util.js';

const UPDATE_TEXT = {
  idle: 'not checked yet', checking: 'checking for updates...', current: 'this is the latest version',
  available: (u) => `version ${u.version} is available`, downloading: (u) => `downloading ${u.progress}%`,
  ready: (u) => `version ${u.version} is ready to install`, error: (u) => `could not check: ${u.error}`,
  dev: 'updates are off in development mode',
};
const updateText = (u) => { const t = UPDATE_TEXT[u.status] ?? u.status; return typeof t === 'function' ? t(u) : t; };

let info = null;

function renderUpdate(u) {
  $('#lkUpdate').textContent = updateText(u);
  $('#lkDownload').hidden = u.status !== 'available';
  $('#lkInstall').hidden = u.status !== 'ready';
  $('#lkCheck').disabled = ['checking', 'downloading'].includes(u.status);
}

async function refresh() {
  info = await window.api.appInfo();
  $('#lkName').textContent = info.name;
  document.title = `${info.name} - locked`;
  $('#lkMessage').textContent = info.message || 'The app is locked. Please contact your vendor.';
  $('#lkVersion').textContent = `v${info.version}`;
  $('#lkKeyBox').hidden = !info.monitoringConfigured;
  const s = info.lastSync;
  $('#lkInfo').textContent = `${s.ok ? `Last contact: ${new Date(s.at).toLocaleString('en-IN')}` : 'Not connected yet'}`
    + ` - This PC: ${String(info.installId).slice(0, 12)}${s.error ? ` - ${s.error}` : ''}`;
  renderUpdate(info.update);
}

const busy = (btn, on) => { btn.disabled = on; };

$('#lkActivate').addEventListener('click', async () => {
  const m = $('#lkKeyMsg');
  m.textContent = 'Checking the key with the server... (it can take up to a minute when the server is waking up)'; m.className = '';
  busy($('#lkActivate'), true);
  try {
    await window.api.lockSetKey($('#lkKey').value);
    $('#lkKey').value = '';
    m.textContent = 'Accepted - opening the app...'; m.className = 'ok';
  } catch (e) { m.textContent = errText(e); m.className = 'err'; }
  busy($('#lkActivate'), false);
  refresh();
});
$('#lkSync').addEventListener('click', async () => {
  const m = $('#lkKeyMsg');
  m.textContent = 'Contacting the server... (up to a minute)'; m.className = '';
  busy($('#lkSync'), true);
  try { await window.api.lockSync(); m.textContent = ''; } catch (e) { m.textContent = errText(e); m.className = 'err'; }
  busy($('#lkSync'), false);
  refresh();
});
$('#lkCheck').addEventListener('click', async () => { await window.api.checkUpdate(); refresh(); });
$('#lkDownload').addEventListener('click', async () => { await window.api.downloadUpdate(); refresh(); });
$('#lkInstall').addEventListener('click', async () => {
  const r = await window.api.installUpdate();
  if (r && !r.ok) $('#lkUpdate').textContent = r.reason;
});
window.api.onUpdateStatus((u) => renderUpdate(u));

setInterval(refresh, 30_000);
refresh();
