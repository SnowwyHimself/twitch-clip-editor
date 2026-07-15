// Quiet, auto-dismissing toast notices (export finished, etc.). One optional
// inline action + a dismiss ✕. Stacks bottom-right, above the corner pills.
export function showToast({ message, actionLabel, onAction, duration = 6000 } = {}) {
  const host = document.getElementById('toast-stack');
  if (!host) return () => {};

  const el = document.createElement('div');
  el.className = 'toast';

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message || '';
  el.appendChild(msg);

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      try {
        onAction();
      } finally {
        dismiss();
      }
    });
    el.appendChild(btn);
  }

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '✕';
  x.addEventListener('click', () => dismiss());
  el.appendChild(x);

  host.appendChild(el);

  let done = false;
  let timer = duration ? setTimeout(dismiss, duration) : null;
  function dismiss() {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 200);
  }
  return dismiss;
}
