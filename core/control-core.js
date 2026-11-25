// Pure logic for remote config: no Electron imports, so it is unit-testable.
import crypto from './crypto-stub.js';

/** Compare "1.2.3" style versions. Returns -1, 0 or 1. */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verify a signed config from the control server.
 * envelope = { payload: "<json string>", sig: "<base64 ed25519 signature of payload>" }
 * Returns the parsed config, or null if it is missing, forged, for another install, or malformed.
 */
export function verifyEnvelope(envelope, publicKeyPem, shopId) {
  try {
    if (!publicKeyPem || !envelope?.payload || !envelope?.sig) return null;
    const ok = crypto.verify(
      null,
      Buffer.from(envelope.payload),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(envelope.sig, 'base64')
    );
    if (!ok) return null;
    const cfg = JSON.parse(envelope.payload);
    if (shopId && cfg.shop_id !== shopId) return null;   // config signed for a different shop
    if (!Number.isFinite(Date.parse(cfg.expires_at))) return null;
    return cfg;
  } catch {
    return null;
  }
}

// ---------------- subscription: the days the vendor gave this shop ----------------
export const SUB_WARN_DAYS = 7;    // warns this many days before the end
export const SUB_GRACE_DAYS = 3;   // keeps billing this many days after it, then read-only
const ist = (ms) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });

/** sub = { until: ISO end of the last day, trial } from the server, or null (no limit).
 *  Returns { state: none|ok|warn|grace|over, until, daysLeft, notice, message }. */
export function subscription(sub, now = Date.now()) {
  const end = Date.parse(sub?.until);
  if (!sub || !Number.isFinite(end)) return { state: 'none', until: null, daysLeft: null, notice: null, message: null };
  const what = sub.trial ? 'trial' : 'subscription';
  const What = sub.trial ? 'Trial' : 'Subscription';
  const base = { until: sub.until, trial: !!sub.trial };
  if (now <= end) {
    const daysLeft = Math.max(1, Math.ceil((end - now) / DAY));
    return { ...base, state: daysLeft <= SUB_WARN_DAYS ? 'warn' : 'ok', daysLeft, message: null,
      notice: daysLeft <= SUB_WARN_DAYS ? `${What} ends on ${ist(end)} (${plural(daysLeft)} left). Please renew with your vendor.` : null };
  }
  const stops = end + SUB_GRACE_DAYS * DAY;
  if (now < stops)
    return { ...base, state: 'grace', daysLeft: 0, message: null,
      notice: `Your ${what} ended on ${ist(end)}. New bills stop after ${ist(stops)} - please renew with your vendor.` };
  return { ...base, state: 'over', daysLeft: 0, notice: null,
    message: `Your ${what} ended on ${ist(end)}, so the app is paused. Please renew with your vendor.` };
}

/**
 * What the app should do right now, given a verified config (or null).
 * The banner message only counts while the config is fresh (72 h).
 * Everything that limits the shop stays on when the config is old - going offline must not undo it:
 * the lock, blocked features and payment modes, the subscription end and the minimum version.
 * locked = the whole app shows only the lock screen (main/main.js, main/ipc.js).
 * (How long an activated shop may stay offline at all is decided by licence() below.)
 */
export function evaluate(cfg, appVersion, now = Date.now()) {
  const out = { locked: false, lockWarning: null, message: null, updateRequired: false, features: {}, blockedModes: [],
    popup: null, subscription: subscription(null) };
  if (!cfg) return out;

  out.features = cfg.features && typeof cfg.features === 'object' ? cfg.features : {};
  out.blockedModes = Array.isArray(cfg.blocked_modes) ? cfg.blocked_modes.filter((m) => typeof m === 'string') : [];
  out.popup = cfg.popup?.id && cfg.popup?.text ? { id: String(cfg.popup.id), title: String(cfg.popup.title ?? ''), text: String(cfg.popup.text) } : null;
  out.subscription = subscription(cfg.subscription, now);
  if (now < Date.parse(cfg.expires_at)) out.message = cfg.message || null;
  // older than the vendor's minimum: stops until updated, also offline (the update needs the internet anyway)
  out.updateRequired = !!cfg.min_version && cmpVersion(appVersion, cfg.min_version) < 0;

  if (cfg.lock?.state === 'readonly') {
    const after = cfg.lock.after ? Date.parse(cfg.lock.after) : 0;
    if (now >= after) {
      out.locked = true;
    } else {
      out.lockWarning = {
        date: cfg.lock.after,
        message: cfg.lock.message || 'Billing will be locked soon. Please contact your vendor.',
      };
    }
    if (out.locked) out.message = cfg.lock.message || 'Billing is locked. Please contact your vendor.';
  }
  if (!out.locked && out.subscription.state === 'over') { out.locked = true; out.message = out.subscription.message; }
  if (!out.locked && out.updateRequired) {
    out.locked = true;
    out.message = `This version is too old - version ${cfg.min_version} or newer is needed. `
      + 'Connect to the internet and install the update.';
  }
  return out;
}

// ---------------- licence: trial, activation, one PC per key, offline limit ----------------
export const TRIAL_DAYS = 15;     // a new install bills freely this long without a shop key
export const OFFLINE_DAYS = 7;    // an activated install may go this long without reaching the server
export const WARN_DAYS = 3;     // starts warning this many days before either limit
const DAY = 86400_000;
const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * enabled    - this build has a control server (no server = no licensing at all, like before)
 * cfg        - verified config from the server (may be old) or null
 * machineId  - this PC; activated only when the server's reply was made for this PC
 * firstRunAt - when this install first started (ISO)
 * keyInUse   - the server said the key belongs to another PC
 * Returns { status, locked, message (when locked), notice (banner while still working), daysLeft }.
 */
export function licence({ enabled, cfg, machineId, firstRunAt, keyInUse = false, now = Date.now() }) {
  if (!enabled) return { status: 'off', locked: false, message: null, notice: null, daysLeft: null };

  if (cfg && machineId && cfg.install_id === machineId) {
    const since = Date.parse(cfg.issued_at);
    const daysLeft = OFFLINE_DAYS - Math.floor((now - since) / DAY);
    if (!Number.isFinite(since) || daysLeft <= 0)
      return { status: 'offline_over', locked: true, daysLeft: 0, notice: null,
        message: `This app has not connected to the internet for ${OFFLINE_DAYS} days, so the app is paused. `
          + 'Connect to the internet and press "Contact now".' };
    if (daysLeft <= WARN_DAYS)
      return { status: 'offline_warn', locked: false, daysLeft, message: null,
        notice: `Connect to the internet within ${plural(daysLeft)}, or the app will be paused.` };
    return { status: 'active', locked: false, daysLeft, message: null, notice: null };
  }

  const start = Date.parse(firstRunAt);
  const used = Number.isFinite(start) ? Math.max(0, now - start) : 0;
  const daysLeft = Math.max(0, Math.ceil((TRIAL_DAYS * DAY - used) / DAY));
  const otherPc = keyInUse ? 'This shop key is already used on another computer. Ask your vendor to move it to this PC.' : null;
  if (used < TRIAL_DAYS * DAY)
    return { status: keyInUse ? 'other_pc' : 'trial', locked: false, daysLeft, message: null,
      notice: otherPc ?? `Trial version: ${plural(daysLeft)} left. Enter your shop key in Settings > Activation.` };
  return { status: keyInUse ? 'other_pc' : 'trial_over', locked: true, daysLeft: 0, notice: null,
    message: otherPc ?? `The ${TRIAL_DAYS}-day trial has ended. Enter your shop key below to continue.` };
}
