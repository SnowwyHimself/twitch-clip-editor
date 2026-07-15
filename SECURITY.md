# Security model — Clip Editor

Clip Editor is a **local desktop app**. It edits Twitch clips on your machine
using bundled `ffmpeg`, `yt-dlp`, and `whisper.cpp`. There is **no cloud, no
account, and no telemetry** — nothing about you or your clips is ever sent
anywhere. The app only reaches the network for three narrow, non-tracking
reasons: fetching a Twitch clip *you* paste, an update check (which you can turn
off), and — only if you ask for it — a one-time caption-model download. All three
are described below.

## How it's built

The desktop app is an Electron shell that runs a small local web server
(Express) and loads it in a hardened window. All the UI, editing, and rendering
happen on your computer.

## The local server is locked down

- **Loopback only.** The server binds `127.0.0.1`, so it is not reachable from
  your Wi-Fi/LAN or anywhere off your machine.
- **Token-authenticated.** On each launch the app generates a random secret
  token. Every request must carry it (a header for app requests, a `HttpOnly`,
  `SameSite=Strict` cookie for videos/fonts). Requests without the token get a
  `403`. This means a website you visit in your browser can't quietly drive the
  app (start downloads/exports, delete projects, read files).
- **Host/Origin checked** to defeat DNS-rebinding tricks.
- **No arbitrary file access.** There is no HTTP endpoint that reads a path you
  hand it. Reopening a file-based project is done by the app's own main process
  over a validated internal channel.
- **URLs are restricted to Twitch.** `yt-dlp` is only ever pointed at
  `twitch.tv` / `www` / `clips` / `m.twitch.tv` — never an arbitrary or internal
  address.

## Send to Phone (optional, off by default)

"Phone access" lets you move **exported clips** to your phone over your own
Wi-Fi — no cloud, no account. It is the one feature that deliberately opens the
app to the local network, so it is built as a **separate, scoped server** that
shares nothing with the main app server above.

- **Off by default; you control it.** Nothing listens on the network until you
  turn "Phone access" on in Settings. Turning it off (or quitting the app) stops
  the server and closes the port immediately. The main app server stays
  loopback-only and completely unchanged.
- **A second, minimal server.** When enabled, it binds your active LAN address on
  a random high port. Your OS may ask to "allow incoming connections" the first
  time — that's expected, and it only lets your phone reach this computer on your
  local network.
- **It serves almost nothing.** Only: the companion web page, the pairing
  endpoint, and — to a **paired** device — the list of your recent exports and
  downloads of those exact files (served from the exports folder through the same
  path-containment check the rest of the app uses). It has **no access** to the
  editor API, your projects, your library, or settings. Every other path is a
  `404`. Path-traversal attempts (`../`, encoded, absolute) are rejected, and only
  files that are actually in your recent-exports list are downloadable.
- **Pairing.** Enabling access (or "Send to phone" on an export) shows a QR that
  encodes a **one-time code** (128-bit, single-use, expires in 2 minutes). Your
  phone scans it and receives its own long random **device token** (256-bit,
  stored in the phone's browser). Every list/download must carry a valid token;
  the desktop shows your paired devices and lets you **Revoke** one (or all) —
  which takes effect immediately. Pairing and downloads are rate-limited, and
  nothing sensitive (codes or tokens) is logged.
- **Plain HTTP on the LAN — the tradeoff.** Traffic between your phone and this
  computer is plain HTTP, not HTTPS. For this threat model that is an accepted
  tradeoff: it's your own local network, the transfer is authenticated with an
  unguessable per-device token, and the alternative (a trusted TLS certificate a
  phone would accept for a random local IP) isn't attainable without a cloud
  service — exactly what this feature avoids. Someone already on your Wi-Fi still
  cannot list or download anything without a paired token, and cannot reach any
  other part of the app.
- **To turn it off:** flip "Phone access" off in Settings (or quit the app). To
  cut a specific phone off, Revoke it there.

## The desktop window is hardened

- Renderer runs sandboxed and context-isolated with `nodeIntegration` off; it can
  only call a tiny, explicit set of functions the app exposes (reopen a file,
  and the update pill controls).
- A strict Content-Security-Policy: everything is bundled and same-origin, no
  remote scripts or resources; injected scripts can't run.
- Navigation and pop-up windows are denied. The only external links allowed are
  this app's GitHub page, opened in your normal browser.

## What data lives where

Everything stays under your OS user-data folder for the app
(`~/Library/Application Support/Clip Editor` on macOS,
`%APPDATA%\Clip Editor` on Windows):

- **projects/** — your saved projects (JSON + any imported media)
- **preview-cache/**, **downloads/** — clips fetched from Twitch for preview/export
- **uploads/**, **outputs/** — files you import and the videos you export
- **models/** — the offline speech models used for auto-captions (the bundled
  Fast model, plus any Better/Best model you download — see below)
- **library/** — your personal asset library: sounds/, music/, overlays/, and
  fonts/ you import to reuse across projects, plus a `library.json` index. These
  are files *you* chose to import; nothing is fetched or uploaded. Manage or
  delete them from **Caption/Library settings**, or remove this folder to clear
  the whole library.

Nothing here is uploaded. Delete the folder to wipe all app data.

## Caption models — user-initiated downloads (Hugging Face)

Auto-captions run entirely on your machine with `whisper.cpp`. The **Fast** model
ships bundled, so captions work offline out of the box. Choosing the **Better**
or **Best** quality tier downloads that one model file, **once**, only when *you*
pick it — from the official whisper.cpp model repository on Hugging Face
(`huggingface.co/ggerganov/whisper.cpp`). It's saved to `models/` in your app
data, verified against its exact expected size, and reused forever after; a
cancelled or corrupt download is deleted, never left half-written. No clip audio
or text ever leaves your machine — only the model file comes *in*. You can remove
a downloaded model any time from **Caption quality** settings to reclaim disk.

## Updates — the only background network activity

The app checks this project's **GitHub Releases** page on launch and every ~4
hours to see if a newer version exists. If one does, it downloads it quietly in
the background and verifies its checksum. Only when it's ready does a small
"Relaunch to update" pill appear in the corner — no dialogs, no interruptions.
Click it to relaunch into the new version, or ignore it and it applies the next
time you quit.

- **Turn it off:** menu → **Automatic Updates** (uncheck). With it off, the app
  makes **no** network requests on its own — it only talks to Twitch when *you*
  paste a clip link, or to Hugging Face when *you* choose to download a
  higher-quality caption model.
- **Check manually:** menu → **Check for Updates…**

## Signing note

Current builds are **not code-signed/notarized** (no paid Apple/Windows
certificate). On first launch the OS shows an "unidentified developer" /
"unknown publisher" prompt — that's expected. Right-click → Open (macOS) or
More info → Run anyway (Windows). Signing can be added later without changing the
security model above.

## Reporting an issue

Open a private security advisory or issue on the GitHub repository.
