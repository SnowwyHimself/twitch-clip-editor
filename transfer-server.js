// Send-to-Phone transfer server — a SEPARATE, minimal HTTP server for phone
// access over the local network. It is deliberately isolated from the main app
// server (which stays loopback-only, untouched):
//   * Runs ONLY while "Phone access" is enabled (starts on enable, stops on
//     disable and on app quit).
//   * Binds the chosen LAN IPv4 on an OS-assigned random high port.
//   * Serves ONLY: the companion page assets, the /pair endpoint, an authed
//     recent-exports list, and authed downloads/posters of files from the
//     exports directory (via the injected resolveInside — exported files only,
//     no directory listing, nothing else on disk).
//   * Has ZERO access to the editor API, projects, library, or settings —
//     anything not explicitly routed here is a 404.
//   * Device-token auth on every list/download; one-time, expiring, rate-limited
//     pairing codes; basic per-IP rate limiting; logs nothing sensitive.
//
// Plain HTTP on the LAN is acceptable for this threat model (same-network
// transfer, tokened) — see SECURITY.md. The control plane (enable/disable, pair
// code, device management) lives on the AUTHED loopback server, not here.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let makeMdns = null;
try {
  makeMdns = require('multicast-dns');
} catch {
  makeMdns = null; // mDNS is a nicety; the IP always works as a fallback
}

// The friendly hostname the phone sees in its address bar instead of a raw IP.
// We answer mDNS A-queries for it with the active LAN IP (see startMdns).
const MDNS_HOST = 'clip-editor.local';

const PAIR_CODE_TTL_MS = 2 * 60 * 1000; // one-time pairing codes expire in 2 min
const DEVICE_TOKEN_BYTES = 32; // 256-bit per-device tokens
const PAIR_CODE_BYTES = 16; // 128-bit one-time codes (ride the QR, never typed)

// Basic per-IP fixed-window rate limits (defense-in-depth; codes are already
// unguessable + single-use + expiring).
const RL_WINDOW_MS = 60 * 1000;
const RL_PAIR_MAX = 30; // pairing attempts / IP / minute
const RL_API_MAX = 240; // list+download+poster / IP / minute

