import { $, esc, errText } from './util.js';
import { applyFeatures } from './features.js';
import { showBackup } from './backup.js';
import { load as loadSalesmenList } from './salesmen.js';
import { testPrint } from './bills.js';
import { onPage } from './page.js';
import { loadShop, logoFromFile, logoSrc, modes, onShop } from './shop.js';
import { isOwner, signedIn, showRecoveryKey } from './session.js';
await signedIn;   // Settings is the owner's (a salesman never sees it)

const FIELDS = [
  ['shop_name', 'Shop name'], ['shop_tagline', 'Tagline'], ['shop_address', 'Address'],
  ['shop_phones', 'Phone numbers'], ['gstin', 'GSTIN'], ['bill_footer', 'Bill footer text'],
  ['last_bill_no', 'Last bill number used (next bill = this + 1)'],
];
const SWITCHES = [['#optWa', 'whatsapp_billing', 'WhatsApp billing'], ['#optBarcode', 'barcode_billing', 'Barcode billing']];
// what each switch does right now, so the text always matches the switch
const SWITCH_TEXT = {
  '#optWa': ['On: after saving, the bill PDF can be sent to the customer on WhatsApp - in WhatsApp Desktop if it is installed '
    + '(fastest), otherwise in one WhatsApp window of this app (scan its QR code once).',
    'Off: bills are not sent on WhatsApp; the WhatsApp tick box and buttons are hidden.'],
  '#optBarcode': ['On: the cursor waits in the Barcode box on Billing and Stock In; a scan fills the item, and scanning it again adds 1 to its Qty.',
    'Off: barcodes are typed by hand and each line is filled when you leave the box; nothing waits for a scanner.'],
};
// a switch the vendor blocked (control server) stays off and cannot be changed here
const VENDOR_OFF = 'Off: switched off by your vendor. Contact your vendor to use it.';
const blockedIn = (s) => { try { return new Set(JSON.parse(s.blocked_features || '[]')); } catch { return new Set(); } };
const showSwitchText = () => { for (const [sel] of SWITCHES) $(`${sel}Text`).textContent = $(sel).disabled ? VENDOR_OFF : SWITCH_TEXT[sel][$(sel).checked ? 0 : 1]; };

