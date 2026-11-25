import { $, esc, errText } from './util.js';
import { isOwner } from './session.js';
import { loadShop } from './shop.js';

const UPDATE_TEXT = {
  idle: 'Not checked yet',
  checking: 'Checking for updates...',
  current: 'You have the latest version',
  available: (u) => `Version ${u.version} is available`,
  downloading: (u) => `Downloading ${u.progress}%`,
  ready: (u) => `Version ${u.version} is ready to install`,
  error: (u) => `Could not check: ${u.error}`,
  dev: 'Updates are off in development mode',
};
const updateText = (u) => {
  const t = UPDATE_TEXT[u.status] ?? u.status;
  return typeof t === 'function' ? t(u) : t;
};

let info = null;

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const LICENCE_TEXT = {   // [colour, text] for the status line in Settings > Activation
  trial: (l) => ['warn', `Trial version - ${days(l.daysLeft)} left. Enter your shop key to activate.`],
  trial_over: () => ['lock', 'Trial ended - enter your shop key to continue billing.'],
  other_pc: () => ['lock', 'This shop key is already used on another computer. Ask your vendor to move it to this PC.'],
  active: () => ['good', 'Activated on this computer.'],
  offline_warn: (l) => ['warn', `Activated - connect to the internet within ${days(l.daysLeft)}.`],
  offline_over: () => ['lock', 'Activated, but not connected for 7 days - connect to the internet and press Contact now.'],
};

function renderBanner() {
  const b = $('#banner');
  if (!info) return;
  const lines = [];
  let cls = 'warn';
  if (info.locked) { lines.push(info.message || 'Billing is locked. Please contact your vendor.'); cls = 'lock'; }
  else {
    if (info.message) lines.push(info.message);
    if (info.lockWarning)
      lines.push(`${info.lockWarning.message} (locks on ${new Date(info.lockWarning.date).toLocaleDateString('en-GB')})`);
    if (info.notice) lines.push(info.notice);   // trial days left, connect soon, key on another PC
  }
  if (info.updateRequired) lines.push('An update is required. Open Settings to install it.');
  else if (['available', 'ready'].includes(info.update.status)) lines.push(`${updateText(info.update)}. Open Settings.`);
  b.hidden = !lines.length;
  b.className = `banner ${cls}`;
  b.textContent = lines.join('  |  ');
}

// Settings > Activation: how long the shop may bill (days given by the vendor)
const istDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
function subLine(sub) {
  if (!sub || sub.state === 'none') return '';
  const what = sub.trial ? 'Trial' : 'Subscription';
  const cls = { ok: 'ok', warn: 'warn', grace: 'err', over: 'err' }[sub.state] ?? '';
  const text = sub.state === 'over' ? `${what} ended on ${istDate(sub.until)} - the app is paused`
    : sub.state === 'grace' ? `${what} ended on ${istDate(sub.until)} - renew now`
      : `${what} valid till ${istDate(sub.until)} (${days(sub.daysLeft)} left)`;
  return `<br><span class="${cls}">${esc(text)}</span>`;
}

function renderSettings() {
  if (!info) return;
  $('#appVersion').textContent = `v${info.version}`;
  $('#updateStatus').textContent = updateText(info.update);
  $('#btnDownload').hidden = info.update.status !== 'available';
  $('#btnInstall').hidden = info.update.status !== 'ready';
  $('#btnCheck').disabled = ['checking', 'downloading'].includes(info.update.status);

  const s = info.lastSync;
  const [cls, title] = LICENCE_TEXT[info.licence?.status]?.(info.licence) ?? ['', ''];
  $('#licStatus').className = `lic ${cls}`;
  $('#licStatus').textContent = title;
  $('#monInfo').innerHTML = !info.monitoringConfigured
    ? 'Remote monitoring is not set up in this version.'
    : (s.ok ? `Last contact: ${esc(new Date(s.at).toLocaleString('en-IN'))}` : 'Not connected yet') + subLine(info.subscription) +
      `<br><span class="dim">This PC: ${esc(String(info.installId).slice(0, 12))}</span>` +
      (s.error ? `<br><span class="err">${esc(s.error)}</span>` : '');
  $('#monBox').hidden = !info.monitoringConfigured;
}

// ---- message window from the vendor: once per message, for the owner (salesmen do not see it) ----
let shownPopup = null;
function renderPopup() {
  const p = info?.popup;
  if (!p || !isOwner() || shownPopup === p.id) return;
  shownPopup = p.id;
  $('#vendorMsgTitle').textContent = p.title || 'Message';
  $('#vendorMsgText').textContent = p.text;
  $('#vendorMsg').hidden = false;
  $('#vendorMsgOk').focus();
}
$('#vendorMsgOk').addEventListener('click', async () => {
  $('#vendorMsg').hidden = true;
  if (shownPopup) { try { await window.api.popupSeen(shownPopup); } catch { /* shown again next start */ } }
  refresh();
});

// the vendor blocked or allowed a feature or payment mode (at "Contact now" or the hourly contact):
// every screen reloads the shop's settings so switches, payment modes and GST boxes follow at once
let vendorSig = null;

export async function refresh() {
  info = await window.api.appInfo();
  if (vendorSig !== null && info.vendorSig !== vendorSig) await loadShop();
  vendorSig = info.vendorSig;
  renderBanner();
  renderSettings();
  renderPopup();
}

window.api.onUpdateStatus((u) => { if (info) { info.update = u; renderBanner(); renderSettings(); } });

$('#btnCheck').addEventListener('click', async () => { await window.api.checkUpdate(); refresh(); });
$('#btnDownload').addEventListener('click', async () => { await window.api.downloadUpdate(); refresh(); });
$('#btnInstall').addEventListener('click', async () => {
  const r = await window.api.installUpdate();
  if (r && !r.ok) $('#updateStatus').textContent = r.reason;
});
$('#btnSync').addEventListener('click', async () => { await window.api.syncNow(); refresh(); });
$('#btnKey').addEventListener('click', async () => {
  const m = $('#keyMsg');
  m.textContent = 'Checking the key with the server... (it can take up to a minute when the server is waking up)'; m.className = '';
  try {
    await window.api.setControlKey($('#controlKey').value);
    $('#controlKey').value = '';
    m.textContent = 'Activated on this computer.'; m.className = 'ok';
  } catch (e) { m.textContent = errText(e); m.className = 'err'; }
  refresh();
});

document.querySelector('[data-view="settings"]').addEventListener('click', refresh);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', renderBanner));
setInterval(refresh, 60_000);   // keeps the banner current (lock grace period, new messages)
refresh();
