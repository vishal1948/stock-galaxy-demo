// Scanner first on Billing and Stock In: the cursor waits in the empty code box, and a scan that
// arrives while nothing is selected (someone clicked elsewhere) still lands in that box.
// Typing a code by hand keeps working as a backup (torn label, scanner not working).
import { isOn } from './features.js';

const emptyCode = (rows) => [...document.querySelectorAll(`${rows} .code`)].find((i) => !i.value.trim())
  ?? document.querySelector(`${rows} tr:last-child .code`);
const TARGET = { billing: () => emptyCode('#lineRows'), stockin: () => emptyCode('#entryRows') };

const activeView = () => document.querySelector('.view.active')?.id;
const busy = () => !document.getElementById('setup')?.hidden || !document.getElementById('login')?.hidden;   // setup or login screen open

export function focusScan() {
  if (!isOn('barcode') || busy()) return;
  const field = TARGET[activeView()]?.();
  if (field && document.activeElement !== field) field.focus();
}

document.addEventListener('keydown', (e) => {
  if (!isOn('barcode') || busy() || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable="true"]')) return;   // already typing somewhere
  const field = TARGET[activeView()]?.();
  if (!field) return;
  e.preventDefault();
  field.focus();
  field.value += e.key;   // the first character of the scan; the rest follow into the box
  field.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

for (const view of Object.keys(TARGET))
  document.querySelector(`[data-view="${view}"]`)?.addEventListener('click', () => setTimeout(focusScan, 0));
