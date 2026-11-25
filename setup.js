// First start of a new install: ask for the shop's own details before anything else.
// Also loads the shop profile (name, logo, payment modes) for every other screen.
import { $, errText } from './util.js';
import { loadShop, logoFromFile } from './shop.js';
import { restoreFlow } from './backup.js';

let logo = '';
const msg = (t, ok) => { const m = $('#suMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };

$('#suLogoBtn').addEventListener('click', () => $('#suLogoFile').click());
$('#suLogoFile').addEventListener('change', async (e) => {
  try {
    logo = await logoFromFile(e.target.files[0]);
    $('#suLogoPreview').src = logo;
    $('#suLogoPreview').hidden = false;
    $('#suLogoBtn').textContent = 'Change logo';
    msg('', true);
  } catch (err) { msg(errText(err), false); }
  e.target.value = '';
});

// a new PC for an existing shop: bring back its data from a backup (e.g. the Google Drive copy)
$('#suRestore').addEventListener('click', () => restoreFlow(msg));

$('#suSave').addEventListener('click', async () => {
  const btn = $('#suSave');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await window.api.completeSetup({
      shop_name: $('#suName').value, shop_tagline: $('#suTag').value, shop_address: $('#suAddr').value,
      shop_phones: $('#suPhones').value, gstin: $('#suGstin').value.trim().toUpperCase(),
      salesman: $('#suSalesman').value, first_bill_no: $('#suFirstBill').value, shop_logo: logo,
    });
    await loadShop();
    $('#setup').hidden = true;
  } catch (e) { msg(errText(e), false); }
  finally { btn.disabled = false; }
});

const s = await loadShop();
if (!String(s.shop_name ?? '').trim()) {
  $('#setup').hidden = false;
  $('#suName').focus();
}
