// Categories on the screens (rules in main/categories.js):
//   Settings > Categories - the tree: add main / sub categories, rename, move, defaults (HSN, GST), switch off, delete
//   Stock In              - a Category box per row (type to search the paths, e.g. "cargo 500")
//   Products              - filter by a category (with its sub categories); "Set category" for the ticked items
import { $, esc, errText } from './util.js';
import { isOwner, signedIn } from './session.js';

await signedIn;
let list = [];   // every category: { id, name, parent_id, path, level, hsn, gst_rate, active, items, allItems, children, defaults }
const listeners = [];

export const categories = () => list;
/** The category id for a path typed or picked in a Category box ('' = none, undefined = not found). */
export function catIdByPath(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s*(?:>|›|»|\/)\s*/g, ' > ');
  if (!t) return '';
  return list.find((c) => c.active && c.path.toLowerCase() === t)?.id;
}
export const pathById = (id) => list.find((c) => c.id === id)?.path ?? '';
export const defaultsOf = (id) => list.find((c) => c.id === id)?.defaults ?? { hsn: '', gst_rate: '' };
/** Runs fn now (if loaded) and every time the categories change. */
export const onCategories = (fn) => { listeners.push(fn); if (list.length) fn(list); };

const shown = (c) => c.path.replace(/ > /g, ' › ');
export async function refreshCategories() {
  if (!isOwner()) return;
  list = await window.api.listCategories();
  // the Category boxes in Stock In and Products: switched-on categories, searchable by any word of the path
  $('#catPaths').innerHTML = list.filter((c) => c.active).map((c) => `<option value="${esc(c.path)}">${esc(shown(c))}</option>`).join('');
  const keep = $('#prodCat').value;
  $('#prodCat').innerHTML = '<option value="">All categories</option><option value="none">No category</option>'
    + list.map((c) => `<option value="${c.id}">${'   '.repeat(c.level - 1)}${esc(c.name)}${c.active ? '' : ' (off)'}</option>`).join('');
  $('#prodCat').value = [...$('#prodCat').options].some((o) => o.value === keep) ? keep : '';
  drawTree();
  for (const fn of listeners) { try { fn(list); } catch { /* one screen must not stop the others */ } }
}

