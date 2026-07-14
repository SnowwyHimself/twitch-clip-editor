// Personal asset library (client): loads the user's saved sounds/music/overlays/
// fonts once, caches them, and renders a reusable "My library" section into any
// picker. Import/rename/delete all route through the token-guarded server API in
// api.js; every picker gets the same hover-preview/select UX as the built-ins.

import { fetchLibrary, importToLibrary, renameLibraryItem, removeLibraryItem } from './api.js';
import { icon } from './icons.js';
import { confirmDialog } from './confirm.js';

let cache = null; // array of library items, or null until first load
const listeners = new Set();

export async function loadLibrary(force = false) {
  if (cache && !force) return cache;
  try {
    cache = await fetchLibrary();
  } catch {
    cache = [];
  }
  registerLibraryFonts();
  return cache;
}

// Register an @font-face for every library font so the live preview can render
// it — family name `libfont-<id>`, matching preview.js previewFontFamily(). The
// same file is loaded server-side for export (caption.js), so preview and render
// use identical glyphs. Rebuilt whenever the library changes.
function registerLibraryFonts() {
  let styleEl = document.getElementById('library-font-faces');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'library-font-faces';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = (cache || [])
    .filter((it) => it.category === 'fonts')
    .map((it) => `@font-face{font-family:'libfont-${it.id}';src:url('${it.url || `/api/library/file/${it.id}`}');font-display:swap;}`)
    .join('\n');
}
export function libraryItems(category) {
  const items = cache || [];
  return category ? items.filter((i) => i.category === category) : items;
}
// Re-render hooks: pickers subscribe so a save/rename/delete refreshes them live.
export function onLibraryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

export async function saveToLibrary(category, file) {
  const result = await importToLibrary(category, file); // { item, deduped }
  await loadLibrary(true);
  notify();
  return result;
}
export async function renameItem(id, name) {
  const item = await renameLibraryItem(id, name);
  await loadLibrary(true);
  notify();
  return item;
}
export async function deleteItem(id) {
  await removeLibraryItem(id);
  await loadLibrary(true);
  notify();
}

const SEARCH_THRESHOLD = 12; // a search box appears once a section passes this

// Render the "My library" section for one category into `container`.
//   onPick(item)      -> user clicked the item (add it to the timeline)
//   renderThumb(item) -> returns an HTMLElement for the item's thumbnail/preview
//   emptyText         -> the one quiet line shown when the section is empty
// Items carry inline rename (pencil) and delete (trash, with a confirm) that
// never trigger onPick. A filter box shows once the section has > 12 items.
export function renderLibrarySection(container, category, { onPick, renderThumb, emptyText }) {
  if (!container) return;
  const items = libraryItems(category).slice().sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  container.innerHTML = '';

  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'field-hint library-empty';
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'preset-grid library-grid';

  const paint = (filter = '') => {
    grid.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const shown = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
    for (const item of shown) {
      grid.appendChild(buildLibraryItem(item, { onPick, renderThumb }));
    }
    if (shown.length === 0) {
      const none = document.createElement('p');
      none.className = 'field-hint';
      none.textContent = 'No matches.';
      grid.appendChild(none);
    }
  };

  if (items.length > SEARCH_THRESHOLD) {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'library-search';
    search.placeholder = `Search ${items.length} items…`;
    search.addEventListener('input', () => paint(search.value));
    container.appendChild(search);
  }
  container.appendChild(grid);
  paint();
}

function buildLibraryItem(item, { onPick, renderThumb }) {
  const wrap = document.createElement('div');
  wrap.className = 'library-item';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'preset-item library-pick';
  btn.title = item.name;
  const thumb = renderThumb(item);
  if (thumb) btn.appendChild(thumb);
  const label = document.createElement('span');
  label.className = 'library-name';
  label.textContent = item.name;
  btn.appendChild(label);
  btn.addEventListener('click', () => onPick(item));
  wrap.appendChild(btn);

  const actions = document.createElement('div');
  actions.className = 'library-item-actions';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'library-act icon-btn';
  renameBtn.title = 'Rename';
  renameBtn.setAttribute('aria-label', 'Rename');
  renameBtn.innerHTML = icon('pencil');
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineRename(item, label, btn);
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'library-act icon-btn';
  delBtn.title = 'Delete from library';
  delBtn.setAttribute('aria-label', 'Delete from library');
  delBtn.innerHTML = icon('trash');
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Delete from your library?',
      itemName: item.name,
      note: 'The file is removed from your library. Projects already using it keep working until reopened; then they show a “missing asset” you can re-import.',
      confirmLabel: 'Delete',
    });
    if (ok) await deleteItem(item.id); // notify() re-renders the section
  });

  actions.appendChild(renameBtn);
  actions.appendChild(delBtn);
  wrap.appendChild(actions);
  return wrap;
}

function startInlineRename(item, label, btn) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'library-rename-input';
  input.value = item.name;
  input.maxLength = 120;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== item.name) {
      await renameItem(item.id, next); // notify() re-renders (rebuilds the label)
    } else {
      input.replaceWith(label); // unchanged/cancelled — restore the label in place
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  // don't let clicks inside the input bubble to the pick button
  input.addEventListener('click', (e) => e.stopPropagation());
}
