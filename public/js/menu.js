// Tiny floating context menu, shared by the timeline right-click and the
// inspector overflow (⋯) button. items: [{ label, disabled?, onClick } | { separator:true }].
let openEl = null;

function close() {
  if (!openEl) return;
  openEl.remove();
  openEl = null;
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
}

function onDocDown(e) {
  if (openEl && !openEl.contains(e.target)) close();
}
function onKey(e) {
  if (e.key === 'Escape') close();
}

export function showContextMenu(x, y, items) {
  close();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.separator) {
      const hr = document.createElement('div');
      hr.className = 'ctx-menu-sep';
      menu.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-menu-item';
    b.textContent = it.label;
    if (it.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => {
        close();
        it.onClick();
      });
    }
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // Keep it on-screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  openEl = menu;
  // Defer so the opening click/right-click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}
