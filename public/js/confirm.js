// Small styled confirm dialog for destructive actions — matches the app's
// modal chrome (reuses .export-modal/.export-card) instead of the native
// browser confirm(). Returns a Promise<boolean>: true = confirmed, false =
// cancelled. Escape or a click on the backdrop cancels; Enter confirms. Built
// on demand so there's no always-present markup to keep in sync.

// "Add clip" chooser: offers pasting a clip URL or picking a file, matching the
// same modal chrome. Resolves { mode: 'url', url } | { mode: 'file' } | null
// (cancelled). prefillUrl seeds the input (e.g. from the top URL bar).
export function addClipDialog({ prefillUrl = '' } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'export-modal confirm-modal';
    const card = document.createElement('div');
    card.className = 'export-card confirm-card add-clip-card';

    const h = document.createElement('h2');
    h.className = 'confirm-title';
    h.textContent = 'Add a clip';
    card.appendChild(h);

    const note = document.createElement('p');
    note.className = 'confirm-note';
    note.textContent = 'Paste another Twitch clip link, or choose a video file. It’s appended after the current footage.';
    card.appendChild(note);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'add-clip-input';
    input.placeholder = 'Paste a Twitch clip link…';
    input.value = prefillUrl || '';
    card.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'secondary-btn';
    fileBtn.textContent = 'Choose file…';
    const urlBtn = document.createElement('button');
    urlBtn.type = 'button';
    urlBtn.className = 'primary-btn';
    urlBtn.textContent = 'Add from URL';
    actions.append(fileBtn, urlBtn);
    card.appendChild(actions);

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const isUrl = (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    };
    const syncUrlBtn = () => {
      urlBtn.disabled = !isUrl(input.value.trim());
    };
    syncUrlBtn();
    input.addEventListener('input', syncUrlBtn);

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && isUrl(input.value.trim())) {
        e.stopPropagation();
        close({ mode: 'url', url: input.value.trim() });
      }
    };
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(null);
    });
    fileBtn.addEventListener('click', () => close({ mode: 'file' }));
    urlBtn.addEventListener('click', () => {
      if (isUrl(input.value.trim())) close({ mode: 'url', url: input.value.trim() });
    });
    document.addEventListener('keydown', onKey, true);
    input.focus();
  });
}

// A single-line text prompt (name a template, rename, etc.). Resolves to the
// trimmed string on confirm, or null on cancel. Matches the confirm dialog's
// look; Enter confirms, Esc cancels.
export function promptDialog({
  title = 'Name',
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  maxLength = 80,
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

    if (label) {
      const l = document.createElement('label');
      l.className = 'field-label';
      l.textContent = label;
      card.appendChild(l);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    card.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary-btn';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'primary-btn';
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
    const submit = () => {
      const v = input.value.trim();
      close(v || null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        submit();
      }
    };
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(null);
    });
    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', submit);
    document.addEventListener('keydown', onKey, true);
    input.focus();
    input.select();
  });
}

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
