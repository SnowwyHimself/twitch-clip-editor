// The single source of truth for user-facing actions. Keyboard shortcuts, the
// command palette (⌘K), and the shortcuts overlay (?) all read from here and run
// the SAME entries — no duplicated logic. Each action is registered once (its
// run() calls the existing function / control) and carries an optional shortcut
// used both for matching keydowns and for display.
export const GROUPS = { PLAYBACK: 'Playback', EDITING: 'Editing', TIMELINE: 'Timeline', APP: 'App' };
const GROUP_ORDER = [GROUPS.PLAYBACK, GROUPS.EDITING, GROUPS.TIMELINE, GROUPS.APP];

const actions = new Map();

// a = { id, label, group, shortcut, run, enabled?, hidden? }
// shortcut = { mod?, shift?, alt?, key, display } | null
//   mod  = Cmd/Ctrl. Enforced. shift/alt enforced ONLY if defined (so a bare
//   letter matches with or without Shift, but ⌘Z vs ⌘⇧Z stay distinct).
//   whileTyping: allow firing while a text field is focused (⌘-combos only).
export function registerAction(a) {
  actions.set(a.id, a);
}
export function getActions() {
  return [...actions.values()];
}
export function getAction(id) {
  return actions.get(id) || null;
}
export function isEnabled(a) {
  return !a.enabled || !!a.enabled();
}
export function runActionById(id) {
  const a = actions.get(id);
  if (!a || !isEnabled(a)) return false;
  a.run();
  return true;
}

// Actions grouped + ordered for the shortcuts overlay (only those with a
// shortcut, since the overlay documents keys).
export function actionsByGroup({ withShortcutOnly = false } = {}) {
  const out = GROUP_ORDER.map((g) => ({ group: g, items: [] }));
  const byName = new Map(out.map((o) => [o.group, o]));
  for (const a of actions.values()) {
    if (a.hidden) continue;
    if (withShortcutOnly && !a.shortcut) continue;
    const bucket = byName.get(a.group) || byName.get(GROUPS.APP);
    bucket.items.push(a);
  }
  return out.filter((o) => o.items.length);
}

// Match a keydown against a shortcut descriptor.
export function matchesShortcut(e, sc) {
  if (!sc) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!sc.mod !== !!mod) return false;
  if (typeof sc.shift === 'boolean' && sc.shift !== e.shiftKey) return false;
  if (typeof sc.alt === 'boolean' && sc.alt !== e.altKey) return false;
  const norm = (k) => (k && k.length === 1 ? k.toLowerCase() : k);
  return norm(e.key) === norm(sc.key);
}

// The first action whose shortcut matches this event (honouring the typing
// guard: single-key shortcuts never fire while typing; ⌘-combos may if flagged).
export function actionForEvent(e, { typing = false } = {}) {
  for (const a of actions.values()) {
    if (!a.shortcut) continue;
    if (!matchesShortcut(e, a.shortcut)) continue;
    if (typing && !a.shortcut.whileTyping) continue;
    return a;
  }
  return null;
}

// Human-readable shortcut string for display (e.g. "⌘⇧Z", "⇧→", "Space").
export function shortcutLabel(sc) {
  if (!sc) return '';
  if (sc.display) return sc.display;
  const parts = [];
  if (sc.mod) parts.push('⌘');
  if (sc.shift) parts.push('⇧');
  if (sc.alt) parts.push('⌥');
  parts.push(sc.key.length === 1 ? sc.key.toUpperCase() : sc.key);
  return parts.join('');
}
