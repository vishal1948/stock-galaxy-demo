// Who is using the app (owner or a salesman, main/users.js). With "Ask for a PIN" off this is always the
// owner and nothing shows. With it on, the app opens on the login screen; logging in or out reloads the page,
// so every screen starts again knowing who is there.
//   salesman: only Billing and Find Bill (the body gets "role-salesman"; CSS hides .owner-only)
import { $, esc, errText } from './util.js';
import { logoSrc } from './shop.js';

const st = await window.api.userStatus();
export const me = st.user;                       // null while the login screen is open
export const isOwner = () => me?.role === 'owner';
export const loginOn = st.loginOn;

/** Resolves when someone is logged in. On the login screen it never does: logging in reloads the page. */
export const signedIn = me ? Promise.resolve(me) : new Promise(() => {});

if (me?.role === 'salesman') document.body.classList.add('role-salesman');

// ---- sidebar: who is logged in, and Switch user ----
if (loginOn && me) {
  $('#whoBox').hidden = false;
  $('#whoName').textContent = me.name;
  $('#whoRole').textContent = me.role === 'owner' ? 'Owner' : 'Salesman';
  $('#logout').addEventListener('click', async () => {
    if (window.__billingBusy?.() && !confirm('The bill on screen is not saved. Switch user anyway?')) return;
    await window.api.logout();
    location.reload();
  });
}

// ---- login screen: left the shop and a clock, right "who are you?" tiles, then a PIN pad ----
const MAX_PIN = 6;
const msg = (t, ok) => { const m = $('#loginMsg'); m.textContent = t; m.className = `lp-msg ${ok ? 'ok' : 'err'}`; };
const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
let who = null;

/** Shows the recovery key once, after the owner PIN is set or changed. */
export function showRecoveryKey(key) {
  alert(`Write down this recovery key and keep it safe:\n\n${key}\n\n`
    + 'If the owner PIN is ever forgotten, it is the only way to set a new one (on the login screen, "Forgot the owner PIN?").');
}

function showDots() {
  const n = $('#loginPin').value.length;
  [...$('#pinDots').children].forEach((d, i) => d.classList.toggle('on', i < n));
  $('#loginGo').disabled = n < 4;
}
function setPin(v) { $('#loginPin').value = v.replace(/\D/g, '').slice(0, MAX_PIN); showDots(); }

function pick(choice) {
  who = choice.who;
  const owner = choice.who === 'owner';
  $('#loginAvatar').textContent = initials(choice.name);
  $('#loginAvatar').classList.toggle('owner', owner);
  $('#loginName').textContent = choice.name;
  $('#loginRole').textContent = owner ? 'Owner' : 'Salesman';
  $('#loginForgot').hidden = !owner;
  $('#loginForgot').open = false;
  $('#loginWho').hidden = true;
  $('#loginPinStep').hidden = false;
  setPin('');
  msg('', true);
  $('#loginPin').focus();
}

function back() {
  who = null;
  $('#loginPinStep').hidden = true;
  $('#loginWho').hidden = false;
}

async function go() {
  if (who == null || $('#loginPin').value.length < 4) return;
  $('#loginGo').disabled = true;
  try {
    await window.api.login(who, $('#loginPin').value);
    location.reload();
  } catch (e) {
    msg(errText(e), false);
    setPin('');
    const dots = $('#pinDots');
    dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');   // wrong PIN: the dots shake
    $('#loginPin').focus();
  }
}

function tick() {
  const now = new Date();
  $('#loginTime').textContent = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  $('#loginDate').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

if (!me) {
  $('#login').hidden = false;
  document.body.classList.add('login-open');
  const [s, info] = await Promise.all([window.api.getSettings(), window.api.appInfo().catch(() => ({}))]);
  $('#loginShop').textContent = s.shop_name || '';
  $('#loginTag').textContent = s.shop_tagline || '';
  const src = logoSrc(s);
  $('#loginLogo').hidden = !src;
  if (src) $('#loginLogo').src = src;
  for (const e of document.querySelectorAll('#login .app-name')) e.textContent = info.name ?? '';
  $('#loginVer').textContent = info.version ? `v${info.version}` : '';
  tick(); setInterval(tick, 15_000);

  $('#loginUsers').innerHTML = st.choices.map((c) => `<button type="button" class="user-tile" data-who="${esc(c.who)}">
    <span class="avatar${c.who === 'owner' ? ' owner' : ''}">${esc(initials(c.name))}</span>
    <b>${esc(c.name)}</b><small>${c.who === 'owner' ? 'Owner' : 'Salesman'}</small></button>`).join('');
  for (const [i, b] of [...document.querySelectorAll('#loginUsers .user-tile')].entries()) b.addEventListener('click', () => pick(st.choices[i]));
  if (st.choices.length === 1) pick(st.choices[0]);   // only the owner has a PIN yet

  $('#loginBack').addEventListener('click', back);
  $('#loginGo').addEventListener('click', go);
  for (const k of document.querySelectorAll('#pinPad [data-k]')) {
    k.addEventListener('click', () => {
      const v = $('#loginPin').value;
      setPin(k.dataset.k === 'back' ? v.slice(0, -1) : v + k.dataset.k);
      $('#loginPin').focus();
    });
  }
  $('#loginPin').addEventListener('input', (e) => setPin(e.target.value));
  $('#loginPin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
    if (e.key === 'Escape') back();
  });
  // a click anywhere on the PIN step keeps typing going to the PIN
  $('#loginPinStep').addEventListener('click', (e) => { if (!e.target.closest('details, input')) $('#loginPin').focus(); });
  $('#recGo').addEventListener('click', async () => {
    try {
      const r = await window.api.recoverOwner($('#recKey').value, $('#recPin').value);
      showRecoveryKey(r.recoveryKey);
      location.reload();
    } catch (e) { msg(errText(e), false); }
  });
}
