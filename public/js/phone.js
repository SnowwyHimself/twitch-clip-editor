// Send to Phone — desktop side. Drives the "Phone access" settings modal: the
// master toggle, live status/address, the pairing QR (one-time code), and the
// paired-devices list (rename / revoke / revoke all). The transfer server itself
// is separate and LAN-bound; everything here talks to the loopback control API.
import {
  fetchPhoneAccess,
  setPhoneAccess,
  requestPairCode,
  renamePhoneDevice,
  revokePhoneDevice,
  revokeAllPhoneDevices,
} from './api.js';
import { confirmDialog, promptDialog } from './confirm.js';
import { showToast } from './toast.js';

const $ = (id) => document.getElementById(id);
let lastStatus = { enabled: false, devices: [] };

export const phoneIsPaired = () => (lastStatus.devices || []).length > 0;
export const phoneIsEnabled = () => !!lastStatus.enabled;

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `today ${t}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

function renderQR(url) {
  const box = $('phone-qr');
  box.innerHTML = '';
  if (!window.qrcode) {
    box.textContent = 'QR unavailable';
    return;
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const img = new Image();
  img.src = qr.createDataURL(6, 4); // data: GIF — allowed by img-src 'self' data:
  img.alt = 'Pairing QR code';
  img.className = 'phone-qr-img';
  box.appendChild(img);
}

let lastPair = null; // { url (clip-editor.local), ipUrl, host }
let showingIp = false;
async function newPairCode() {
  try {
    const r = await requestPairCode();
    if (r && r.url) {
      lastPair = r;
      showingIp = false;
      renderQR(r.url);
      updateFallbackUi();
    }
  } catch {
    /* leave the previous QR */
  }
}
// The IP fallback link only appears when a friendly hostname is in use (mDNS).
// Clicking it swaps the QR to the raw-IP URL for phones that don't resolve
// .local; clicking again swaps back.
function updateFallbackUi() {
  const btn = $('phone-use-ip');
  if (!btn) return;
  const hasHost = !!(lastPair && lastPair.host && lastPair.ipUrl);
  btn.classList.toggle('hidden', !hasHost);
  btn.textContent = showingIp ? 'Use the clip-editor.local address again' : 'Phone won’t connect? Use the IP address';
}

function renderDevices(devices) {
  const wrap = $('phone-devices-wrap');
  const list = $('phone-devices');
  wrap.classList.toggle('hidden', !devices.length);
  list.innerHTML = '';
  for (const d of devices) {
    const row = document.createElement('div');
    row.className = 'phone-device-row';
    const info = document.createElement('div');
    info.className = 'phone-device-info';
    info.innerHTML = `<span class="phone-device-name"></span><span class="phone-device-meta"></span>`;
    info.querySelector('.phone-device-name').textContent = d.name || 'Phone';
    info.querySelector('.phone-device-meta').textContent = `paired ${fmtWhen(d.created)} · last seen ${fmtWhen(d.lastSeen)}`;
    const actions = document.createElement('div');
    actions.className = 'phone-device-actions';
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'link-btn';
    ren.textContent = 'Rename';
    ren.addEventListener('click', async () => {
      const name = await promptDialog({ title: 'Rename device', label: 'Device name', value: d.name, confirmLabel: 'Rename' });
      if (name) {
        await renamePhoneDevice(d.id, name);
        refresh();
      }
    });
    const rev = document.createElement('button');
    rev.type = 'button';
    rev.className = 'link-btn';
    rev.textContent = 'Revoke';
    rev.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Revoke this device?', itemName: d.name || 'Phone', note: 'It will need to scan the QR again.', confirmLabel: 'Revoke' });
      if (ok) {
        await revokePhoneDevice(d.id);
        refresh();
      }
    });
    actions.append(ren, rev);
    row.append(info, actions);
    list.appendChild(row);
  }
}

async function refresh() {
  lastStatus = await fetchPhoneAccess();
  const on = !!lastStatus.enabled;
  $('phone-toggle').checked = on;
  $('phone-qr-wrap').classList.toggle('hidden', !on);
  $('phone-firewall').classList.toggle('hidden', !on);
  $('phone-status').textContent = on
    ? 'On — scan the QR with your phone to connect over your Wi‑Fi.'
    : 'Off. Turn on to move exported clips to your phone over your own Wi‑Fi — nothing is uploaded to the internet.';
  renderDevices(lastStatus.devices || []);
  if (on) newPairCode();
}

// Open from Settings or from an export's "Send to phone". fromExport shows a
// hint that the just-finished export is already on the companion page.
export async function openPhoneModal({ fromExport = false } = {}) {
  $('phone-modal').classList.remove('hidden');
  // Launched from an export: clicking "Send to phone" is the consent to open
  // access, so turn it on if it's off — that renders the pairing QR right away.
  if (fromExport) {
    const cur = await fetchPhoneAccess();
    if (!cur.enabled) {
      try {
        await setPhoneAccess(true);
      } catch {
        /* refresh will show it still off */
      }
    }
  }
  await refresh();
  const alreadyPaired = fromExport && phoneIsPaired() && phoneIsEnabled();
  $('phone-export-hint').classList.toggle('hidden', !alreadyPaired);
}

export function initPhone() {
  const modal = $('phone-modal');
  if (!modal) return;
  $('phone-close-btn').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  $('phone-toggle').addEventListener('change', async () => {
    const want = $('phone-toggle').checked;
    try {
      const r = await setPhoneAccess(want);
      if (want && r && r.result && r.result.enabled === false) {
        showToast({ message: r.result.reason === 'no-lan' ? 'No Wi‑Fi/LAN network found to share over.' : "Couldn't start phone access." });
      }
    } catch {
      showToast({ message: "Couldn't change phone access." });
    }
    refresh();
  });
  $('phone-new-code').addEventListener('click', newPairCode);
  $('phone-use-ip').addEventListener('click', () => {
    if (!lastPair) return;
    showingIp = !showingIp;
    renderQR(showingIp ? lastPair.ipUrl : lastPair.url);
    updateFallbackUi();
  });
  $('phone-revoke-all').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Revoke all devices?', note: 'Every paired phone will need to scan the QR again.', confirmLabel: 'Revoke all' });
    if (ok) {
      await revokeAllPhoneDevices();
      refresh();
    }
  });
}
