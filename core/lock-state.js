// Holds the current remote config and licence facts and answers "may I write?" without importing
// Electron, so business logic (sales.js, products.js) and tests can use it.
import { evaluate, licence } from './control-core.js';

let cfg = null;
let version = '0.0.0';
let lic = { enabled: false };          // { enabled, machineId, firstRunAt, keyInUse } - set by monitor.js
let clock = () => Date.now();         // monitor.js swaps in a clock that cannot be turned back

export const setConfig = (c, appVersion) => { cfg = c; version = appVersion; };
export const getConfig = () => cfg;
export const setLicence = (l) => { lic = { ...lic, ...l }; };
export const setClock = (fn) => { clock = fn; };

export function current() {
  const now = clock();
  const e = evaluate(cfg, version, now);
  const l = licence({ ...lic, cfg, now });
  e.licence = l;
  e.notice = [l.notice, e.subscription.notice].filter(Boolean).join('  |  ') || null;   // trial / offline, subscription ending
  if (!e.locked && l.locked) { e.locked = true; e.message = l.message; }
  return e;
}

/** Throws if billing is locked (vendor lock, trial over, offline too long, key on another PC).
 *  Reports, search, reprint and backups still work. */
export function assertWritable() {
  const e = current();
  if (e.locked) throw new Error(e.message || 'Billing is locked. Please contact your vendor.');
}

/** false = blocked by the vendor (whatsapp_billing, barcode_billing, gst_billing, csv_export). */
export const isFeatureOn = (name) => current().features[name] !== false;
/** Payment mode ids the vendor blocked for this shop. */
export const blockedModes = () => new Set(current().blockedModes);