const msg = (sel, t, ok) => { const m = $(sel); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

async function load() {
  const s = await window.api.getSettings();
  $('#settingsForm').replaceChildren(...FIELDS.map(([k, label]) => {
    const l = document.createElement('label');
    l.textContent = label;
    const i = document.createElement('input');
    i.name = k; i.value = s[k] ?? '';
    l.append(i);
    return l;
  }));
  const blocked = blockedIn(s);
  for (const [sel, key] of SWITCHES) { $(sel).checked = s[key] !== '0'; $(sel).disabled = blocked.has(key); }
  showSwitchText();
  applyFeatures(s);
  showLogo(s);
  $('#billTheme').value = s.bill_theme || 'indigo';
  // everything the vendor can block is drawn before the slow parts below, so a vendor change arriving
  // meanwhile (onShop at the end of this file) is never painted over with these older settings
  showGst(s);
  showModes();
  $('#returnDays').value = s.return_days ?? '7';
  await showPrinting(s);
  await showUsers(s);
  loadFolders();
}

// ---- Bill & printing: format, paper, colour, printing on/off and the printer; saved as soon as changed ----
const FORMAT_TEXT = {
  a4: 'Two copies on one A4 sheet (customer copy + shop copy), in the bill colour. For any laser or inkjet printer.',
  thermal: 'One black receipt on a paper roll, as long as the bill. For thermal receipt printers (e.g. TVS RP 3160, Epson TM-T82, '
    + 'Retsol). Choose the width of the roll in the printer. The WhatsApp copy stays a half-A4 PDF.',
};
async function showPrinting(s) {
  const thermal = String(s.bill_format || 'a4').startsWith('thermal_');
  for (const r of document.querySelectorAll('[name=billKind]')) r.checked = r.value === (thermal ? 'thermal' : 'a4');
  if (thermal) $('#rollWidth').value = s.bill_format;
  $('#billFormatText').textContent = FORMAT_TEXT[thermal ? 'thermal' : 'a4'];
  $('#rollRow').hidden = !thermal;
  $('#billColourRow').hidden = thermal;   // thermal receipts are black only
  const on = s.print_bills !== '0';
  $('#optPrint').checked = on;
  $('#optPrintText').textContent = on ? 'On: each bill prints by itself on the printer below, without a print window.'
    : 'Off: bills are only saved as PDF; nothing is printed (reprints too).';
  $('#printerBlock').hidden = !on;
  await showPrinters(s.printer_name || '');
}
async function showPrinters(chosen) {
  const list = await window.api.listPrinters();
  const def = list.find((p) => p.isDefault);
  const opts = [`<option value="">Windows default printer${def ? ` (${esc(def.displayName)})` : ' - none set'}</option>`,
    ...list.map((p) => `<option value="${esc(p.name)}">${esc(p.displayName)}${p.virtual ? ' - saves files only, not used' : ''}</option>`)];
  if (chosen && !list.some((p) => p.name === chosen)) opts.push(`<option value="${esc(chosen)}">${esc(chosen)} - not connected</option>`);
  $('#printerName').innerHTML = opts.join('');
  $('#printerName').value = chosen;
}
const savePrint = async (obj, done) => {
  try { await window.api.saveSettings(obj); const s = await loadShop(); await showPrinting(s); msg('#printMsg', done, true); }
  catch (e) { msg('#printMsg', errText(e), false); await showPrinting(await window.api.getSettings()); }
};
for (const r of document.querySelectorAll('[name=billKind]'))
  r.addEventListener('change', () => savePrint({ bill_format: r.value === 'a4' ? 'a4' : $('#rollWidth').value || 'thermal_80' },
    r.value === 'a4' ? 'Bills: A4 regular' : 'Bills: thermal receipt'));
$('#rollWidth').addEventListener('change', (e) => savePrint({ bill_format: e.target.value }, 'Paper roll width saved'));

// ---- GST billing: one switch for everything about GST (tax on bills, HSN and GST columns, GST report) ----
function showGst(s) {
  const on = s.gst_billing === '1';
  $('#optGst').checked = on;
  $('#optGst').disabled = blockedIn(s).has('gst_billing');
  $('#optGstText').textContent = on
    ? 'On: bills are tax invoices with HSN, GST rate and CGST + SGST (or IGST). Rates include GST. Stock In and Products show HSN and GST; Reports has the GST report.'
    : 'Off: bills carry no GST details and every GST column, box and report is hidden. Bills already made stay as they were.';
  $('#gstHsn').value = s.gst_default_hsn || '';
}
$('#optGst').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await window.api.saveSettings({ gst_billing: on ? '1' : '0' });
    const s = await loadShop();
    applyFeatures(s); showGst(s);
    msg('#gstMsg2', `GST billing is ${on ? 'ON' : 'OFF'}`, true);
  } catch (err) { e.target.checked = !on; msg('#gstMsg2', errText(err), false); }
});
// ---- returns & exchanges: how many days after a bill items may come back (0 = no limit) ----
$('#returnDaysSave').addEventListener('click', async () => {
  try {
    await window.api.saveSettings({ return_days: $('#returnDays').value.trim() });
    const d = (await loadShop()).return_days;
    msg('#returnsMsg', d === '0' ? 'Returns: no time limit' : `Returns allowed for ${d} days`, true);
  } catch (e) { msg('#returnsMsg', errText(e), false); }
});
$('#gstHsnSave').addEventListener('click', async () => {
  try { await window.api.saveSettings({ gst_default_hsn: $('#gstHsn').value.trim() }); await loadShop(); msg('#gstMsg2', 'Default HSN saved', true); }
  catch (e) { msg('#gstMsg2', errText(e), false); }
});

// ---- Users & PINs: the owner PIN, and whether the app asks for a PIN when it opens ----
async function showUsers(s) {
  const st = await window.api.userStatus();
  $('#ownerPinText').textContent = st.ownerPinSet ? 'Set. Enter the current PIN to change it.'
    : 'Not set yet. Set one to let the app ask who is using it.';
  $('#ownerOld').hidden = !st.ownerPinSet;
  $('#optLogin').checked = s.login_on === '1' && st.ownerPinSet;
  $('#optLogin').disabled = !st.ownerPinSet;
  $('#optLoginText').textContent = $('#optLogin').checked
    ? 'On: the app opens on a login screen. The owner can do everything; a salesman (with a PIN, under Salesmen) can only make and find bills.'
    : 'Off: the app opens straight away and whoever uses it can do everything.';
}
$('#ownerSave').addEventListener('click', async () => {
  try {
    const r = await window.api.setOwnerPin($('#ownerOld').value, $('#ownerNew').value);
    $('#ownerOld').value = ''; $('#ownerNew').value = '';
    showRecoveryKey(r.recoveryKey);
    await showUsers(await window.api.getSettings());
    msg('#usersMsg', 'Owner PIN saved', true);
  } catch (e) { msg('#usersMsg', errText(e), false); }
});
$('#optLogin').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await window.api.setLoginOn(on);
    await showUsers(await window.api.getSettings());
    msg('#usersMsg', on ? 'The app now asks for a PIN when it opens' : 'The app no longer asks for a PIN', true);
    if (on) location.reload();   // shows who is logged in, with Switch user
  } catch (err) { e.target.checked = !on; msg('#usersMsg', errText(err), false); }
});
$('#optPrint').addEventListener('change', (e) => savePrint({ print_bills: e.target.checked ? '1' : '0' },
  `Bill printing is ${e.target.checked ? 'ON' : 'OFF'}`));
