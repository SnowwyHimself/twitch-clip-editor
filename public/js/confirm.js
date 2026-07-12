// Small styled confirm dialog for destructive actions — matches the app's
// modal chrome (reuses .export-modal/.export-card) instead of the native
// browser confirm(). Returns a Promise<boolean>: true = confirmed, false =
// cancelled. Escape or a click on the backdrop cancels; Enter confirms. Built
// on demand so there's no always-present markup to keep in sync.

export function confirmDialog({
  title = 'Are you sure?',
  itemName = '',
  note = 'This can’t be undone.',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'export-modal confirm-modal';

    const card = document.createElement('div');
    card.className = 'export-card confirm-card';

    const h = document.createElement('h2');
    h.className = 'confirm-title';
    h.textContent = title;
    card.appendChild(h);

    if (itemName) {
      const nameEl = document.createElement('p');
      nameEl.className = 'confirm-name';
      nameEl.textContent = itemName;
      card.appendChild(nameEl);
    }
    if (note) {
      const noteEl = document.createElement('p');
      noteEl.className = 'confirm-note';
      noteEl.textContent = note;
      card.appendChild(noteEl);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary-btn';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'danger-btn';
    okBtn.textContent = confirmLabel;
    actions.append(cancelBtn, okBtn);
    card.appendChild(actions);

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        close(true);
      }
    };
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(false);
    });
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    // Capture phase so Escape doesn't also trip other global key handlers.
    document.addEventListener('keydown', onKey, true);
    okBtn.focus();
  });
}
