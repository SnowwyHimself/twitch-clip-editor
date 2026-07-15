// Command palette (⌘K) + shortcuts overlay (?). Both are generated entirely from
// the action registry, so they can never drift from what the shortcuts actually
// do. Keyboard-first: the palette opens focused, arrows move, Enter runs, Esc
// closes; the overlay is a read-only two-column sheet grouped by area.
import { getActions, actionsByGroup, isEnabled, runActionById, shortcutLabel } from './actions.js';

let palette, input, list, overlay, grid;
let rows = []; // { el, action } for currently-shown (enabled) palette rows
let active = -1;

// --- fuzzy match -------------------------------------------------------------
// Subsequence match with a light score (contiguity + word-start bonus). Returns
// null when the query doesn't match at all.
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    if (found === ti) streak += 1;
    else streak = 0;
    // word-start bonus
    if (found === 0 || t[found - 1] === ' ') score += 3;
    score += 1 + streak;
    ti = found + 1;
  }
  // prefer shorter labels for equal matches
  return score - t.length * 0.01;
}

// --- palette -----------------------------------------------------------------
export function openPalette() {
  if (!palette) return;
  palette.classList.remove('hidden');
  input.value = '';
  renderList('');
  input.focus();
}
function closePalette() {
  if (palette) palette.classList.add('hidden');
}

function renderList(query) {
  const scored = [];
  for (const a of getActions()) {
    if (a.hidden) continue;
    if (!isEnabled(a)) continue; // only runnable commands in the palette
    const s = query ? fuzzyScore(query, a.label) : 0;
    if (s === null) continue;
    scored.push({ a, s });
  }
  scored.sort((x, y) => y.s - x.s || x.a.label.localeCompare(y.a.label));

  list.innerHTML = '';
  rows = [];
  for (const { a } of scored.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'cmd-row';
    row.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.className = 'cmd-row-label';
    label.textContent = a.label;
    row.appendChild(label);
    if (a.shortcut) {
      const kbd = document.createElement('span');
      kbd.className = 'cmd-row-kbd';
      kbd.textContent = shortcutLabel(a.shortcut);
      row.appendChild(kbd);
    }
    row.addEventListener('mousemove', () => setActive(rows.findIndex((r) => r.el === row)));
    row.addEventListener('click', () => run(a.id));
    list.appendChild(row);
    rows.push({ el: row, action: a });
  }
  setActive(rows.length ? 0 : -1);
}

function setActive(i) {
  active = i;
  rows.forEach((r, idx) => r.el.classList.toggle('active', idx === active));
  if (active >= 0) rows[active].el.scrollIntoView({ block: 'nearest' });
}

function run(id) {
  closePalette();
  runActionById(id);
}

function onPaletteKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (rows.length) setActive((active + 1) % rows.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (rows.length) setActive((active - 1 + rows.length) % rows.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0 && rows[active]) run(rows[active].action.id);
  }
}

// --- shortcuts overlay -------------------------------------------------------
export function openShortcuts() {
  if (!overlay) return;
  grid.innerHTML = '';
  for (const { group, items } of actionsByGroup({ withShortcutOnly: true })) {
    const col = document.createElement('div');
    col.className = 'shortcuts-col';
    const h = document.createElement('div');
    h.className = 'shortcuts-group';
    h.textContent = group;
    col.appendChild(h);
    for (const a of items) {
      const row = document.createElement('div');
      row.className = 'shortcuts-row';
      row.innerHTML = `<span class="shortcuts-label"></span><span class="shortcuts-kbd"></span>`;
      row.querySelector('.shortcuts-label').textContent = a.label;
      row.querySelector('.shortcuts-kbd').textContent = shortcutLabel(a.shortcut);
      col.appendChild(row);
    }
    grid.appendChild(col);
  }
  overlay.classList.remove('hidden');
}
function closeShortcuts() {
  if (overlay) overlay.classList.add('hidden');
}
export function shortcutsOpen() {
  return overlay && !overlay.classList.contains('hidden');
}
export function paletteOpen() {
  return palette && !palette.classList.contains('hidden');
}

export function initCommandUI() {
  palette = document.getElementById('cmd-palette');
  input = document.getElementById('cmd-input');
  list = document.getElementById('cmd-list');
  overlay = document.getElementById('shortcuts-overlay');
  grid = document.getElementById('shortcuts-grid');
  if (!palette || !overlay) return;

  input.addEventListener('input', () => renderList(input.value.trim()));
  input.addEventListener('keydown', onPaletteKey);
  palette.addEventListener('mousedown', (e) => {
    if (e.target === palette) closePalette();
  });

  const closeBtn = document.getElementById('shortcuts-close');
  if (closeBtn) closeBtn.addEventListener('click', closeShortcuts);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeShortcuts();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shortcutsOpen()) {
      e.preventDefault();
      closeShortcuts();
    }
  });
}
