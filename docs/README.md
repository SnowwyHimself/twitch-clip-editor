# Landing page (`docs/`)

Static landing/download page for Clip Editor. Pure `index.html` + `styles.css` +
`main.js` — no build step, no frameworks, no external requests (fonts use the
system stack; favicons and the OG image are self-hosted in `assets/`).

## Preview locally

```bash
cd docs
python3 -m http.server 8091
# open http://127.0.0.1:8091
```

(Just opening `index.html` with `file://` works too, but the GitHub API version
fetch is happier over `http://`.)

## Deploy

Published straight from this `docs/` folder — no build, no workflow. A
`.nojekyll` file tells Pages to serve the files as-is.

**One-time setup:** repo **Settings → Pages → Build and deployment → Source:
"Deploy from a branch" → Branch: `main`, Folder: `/docs` → Save**. Every push to
`main` that changes `docs/` republishes automatically. Live at:

```
https://snowwyhimself.github.io/twitch-clip-editor/
```

### Custom domain (later)

All asset paths are relative, so a custom domain is a drop-in:

1. Buy the domain and add a `CNAME` DNS record pointing at
   `snowwyhimself.github.io`.
2. Add a file `docs/CNAME` containing just the domain (e.g. `clipeditor.app`).
3. Update the `<link rel="canonical">` and the `og:image` URL in `index.html`
   to the new domain, and push.

## Rebranding

The app name and all links live in **one config object** at the top of
`main.js` (`CONFIG`). Change `APP_NAME` and it updates the header, footer, and
tab title; change `REPO` to repoint every GitHub + download link. `MAC_ASSET` /
`WIN_ASSET` are the electron-builder installer filenames.

> Note: the static `<title>` and `<meta>` tags in `index.html` still say "Clip
> Editor" for no-JS crawlers — do a find/replace there too on a full rebrand.

## Download links

Buttons point at `releases/latest/download/<asset>` — always the newest release,
no editing per version. The version number shown is fetched client-side from the
GitHub API (`/releases/latest`) and falls back silently to "Latest release" if
offline or rate-limited.

## Hero recordings (the two videos)

The hero shows a short **editor** loop composited with a **phone** loop of the
exported result. Both are optional: until the files exist, the page renders a
pure-CSS mock of each and looks complete — `main.js` only swaps a video in once
it actually loads (`loadeddata`), and reduced-motion visitors keep the mock. So
the site works with zero, one, or both recordings present.

Files the page looks for (drop them in `docs/assets/`):

| Slot   | Video (loop)                    | Poster (first frame)   | Frame / aspect        |
| ------ | ------------------------------- | ---------------------- | --------------------- |
| Editor | `hero.webm` + `hero.mp4`        | `hero-poster.png`      | window chrome, ~16:10 |
| Result | `result.webm` + `result.mp4`    | `result-poster.png`    | phone screen, 9:16    |

Ship **both** `.webm` (VP9/AV1, small) and `.mp4` (H.264, Safari/iOS fallback) —
the `<source>` order in `index.html` already prefers webm. Target **2–4 MB each**.

### 1. Editor recording (`hero.*`)

Screen-record the app window itself (no OS chrome, no cursor if you can help it):

- **Window size:** 1280×800 (16:10), dark theme, app maximized-but-windowed so
  its own title bar shows. The hero frame masks to ~16:10, so keep the important
  UI away from the extreme edges.
- **Length:** 8–12 s, then it loops. End on a state close to the start frame so
  the loop is seamless (e.g. finish mid-scrub, not on a modal).
- **On-screen actions, in order:** paste a Twitch clip URL → the clip loads and
  reframes to 9:16 → auto-captions pop onto the timeline → scrub so a caption or
  two animate in the preview. Calm, single-take; no rapid panel switching.
- **Poster:** grab a representative frame (see below) as `hero-poster.png` — it
  shows before the video buffers and on reduced-motion.

### 2. Result recording (`result.*`)

The exported 9:16 short, as it plays back — this fills the phone frame:

- **Aspect:** exactly **9:16** (1080×1920 source is ideal; it's scaled down).
  No window chrome — just the finished vertical video, captions burned in.
- **Length:** 6–10 s loop of the punchiest moment, captions visibly animating.
- **Poster:** `result-poster.png`, a frame with a caption on screen.

### 3. Compress + generate posters (ffmpeg)

Point these at your raw screen-capture (`raw-hero.mov` / `raw-result.mov`). They
scale down, strip audio (`-an`), and target a small looping file. Bump `-crf`
up (webm) / down-bitrate (mp4) if you land above ~4 MB.

```bash
# ── Editor: hero.webm + hero.mp4 (cap width 1280) ──
ffmpeg -i raw-hero.mov -an -vf "scale=1280:-2:flags=lanczos,fps=30" \
  -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -pix_fmt yuv420p docs/assets/hero.webm
ffmpeg -i raw-hero.mov -an -vf "scale=1280:-2:flags=lanczos,fps=30" \
  -c:v libx264 -crf 26 -preset slow -profile:v high -pix_fmt yuv420p \
  -movflags +faststart docs/assets/hero.mp4

# ── Result: result.webm + result.mp4 (9:16, cap width 540) ──
ffmpeg -i raw-result.mov -an -vf "scale=540:-2:flags=lanczos,fps=30" \
  -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -pix_fmt yuv420p docs/assets/result.webm
ffmpeg -i raw-result.mov -an -vf "scale=540:-2:flags=lanczos,fps=30" \
  -c:v libx264 -crf 25 -preset slow -profile:v high -pix_fmt yuv420p \
  -movflags +faststart docs/assets/result.mp4

# ── Posters: single frame at ~1s (raise -ss to pick a better frame) ──
ffmpeg -ss 1 -i raw-hero.mov   -frames:v 1 docs/assets/hero-poster.png
ffmpeg -ss 1 -i raw-result.mov -frames:v 1 docs/assets/result-poster.png
```

> `-movflags +faststart` moves the MP4 index to the front so it can start
> playing before it's fully downloaded. `-b:v 0 -crf` is VP9's quality-target
> (constant-quality) mode — smaller than fixed-bitrate for screen content.

## Other assets

- **OG / favicons** — generated from `assets/logo.svg`. To regenerate after a
  logo change, re-run the small resvg script noted in the repo (renders
  `favicon-16/32`, `apple-touch-icon`, `icon-512`, and `og.png` 1200×630).