// ---- Settings > Categories ----
const msg = (t, ok) => { const m = $('#catMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
const gstText = (g) => (g === 'auto' ? 'Garment' : g === '' ? '' : `${g}%`);
let editing = null;   // { id } to change, or { parent_id } to add under

function drawTree() {
  $('#catTree').innerHTML = !list.length ? '<p class="note">No categories yet - add a main category above.</p>'
    : `<table class="cat-tree"><thead><tr><th>Category</th><th>Default HSN</th><th>Default GST</th><th class="num">Items</th><th></th></tr></thead><tbody>${
      list.map((c) => `<tr class="lv${c.level}${c.active ? '' : ' off'}" data-id="${c.id}">
        <td><span class="cat-name">${esc(c.name)}</span>${c.active ? '' : ' <small>(switched off)</small>'}</td>
        <td>${c.hsn ? esc(c.hsn) : `<span class="dim">${esc(c.defaults.hsn || '-')}</span>`}</td>
        <td>${c.gst_rate ? esc(gstText(c.gst_rate)) : `<span class="dim">${esc(gstText(c.defaults.gst_rate) || '-')}</span>`}</td>
        <td class="num">${c.allItems}</td>
        <td class="cat-btns">${c.level < 3 && c.active ? '<button class="ghost small" data-act="sub">+ Sub category</button>' : ''}
          <button class="ghost small" data-act="edit">Change</button>
          <button class="ghost small" data-act="onoff">${c.active ? 'Switch off' : 'Switch on'}</button>
          ${!c.allItems && !c.children ? '<button class="ghost small" data-act="del">Delete</button>' : ''}</td></tr>`).join('')}</tbody></table>
      <p class="note">Grey HSN / GST come from a parent category.</p>`;
  for (const b of $('#catTree').querySelectorAll('button[data-act]')) {
    const c = list.find((x) => x.id === Number(b.closest('tr').dataset.id));
    b.addEventListener('click', () => act(b.dataset.act, c));
  }
}

async function act(what, c) {
  try {
    if (what === 'sub') return openEdit({ parent_id: c.id });
    if (what === 'edit') return openEdit({ id: c.id });
    if (what === 'onoff') { await window.api.updateCategory(c.id, { active: !c.active }); await refreshCategories(); return msg(`${c.name} is ${c.active ? 'switched off' : 'switched on'}`, true); }
    if (what === 'del') {
      if (!confirm(`Delete the category "${c.path}"?`)) return;
      await window.api.deleteCategory(c.id); await refreshCategories(); msg(`${c.name} deleted`, true);
    }
  } catch (e) { msg(errText(e), false); }
}

function openEdit(e) {
  editing = e;
  const c = e.id ? list.find((x) => x.id === e.id) : null;
  const parent = c ? c.parent_id : e.parent_id;
  $('#catEditTitle').textContent = c ? `Change "${shown(c)}"` : `New sub category under "${shown(list.find((x) => x.id === parent))}"`;
  // where it can go: nowhere under itself; the tree goes 3 levels deep at most
  const below = (id) => { const kids = list.filter((x) => x.parent_id === id); return kids.length ? 1 + Math.max(...kids.map((k) => below(k.id))) : 0; };
  const mine = c ? list.filter((x) => x.path === c.path || x.path.startsWith(`${c.path} > `)).map((x) => x.id) : [];
  const fits = (p) => p.level + 1 + (c ? below(c.id) : 0) <= 3 && !mine.includes(p.id);
  $('#catParent').innerHTML = '<option value="">(main category)</option>'
    + list.filter((p) => p.active && fits(p)).map((p) => `<option value="${p.id}">${esc(shown(p))}</option>`).join('');
  $('#catParent').value = parent ?? '';
  $('#catName').value = c?.name ?? '';
  $('#catHsn').value = c?.hsn ?? '';
  $('#catGst').value = c?.gst_rate ?? '';
  $('#catEdit').hidden = false;
  $('#catName').focus();
}

$('#catSave').addEventListener('click', async () => {
  const data = { name: $('#catName').value, parent_id: $('#catParent').value || null, hsn: $('#catHsn').value, gst_rate: $('#catGst').value };
  try {
    if (editing?.id) await window.api.updateCategory(editing.id, data);
    else await window.api.addCategory(data);
    $('#catEdit').hidden = true;
    editing = null;
    await refreshCategories();
    msg(`${data.name.trim()} saved`, true);
  } catch (e) { msg(errText(e), false); }
});
$('#catCancel').addEventListener('click', () => { $('#catEdit').hidden = true; editing = null; });
$('#catAddMain').addEventListener('click', async () => {
  try {
    await window.api.addCategory({ name: $('#catNew').value });
    msg(`${$('#catNew').value.trim()} added`, true);
    $('#catNew').value = '';
    await refreshCategories();
  } catch (e) { msg(errText(e), false); }
});
$('#catNew').addEventListener('keydown', (e) => e.key === 'Enter' && $('#catAddMain').click());

// ---- Products: give the ticked items a category ----
const ticked = () => [...document.querySelectorAll('#productRows input.tick:checked')].map((i) => i.dataset.code);
export function showTicked() {
  const n = ticked().length;
  $('#setCatBar').hidden = !n;
  $('#setCatCount').textContent = `${n} item(s) ticked`;
}
const setMsg = (t, ok) => { const m = $('#setCatMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; };
async function setFor(id) {
  try {
    const n = await window.api.setCategoryForItems(ticked(), id);
    setMsg(id ? `${n} item(s) now in ${shown(list.find((c) => c.id === id))}` : `Category removed from ${n} item(s)`, true);
    await refreshCategories();
    document.dispatchEvent(new CustomEvent('products-changed'));
  } catch (e) { setMsg(errText(e), false); }
}
$('#setCatGo').addEventListener('click', () => {
  const id = catIdByPath($('#setCatPick').value);
  if (!id) return setMsg('Choose a category from the list', false);
  setFor(id);
});
$('#setCatNone').addEventListener('click', () => setFor(null));
document.addEventListener('change', (e) => { if (e.target.matches?.('#productRows input.tick')) showTicked(); });

document.querySelector('[data-view="settings"]')?.addEventListener('click', refreshCategories);
document.querySelector('[data-view="products"]')?.addEventListener('click', refreshCategories);
document.querySelector('[data-view="stockin"]')?.addEventListener('click', refreshCategories);
refreshCategories();
