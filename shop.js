// The shop using this copy of the app: its details, logo and payment modes, shared by every screen.
const DEFAULT_MODES = [{ id: 'cash', label: 'Cash', active: true }, { id: 'upi', label: 'UPI', active: true },
  { id: 'credit_card', label: 'Card', active: true }];
let settings = {};
let appName = '';
let loaded = false;
const listeners = [];

export const shop = () => settings;
// screens start at different moments: one that subscribes after the first load gets it straight away
export const onShop = (fn) => { listeners.push(fn); if (loaded) Promise.resolve(fn(settings)).catch(() => {}); };

export function modes(all = false) {
  let list = DEFAULT_MODES;
  try { const l = JSON.parse(settings.payment_modes ?? 'null'); if (Array.isArray(l) && l.length) list = l; } catch { /* default */ }
  return all ? list : list.filter((m) => m.active !== false);
}
export const modeLabel = (id) => modes(true).find((m) => m.id === id)?.label
  ?? String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** <img> src for the logo, or '' when the shop has none. */
export const logoSrc = (s = settings) => {
  const v = String(s.shop_logo ?? '');
  if (v.startsWith('data:image/')) return v;
  if (v.startsWith('legacy:')) return v.slice(7);   // until it is converted below
  return '';
};

const loadImage = (src) => new Promise((ok, fail) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => fail(new Error('That picture could not be opened'));
  img.src = src;
});

// Pictures are made small enough to keep in the database (and in every backup): longest side 600 px.
async function toDataUrl(src) {
  const img = await loadImage(src);
  const scale = Math.min(1, 600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const png = c.toDataURL('image/png');
  if (png.length < 300_000) return png;   // keeps a transparent background
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** A logo file chosen by the user -> data URL ready to save. */
export async function logoFromFile(file) {
  if (!/^image\/(png|jpeg)$/.test(file?.type)) throw new Error('Choose a PNG or JPG picture');
  if (file.size > 15 * 1024 * 1024) throw new Error('That picture is too large (15 MB max)');
  // read as data: (the page's security policy allows data: pictures but not blob: ones)
  const url = await new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(new Error('That picture could not be read'));
    r.readAsDataURL(file);
  });
  return toDataUrl(url);
}

// Shops set up before the app became a standard product had their logo built into the app.
// The first start turns it into the shop's own saved logo.
async function convertLegacyLogo() {
  const v = String(settings.shop_logo ?? '');
  if (!v.startsWith('legacy:')) return;
  let logo = '';
  try { logo = await toDataUrl(v.slice(7)); } catch { /* the picture is gone: no logo */ }
  await window.api.saveSettings({ shop_logo: logo });
  settings.shop_logo = logo;
}

function paintSidebar() {
  const src = logoSrc();
  const img = document.getElementById('sideLogo');
  img.hidden = !src;
  if (src) { img.src = src; img.alt = settings.shop_name ?? ''; }
  const name = document.getElementById('sideName');
  name.hidden = !!src;
  name.innerHTML = '';
  const b = document.createElement('b'); b.textContent = settings.shop_name || appName;
  const t = document.createElement('span'); t.textContent = settings.shop_name ? settings.shop_tagline ?? '' : '';
  name.append(b, t);
  document.title = settings.shop_name ? `${settings.shop_name} - ${appName}` : appName;
  for (const e of document.querySelectorAll('.app-name')) e.textContent = appName;
}

export async function loadShop() {
  if (!appName) appName = (await window.api.appInfo()).name;
  settings = await window.api.getSettings();
  await convertLegacyLogo();
  paintSidebar();
  loaded = true;
  for (const fn of listeners) { try { await fn(settings); } catch { /* one screen must not stop the others */ } }
  return settings;
}