$('#printerName').addEventListener('change', (e) => savePrint({ printer_name: e.target.value }, 'Printer saved'));
$('#refreshPrinters').addEventListener('click', async () => { await showPrinters($('#printerName').value); msg('#printMsg', 'Printer list updated', true); });
$('#testPrint').addEventListener('click', async () => {
  const r = await testPrint(await window.api.getSettings());
  msg('#printMsg', r.printed ? 'Test bill sent to the printer' : (r.problem || 'Not printed (printing is off or only a PDF printer is set)'), r.printed);
});

// ---- shop logo: saved straight away, printed on every bill ----
function showLogo(s) {
  const src = logoSrc(s);
  $('#logoPreview').hidden = !src;
  if (src) $('#logoPreview').src = src;
  $('#logoNone').hidden = !!src;
  $('#logoRemove').hidden = !src;
}
async function saveLogo(value, done) {
  try {
    await window.api.saveSettings({ shop_logo: value });
    showLogo(await loadShop());
    msg('#setMsg', done, true);
  } catch (e) { msg('#setMsg', errText(e), false); }
}
$('#billTheme').addEventListener('change', (e) => savePrint({ bill_theme: e.target.value }, 'Bill colour saved'));
$('#logoChange').addEventListener('click', () => $('#logoFile').click());
$('#logoFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await saveLogo(await logoFromFile(f), 'Logo saved'); } catch (err) { msg('#setMsg', errText(err), false); }
});
$('#logoRemove').addEventListener('click', () => saveLogo('', 'Logo removed'));

// ---- payment modes: the built-in list of what Indian shops take, grouped, each with a switch; plus the
// shop's own. A mode on old bills is switched off, never deleted. ----
const MODE_GROUPS = [['cash_upi', 'Cash & UPI'], ['cards', 'Cards'], ['bank', 'Bank'], ['wallets', 'Wallets'],
  ['finance', 'EMI & finance'], ['other', 'Other'], ['own', 'Added by you']];
function showModes() {
  const all = modes(true);
  const on = all.filter((m) => m.active !== false).length;
  $('#modeCount').textContent = `${on} switched on`;
  $('#modeRows').replaceChildren(...MODE_GROUPS.map(([g, title]) => {
    const list = all.filter((m) => (m.group ?? 'own') === g);
    if (!list.length) return '';
    const box = document.createElement('div');
    box.className = 'mode-group';
    box.innerHTML = `<h4>${title}</h4>`;
    for (const m of list) {
      const row = document.createElement('label');
      row.className = 'switch-row';
      row.dataset.mode = m.id;
      // blocked by the vendor (control server): off and cannot be switched on here
      row.innerHTML = `<span>${esc(m.label)}${m.blocked ? ' <small>switched off by your vendor</small>' : ''}</span>
        <input type="checkbox" class="switch" ${m.active !== false ? 'checked' : ''} ${m.blocked ? 'disabled' : ''} />`;
      row.querySelector('input').addEventListener('change', (e) =>
        saveModes(modes(true).map((x) => (x.id === m.id ? { ...x, active: e.target.checked } : x)),
          `${m.label} is ${e.target.checked ? 'ON' : 'OFF'}`, () => { e.target.checked = !e.target.checked; }));
      box.append(row);
    }
    return box;
  }).filter(Boolean));
}
async function saveModes(list, done, undo) {
  try {
    await window.api.saveSettings({ payment_modes: JSON.stringify(list) });
    await loadShop();
    showModes();
    msg('#modeMsg', done, true);
    return true;
  } catch (e) { undo?.(); msg('#modeMsg', errText(e), false); return false; }
}
$('#modeAdd').addEventListener('click', async () => {
  const label = $('#modeNew').value.trim();
  if (!label) return msg('#modeMsg', 'Type the name of the payment mode', false);
  const list = modes(true);
  const old = list.find((m) => m.label.toLowerCase() === label.toLowerCase());
  if (old) return saveModes(list.map((m) => (m === old ? { ...m, active: true } : m)), `${old.label} is ON`);
  // "own_" keeps a shop's own modes apart from built-in ones, also ones added in later versions
  let id = `own_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'mode'}`;
  while (list.some((m) => m.id === id)) id = `${id.slice(0, 26)}_${Math.floor(Math.random() * 90 + 10)}`;
  if (await saveModes([...list, { id, label, active: true }], `${label} added`)) $('#modeNew').value = '';
});
$('#modeNew').addEventListener('keydown', (e) => e.key === 'Enter' && $('#modeAdd').click());

