// "What's new" card: on the first launch after a version change, show ONE quiet
// dismissible corner card (same visual family as the update pill) listing up to
// five bullets from the notes bundled with the build. Dismiss = never again for
// that version. A first-ever install (no stored last-seen version) shows nothing
// — it just records the baseline.
import { fetchAppState, saveAppState, fetchReleaseNotes } from './api.js';

const RELEASES_URL = 'https://github.com/SnowwyHimself/twitch-clip-editor/releases';

export async function initWhatsNew() {
  const [st, rel] = await Promise.all([fetchAppState(), fetchReleaseNotes()]);
  const version = rel.version;
  if (!version) return;

  const lastSeen = st && st.lastSeenVersion;
  // No stored baseline yet (fresh install, or a user from before this feature):
  // record silently and show nothing. The card only appears on a real version
  // change from a known previous version.
  if (!lastSeen) {
    await saveAppState({ lastSeenVersion: version });
    return;
  }
  if (lastSeen === version) return; // already on this version — nothing new
  if (!rel.notes.length) {
    // Version changed but no notes bundled for it — advance the baseline quietly.
    await saveAppState({ lastSeenVersion: version });
    return;
  }
  showCard(version, rel.notes);
}

function showCard(version, notes) {
  const card = document.getElementById('whatsnew-card');
  if (!card) return;
  const title = document.getElementById('whatsnew-title');
  const list = document.getElementById('whatsnew-list');
  const dismiss = document.getElementById('whatsnew-dismiss');
  const all = document.getElementById('whatsnew-all');

  title.textContent = `New in v${version}`;
  list.innerHTML = '';
  for (const n of notes.slice(0, 5)) {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  }
  if (all) all.href = RELEASES_URL;

  card.classList.remove('hidden');

  // Dismiss = never for this version (persist the baseline).
  const close = async () => {
    card.classList.add('hidden');
    await saveAppState({ lastSeenVersion: version });
  };
  dismiss.addEventListener('click', close);
  // "See all changes" opens the releases page and also counts as seen.
  if (all) all.addEventListener('click', () => saveAppState({ lastSeenVersion: version }));
}
