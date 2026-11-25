// On/off switches from Settings. The page body gets "no-wa" / "no-barcode" / "no-gst" classes, and CSS hides
// everything marked .wa-only / .bc-only / .gst-only; code asks isOn() before doing WhatsApp or barcode work.
// A switch the vendor blocked (control server) already reads as off in the settings.
import { onShop } from './shop.js';

const CLASSES = { whatsapp: 'no-wa', barcode: 'no-barcode', gst: 'no-gst' };

export function applyFeatures(s) {
  document.body.classList.toggle(CLASSES.whatsapp, s.whatsapp_billing === '0');
  document.body.classList.toggle(CLASSES.barcode, s.barcode_billing === '0');
  document.body.classList.toggle(CLASSES.gst, s.gst_billing !== '1');   // GST starts off
}

export const isOn = (feature) => !document.body.classList.contains(CLASSES[feature]);

export const loadFeatures = async () => applyFeatures(await window.api.getSettings());

onShop(applyFeatures);   // every time the shop's settings are loaded again (Settings change, vendor change)
