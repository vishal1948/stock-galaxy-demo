// Settings > Salesmen: switch a salesman on or off, and set his login PIN (Users & PINs).
import { $, errText } from './util.js';
import { isOwner } from './session.js';

export async function load() {
  if (!isOwner()) return;
  const list = await window.api.listAllSalesmen();
  $('#salesmenRows').replaceChildren(...list.map((s) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = s.name + (s.active ? '' : ' (inactive)');
    if (!s.active) name.className = 'dim';
    const state = document.createElement('span');
    state.className = 'pin-state';
    state.textContent = s.has_pin ? '· has a PIN' : '· no PIN';
    name.append(state);
    const act = document.createElement('td');
    act.className = 'num';
    const btn = (text, fn) => {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = text;
      b.addEventListener('click', async () => { try { await fn(); load(); } catch (e) { alert(errText(e)); } });
      act.append(b, ' ');
    };
    if (s.active) {
      // the PIN is typed in a box in the row (Electron has no prompt window); empty = remove his PIN
      const pin = document.createElement('input');
      Object.assign(pin, { type: 'password', inputMode: 'numeric', maxLength: 6, placeholder: 'New PIN', autocomplete: 'off', className: 'pin-box' });
      pin.title = '4 to 6 digits. Leave empty and Save to remove his PIN (he can then no longer log in).';
      act.append(pin, ' ');
      btn(s.has_pin ? 'Save PIN' : 'Set PIN', async () => {
        if (!pin.value && !confirm(`Remove ${s.name}'s PIN? He can then no longer log in.`)) return;
        await window.api.setSalesmanPin(s.id, pin.value.trim());
      });
    }
    btn(s.active ? 'Deactivate' : 'Activate', () => window.api.setSalesmanActive(s.id, !s.active));
    tr.append(name, act);
    return tr;
  }));
}

document.querySelector('[data-view="settings"]').addEventListener('click', load);
load();