// ---- on/off switches: saved as soon as they are clicked ----
for (const [sel, key, label] of SWITCHES) {
  $(sel).addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await window.api.saveSettings({ [key]: on ? '1' : '0' });
      applyFeatures(await window.api.getSettings());
      msg('#optMsg', `${label} is ${on ? 'ON' : 'OFF'}`, true);
      showSwitchText();
    } catch (err) { e.target.checked = !on; showSwitchText(); msg('#optMsg', errText(err), false); }
  });
}

// ---- the one data folder: everything is saved in it, each kind in its own subfolder ----
const EXCEL = ['customers', 'stock_files', 'sales_files'];

async function showDataFiles() {
  const st = await window.api.dataFilesStatus();
  const line = $('#dataFilesStatus');
  line.className = `file-status ${st.error ? 'err' : ''}`;
  line.textContent = st.error ? `Not updated: ${st.error}. It updates again after the next bill or stock change.`
    : `Customers, Stock and Sales Excel files update by themselves after every bill and stock change${st.at ? ` · last saved ${st.at}` : ''}`;
}

async function loadFolders() {
  const f = await window.api.listFolders();
  $('#dataRoot').textContent = f.dir;
  $('#folderRows').replaceChildren(...f.subs.map((sub) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.dataset.folder = sub.name;
    row.innerHTML = `<div class="folder-info"><b>${esc(sub.label)}</b><span class="path">${esc(sub.dir)}</span></div>
      <div class="folder-btns"><button class="ghost small open">Open</button></div>`;
    row.querySelector('.open').addEventListener('click', () => window.api.openFolder(sub.name));
    if (EXCEL.includes(sub.name)) row.classList.add('excel');
    return row;
  }));
  await showDataFiles();
}

$('#openDataRoot').addEventListener('click', () => window.api.openFolder(null));
$('#updateFiles').addEventListener('click', async () => {
  try { await window.api.saveDataFiles(); await showDataFiles(); msg('#folderMsg', 'Excel files saved', true); }
  catch (e) { msg('#folderMsg', errText(e), false); }
});
$('#moveData').addEventListener('click', async () => {
  if (!confirm('Copy all data to another folder and restart the app there?\n\nThe old folder is kept as it is; delete it yourself once you are happy.')) return;
  try {
    const to = await window.api.moveDataFolder();
    if (to) msg('#folderMsg', `Copied to ${to}. Restarting...`, true);
  } catch (e) { msg('#folderMsg', errText(e), false); }
});

document.querySelector('[data-view="settings"]').addEventListener('click', load);
$('#saveSettings').addEventListener('click', async () => {
  const data = Object.fromEntries(FIELDS.map(([k]) => [k, $(`[name="${k}"]`).value.trim()]));
  try { await window.api.saveSettings(data); await loadShop(); msg('#setMsg', 'Saved', true); }
  catch (e) { msg('#setMsg', errText(e), false); }
});
if (isOwner()) load();

// the shop's settings were loaded again (e.g. the vendor blocked or allowed something): the switches,
// GST and payment modes follow at once, without touching shop details being typed
onShop((s) => {
  if (!isOwner()) return;
  const blocked = blockedIn(s);
  for (const [sel, key] of SWITCHES) { $(sel).checked = s[key] !== '0'; $(sel).disabled = blocked.has(key); }
  showSwitchText();
  showGst(s);
  showModes();
});

// Refresh keeps unsaved shop details; Reset page shows the saved ones again
const refreshOthers = async () => {
  await loadFolders();
  showBackup(await window.api.backupStatus());
  await loadSalesmenList();
};
onPage('settings', {
  refresh: refreshOthers,
  reset: async () => {
    for (const id of ['#setMsg', '#optMsg', '#folderMsg']) $(id).textContent = '';
    await load();
    await refreshOthers();
  },
});