function timingEqualHex(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Pick a sensible active LAN IPv4: skip internal/loopback and down interfaces,
// prefer common Wi-Fi/Ethernet names and RFC1918 private ranges, and de-prioritise
// virtual/VPN/bridge interfaces so the QR encodes the address a phone can reach.
function pickLanAddress() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      const isPrivate = /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      const n = name.toLowerCase();
      let score = 0;
      if (isPrivate) score += 10;
      if (/^en0$|wi-?fi|wlan|ethernet|en\d/.test(n)) score += 5;
      // de-prioritise virtual / VPN / container bridges
      if (/vmnet|vboxnet|utun|tun|tap|bridge|docker|veth|zt|tailscale|wg/.test(n)) score -= 8;
      if (/^169\.254\./.test(ip)) score -= 20; // link-local (no DHCP)
      candidates.push({ ip, name, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return candidates.length ? candidates[0].ip : null;
}

// List EVERY active non-internal IPv4 (for the settings "other addresses" hint /
// multi-network edge cases).
function listLanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}

function createTransferServer({ outputsDir, resolveInside, safeLeaf, listExports, dataDir, phoneDir, makePoster, bindHost }) {
  // bindHost is an optional override for the LAN address to bind (used by tests
  // to bind loopback). Production leaves it undefined → the active LAN IPv4.
  const DEVICES_FILE = path.join(dataDir, 'phone-devices.json');

  let server = null;
  let address = null; // { ip, port } while running
  const pairCodes = new Map(); // code -> expiresAt (ms)
  const rate = new Map(); // ip -> { pair:{n,win}, api:{n,win} }

  // --- paired devices (persisted; token stored only as a sha256 hash) ---------
  function readDevices() {
    try {
      const v = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function writeDevices(list) {
    try {
      fs.writeFileSync(DEVICES_FILE, JSON.stringify(list));
    } catch {
      /* best-effort */
    }
  }
  const hashToken = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex');

  // Public (safe) view of devices for the settings UI — never the token/hash.
  function publicDevices() {
    return readDevices().map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen }));
  }
  function renameDevice(id, name) {
    const list = readDevices();
    const d = list.find((x) => x.id === id);
    if (!d) return false;
    d.name = String(name || '').slice(0, 60) || d.name;
    writeDevices(list);
    return true;
  }
  function revokeDevice(id) {
    const list = readDevices();
    const next = list.filter((x) => x.id !== id);
    writeDevices(next);
    return next.length !== list.length;
  }
  function revokeAll() {
    writeDevices([]);
  }

  // Validate a presented device token: hash it and timing-safe compare to each
  // stored hash. Bumps lastSeen on success. Returns the device or null.
  function deviceForToken(tok) {
    if (!tok || typeof tok !== 'string' || tok.length < 32) return null;
    const h = hashToken(tok);
    const list = readDevices();
    let hit = null;
    for (const d of list) {
      if (d.tokenHash && timingEqualHex(h, d.tokenHash)) hit = d;
    }
    if (hit) {
      hit.lastSeen = Date.now();
      writeDevices(list);
    }
    return hit;
  }

  // --- one-time pairing codes -------------------------------------------------
  const PAIR_GRACE_MS = 15 * 1000; // idempotent re-hit window (double-loads)
  function createPairCode() {
    const code = crypto.randomBytes(PAIR_CODE_BYTES).toString('hex');
    pairCodes.set(code, { expires: Date.now() + PAIR_CODE_TTL_MS });
    // opportunistic sweep of expired/consumed codes
    const now = Date.now();
    for (const [c, e] of pairCodes) {
      if (e.expires < now && !e.token) pairCodes.delete(c);
      if (e.token && now - e.usedAt > PAIR_GRACE_MS) pairCodes.delete(c);
    }
    return code;
  }
  // Redeem a code: mints EXACTLY ONE device token (and device record) on first
  // use; a re-hit within a short grace window returns the SAME token (so a
  // browser/scanner that loads the URL twice still pairs cleanly, without
  // creating a second device). After the grace window the code is dead. Returns
  // the device token, or null.
  const clientFp = (ip, ua) => crypto.createHash('sha256').update(String(ip) + '|' + String(ua)).digest('hex');
  function redeemPairCode(code, ua, ip) {
    if (!code || typeof code !== 'string') return null;
    const e = pairCodes.get(code);
    if (!e) return null;
    const now = Date.now();
    if (e.token) {
      // Already redeemed once. Return the SAME token only to the SAME device
      // (ip+ua) within the grace window — tolerates a double-load, but an
      // attacker on another IP can't replay the code. Otherwise it's dead.
      if (now - e.usedAt <= PAIR_GRACE_MS && e.fp === clientFp(ip, ua)) return e.token;
      if (now - e.usedAt > PAIR_GRACE_MS) pairCodes.delete(code);
      return null;
    }
    if (e.expires < now) {
      pairCodes.delete(code);
      return null;
    }
    const token = crypto.randomBytes(DEVICE_TOKEN_BYTES).toString('hex');
    e.token = token;
    e.usedAt = now;
    e.fp = clientFp(ip, ua);
    const list = readDevices();
    list.push({
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      name: deviceNameFromUA(ua),
      created: now,
      lastSeen: now,
    });
    writeDevices(list);
    return token;
  }
  function deviceNameFromUA(ua) {
    const s = String(ua || '');
    if (/iphone/i.test(s)) return 'iPhone';
    if (/ipad/i.test(s)) return 'iPad';
    if (/android/i.test(s)) return 'Android phone';
    if (/macintosh|mac os x/i.test(s)) return 'Mac';
    if (/windows/i.test(s)) return 'Windows PC';
    return 'Phone';
  }

  // --- rate limiting ----------------------------------------------------------
  function rateOk(ip, kind) {
    const now = Date.now();
    let r = rate.get(ip);
    if (!r) {
      r = { pair: { n: 0, win: now }, api: { n: 0, win: now } };
      rate.set(ip, r);
    }
    const b = r[kind];
    if (now - b.win > RL_WINDOW_MS) {
      b.n = 0;
      b.win = now;
    }
    b.n += 1;
    return b.n <= (kind === 'pair' ? RL_PAIR_MAX : RL_API_MAX);
  }

  // --- static companion assets (explicit allowlist; no directory serving) -----
  const ASSETS = {
    '/': { file: 'companion.html', type: 'text/html; charset=utf-8' },
    '/app': { file: 'companion.html', type: 'text/html; charset=utf-8' },
    '/companion.css': { file: 'companion.css', type: 'text/css; charset=utf-8' },
    '/companion.js': { file: 'companion.js', type: 'text/javascript; charset=utf-8' },
    '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
    '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
    '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
    '/icon-maskable.png': { file: 'icon-maskable.png', type: 'image/png' },
    '/favicon.ico': { file: 'icon-192.png', type: 'image/png' },
  };

  function send(res, status, headers, body) {
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }
  // Companion HTML gets a strict CSP: everything is same-origin, no inline
  // scripts (the pair token rides a <meta> tag), no framing.
  function sendHtml(res, html) {
    send(
      res,
      200,
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
      html
    );
  }
  function sendFile(res, absPath, type) {
    fs.stat(absPath, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      fs.createReadStream(absPath).on('error', () => res.destroyed || res.end()).pipe(res);
    });
  }
  const pairedGate = () => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Clip Editor</title><body style="font-family:system-ui;background:#0e0e12;color:#e8e8ec;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px"><div><h2 style="color:#7c5cff">Pairing expired</h2><p style="color:#9a9aa5">Open “Phone access” on the desktop app and scan the QR code again.</p></div>`;

  function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request');
    }
    const p = url.pathname;
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';

    // Only GET/HEAD are ever needed here.
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method not allowed');

    // --- pairing: exchange a one-time code for a device token -----------------
    if (p === '/pair') {
      if (!rateOk(ip, 'pair')) return send(res, 429, { 'Content-Type': 'text/plain' }, 'Slow down');
      const code = url.searchParams.get('code');
      const token = redeemPairCode(code, req.headers['user-agent'], ip);
      if (!token) {
        return send(res, 403, { 'Content-Type': 'text/html; charset=utf-8' }, pairedGate());
      }
      // Land on the companion page carrying the token ONCE via a meta tag (not an
      // inline script, so the page keeps a strict script-src 'self' CSP).
      // companion.js reads it, stores it in localStorage, and removes the tag.
      // token is hex, so it's safe inside the double-quoted attribute. Never logged.
      const html = fs
        .readFileSync(path.join(phoneDir, 'companion.html'), 'utf8')
        .replace('</head>', `<meta name="pair-token" content="${token}"></head>`);
      return sendHtml(res, html);
    }

    // --- authed API: list / download / poster --------------------------------
    if (p.startsWith('/api/')) {
      if (!rateOk(ip, 'api')) return send(res, 429, { 'Content-Type': 'application/json' }, '{"error":"rate"}');
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const tok = bearer || url.searchParams.get('t') || '';
      const device = deviceForToken(tok);
      if (!device) return send(res, 401, { 'Content-Type': 'application/json' }, '{"error":"unpaired"}');

      if (p === '/api/exports') {
        const items = listExports().map((e) => ({
          name: e.name,
          filename: e.filename,
          durationSec: e.durationSec,
          sizeBytes: e.sizeBytes,
          savedAt: e.savedAt,
        }));
        return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ device: device.name, exports: items }));
      }

      // /api/download/<name> and /api/poster/<name> — resolveInside OUTPUTS_DIR
      // (exported files ONLY; hostile paths throw and 404).
      const dl = p.match(/^\/api\/(download|poster)\/(.+)$/);
      if (dl) {
        const leaf = safeLeaf(decodeURIComponent(dl[2]));
        if (!leaf) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        if (dl[1] === 'poster') {
          const posterLeaf = leaf.replace(/\.[^.]+$/, '') + '.jpg';
          let posterPath;
          try {
            posterPath = resolveInside(outputsDir, posterLeaf);
          } catch {
            return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
          }
          if (fs.existsSync(posterPath)) return sendFile(res, posterPath, 'image/jpeg');
          // Generate lazily (and cache) for exports that predate this feature.
          if (typeof makePoster !== 'function') return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
          return Promise.resolve()
            .then(() => makePoster(leaf))
            .then(() => (fs.existsSync(posterPath) ? sendFile(res, posterPath, 'image/jpeg') : send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found')))
            .catch(() => send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found'));
        }
        // download
        let filePath;
        try {
          filePath = resolveInside(outputsDir, leaf);
        } catch {
          return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        }
        if (!/\.(mp4|mov|webm|m4v)$/i.test(leaf) || !fs.existsSync(filePath)) {
          return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        }
        // Confirm this file is actually a recorded export (belt-and-suspenders on
        // top of resolveInside): only names present in the exports list are served.
        const known = listExports().some((e) => e.name === leaf);
        if (!known) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${leaf}"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(filePath).on('error', () => res.end()).pipe(res);
      }
      return send(res, 404, { 'Content-Type': 'application/json' }, '{"error":"not found"}');
    }

    // --- static companion assets --------------------------------------------
    const asset = ASSETS[p];
    if (asset) {
      if (asset.type.startsWith('text/html')) {
        let html;
        try {
          html = fs.readFileSync(path.join(phoneDir, asset.file), 'utf8');
        } catch {
          return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        }
        return sendHtml(res, html);
      }
      return sendFile(res, path.join(phoneDir, asset.file), asset.type);
    }

    // Everything else on this server is a hard 404 — no editor API, no listing.
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
  }

  // --- mDNS: answer A-queries for clip-editor.local with the LAN IP so the
  // phone sees a friendly hostname instead of a raw IP. Pure nicety — the IP is
  // always a valid fallback in the QR. Skipped for loopback (tests). ------------
  let mdns = null;
  function startMdns(ip) {
    stopMdns();
    if (!makeMdns || !ip || ip.startsWith('127.')) return;
    try {
      mdns = makeMdns();
      mdns.on('query', (query) => {
        for (const q of query.questions || []) {
          if ((q.type === 'A' || q.type === 'ANY') && String(q.name).toLowerCase() === MDNS_HOST) {
            try {
              mdns.respond({ answers: [{ name: MDNS_HOST, type: 'A', ttl: 120, data: ip }] });
            } catch {}
          }
        }
      });
      mdns.respond({ answers: [{ name: MDNS_HOST, type: 'A', ttl: 120, data: ip }] }); // announce
    } catch {
      mdns = null;
    }
  }
  function stopMdns() {
    if (!mdns) return;
    try {
      if (address && address.ip) mdns.respond({ answers: [{ name: MDNS_HOST, type: 'A', ttl: 0, data: address.ip }] }); // goodbye
      mdns.destroy();
    } catch {}
    mdns = null;
  }

  // --- lifecycle --------------------------------------------------------------
  // Resolves once the server is actually listening (so the caller has the port
  // for the QR). OS-assigned random high port, bound to the specific LAN IP only.
  function enable() {
    if (server) return Promise.resolve(getStatus());
    const ip = bindHost || pickLanAddress();
    if (!ip) return Promise.resolve({ enabled: false, reason: 'no-lan' });
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      let settled = false;
      s.on('error', () => {
        try {
          s.close();
        } catch {}
        if (server === s) server = null;
        address = null;
        if (!settled) {
          settled = true;
          resolve({ enabled: false, reason: 'listen-error' });
        }
      });
      s.listen(0, ip, () => {
        server = s;
        address = { ip, port: s.address().port };
        startMdns(ip);
        if (!settled) {
          settled = true;
          resolve({ enabled: true, ip, port: address.port, host: mdns ? MDNS_HOST : null });
        }
      });
    });
  }
  function disable() {
    pairCodes.clear();
    stopMdns();
    if (server) {
      try {
        server.close();
      } catch {}
      server = null;
    }
    address = null;
    return { enabled: false };
  }
  function isEnabled() {
    return !!server;
  }
  function getStatus() {
    return {
      enabled: !!server,
      ip: address && address.ip,
      port: address && address.port,
      host: mdns ? MDNS_HOST : null, // friendly hostname when mDNS is advertising
      otherAddresses: listLanAddresses(),
      devices: publicDevices(),
    };
  }

  return {
    enable,
    disable,
    isEnabled,
    getStatus,
    createPairCode,
    renameDevice,
    revokeDevice,
    revokeAll,
    publicDevices,
    _pickLanAddress: pickLanAddress,
  };
}

module.exports = { createTransferServer, pickLanAddress, listLanAddresses };
