# Landing page (`site/`)

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

## Assets you may want to swap

- **Hero visual** — currently a CSS mock of the editor (`.editor-mock` in
  `index.html`). To use a real screenshot instead, capture the editor and drop
  an `<img>` in place of `.editor-mock`:
  - **Window size:** 1280×800 (16:10), dark.
  - **Content state:** a real Twitch clip loaded, reframed to 9:16 (Fill), the
    **Captions** tab active with a few auto-captions visible on the timeline, and
    one caption showing in the preview. Trim the OS chrome; keep the app's own
    title bar. Export at 2× (retina) and save as `assets/hero.png` (or `.webp`).
- **OG / favicons** — generated from `assets/logo.svg`. To regenerate after a
  logo change, re-run the small resvg script noted in the repo (renders
  `favicon-16/32`, `apple-touch-icon`, `icon-512`, and `og.png` 1200×630).
