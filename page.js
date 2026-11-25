// Refresh / Reset page for the tab on screen (right-click menu, F5, Ctrl+R, Ctrl+Shift+R).
// Each tab registers what the two actions mean for it with onPage().
const handlers = {};   // view id -> { refresh, reset }

export function onPage(view, actions) {
  handlers[view] = { ...handlers[view], ...actions };
}

let toastTimer;
export function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

export async function pageAction(action) {
  const view = document.querySelector('.view.active')?.id;
  const fn = handlers[view]?.[action];
  if (!fn) return;
  try {
    const done = await fn();   // a reset that the user cancels returns false
    if (done !== false) toast(action === 'reset' ? 'Page reset' : 'Refreshed');
  } catch (e) { toast(`Could not ${action}: ${e.message}`); }
}

window.api.onPageAction(pageAction);
