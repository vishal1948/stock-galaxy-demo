export const $ = (s, r = document) => r.querySelector(s);
export const toPaise = (v) => Math.round((Number(v) || 0) * 100);
export const rupees = (p) =>
  (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const errText = (e) => e.message.replace(/^Error invoking remote method '.*?': Error: /, '');
// "2026-11-20 15:42:10" (database time) -> "20/11/2026, 3:42 pm"
export const when = (s) => {
  const d = new Date(String(s ?? '').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(s ?? '')
    : d.toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
