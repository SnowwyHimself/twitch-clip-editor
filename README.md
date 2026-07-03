# Clip Editor

Converts horizontal Twitch clips (1920x1080) into vertical 1080x1920 videos
for TikTok/Reels/Shorts. The clip is zoomed in and centered on the vertical
canvas, and the empty space above/below is filled with a blurred, stretched
copy of the same footage (the CapCut "blur background" look) instead of
black bars.

## Prerequisites

Make sure these are installed and available on your `PATH`:

- **Node.js 18+**
- **ffmpeg** — does the video processing
- **yt-dlp** — downloads clips from pasted URLs

Check with:

```bash
node -v
ffmpeg -version
yt-dlp --version
```

On macOS with Homebrew: `brew install node ffmpeg yt-dlp`

## Setup (run from source)

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

## Desktop app (no separate installs needed)

For friends who don't want to install Node/ffmpeg/yt-dlp themselves, this
packages the whole thing — Node, ffmpeg, and yt-dlp included — into a real
double-clickable app. Pre-built downloads for both platforms are on the
[Releases page](https://github.com/SnowwyHimself/twitch-clip-editor/releases).

To build it yourself instead:

```bash
npm install
npm run dist:mac   # macOS (arm64) -> dist/Clip Editor-<version>-arm64.dmg
npm run dist:win   # Windows (x64) -> dist/Clip Editor Setup <version>.exe
```

Each fetches its own platform-specific `ffmpeg`/`yt-dlp` binaries first
(`resources/bin-mac/` or `resources/bin-win/` — not committed to the repo,
since yt-dlp especially needs frequent updates to keep working against
site changes) via `scripts/fetch-binaries-mac.sh` / `-win.sh`.

Neither build is code-signed (no paid Apple Developer / Windows code-signing
certificate), so:

- **macOS**: right-click the app → **Open** → confirm, instead of a plain
  double-click, to get past the one-time "unidentified developer"
  warning. If you instead see a hard **"is damaged and can't be opened"**
  error, that's a separate, fixable issue — the app's own signature has to
  properly cover every bundled file (see `scripts/afterSign.js`), not just
  Electron's own binary; a plain unsigned build without that fix triggers
  the false "damaged" error instead of the milder warning.
- **Windows**: SmartScreen will warn about an unrecognized publisher —
  click **More info** → **Run anyway**.

Building the Windows installer from macOS additionally requires
**Rosetta 2** (`softwareupdate --install-rosetta`), since
electron-builder's bundled NSIS installer tool is Intel-only.

## Usage

1. Choose an input method:
   - **Clip URL** — paste a Twitch clip link
   - **Upload file** — pick a video file already on disk
2. Adjust the **zoom** slider (100–200%, default 135%) to control how
   tightly the clip is cropped before centering, and the **blur** slider
   (0–100%, default 20%) to control the background blur strength. At 0%
   there's no blur layer at all — just plain black letterboxing. The
   **speed** slider (0.5x–2x, default 1x) retimes both video and audio
   (audio pitch stays natural, no chipmunk/slow-mo distortion) — at 1x
   it's skipped entirely, no extra re-encoding pass.
3. Optionally type a **caption**, and pick **Outline** (white text, black
   stroke, fixed at 15% of font size ≈ TikTok's ~8-10px look) or **Box**
   (black text on a white rounded bubble, no stroke at all) — matching
   TikTok's native "Classic" in-app caption tool. The caption is always
   centered horizontally, and vertically centered on the seam between the
   sharp foreground clip and the blurred area above it; there's no manual
   position control.
4. Flip on **Mirror** to horizontally flip the whole frame (both the sharp
   footage and the blurred background) — useful for avoiding duplicate-
   content flags on re-uploaded clips. Off by default. Captions are never
   mirrored, so text stays readable either way.
5. Click **Generate edit**. The status area shows live progress
   (downloading, rendering, done, or an error).
6. Once finished, preview the result inline and click **Download edited
   clip** to save it.

## How the conversion works

Given a zoom value (e.g. 1.35) and a fixed 1080x1920 canvas:

- **Background layer**: the source is scaled to cover 1080x1920
  (`force_original_aspect_ratio=increase`), cropped to exactly 1080x1920,
  then blurred (`gblur=sigma=20`).
- **Foreground layer**: the source is scaled so its width is
  `1080 * zoom` (aspect ratio preserved), then cropped back down to width
  1080, centered horizontally, full height — giving a uniformly zoomed-in
  crop of the clip.
- The foreground is overlaid centered on the blurred background.
- If a caption is set, it's rendered separately (see below) and overlaid
  on top of that composite, before final encode.
- Output is encoded with `libx264` (preset `fast`, `crf 19`) and `aac`
  audio (`192k`).

## How captions work

Captions are built as an SVG (using
[opentype.js](https://github.com/opentypejs/opentype.js) to measure text
and word-wrap against the actual font), rasterized to a transparent PNG
with [@resvg/resvg-js](https://github.com/thx/resvg-js), and burned in as
one more ffmpeg overlay layer — all before the video is ever encoded.

The caption's vertical center is always placed exactly on the seam where
the sharp foreground clip meets the blurred background above it. That seam
position depends on the zoom level, so it's recalculated per-render from
the current zoom value (and the source clip's real dimensions).

**Font:** the app looks for **Proxima Nova Semibold (600)** installed as a
real system font first, since that's the actual font TikTok's Classic
caption style uses. It searches, in order: Adobe Fonts' sync cache on
macOS (`~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r`
— note the leading dot; Creative Cloud syncs activated fonts here under
obfuscated filenames like `.173.otf`, not into a normal Font Book
install), then `~/Library/Fonts`, `/Library/Fonts`, and
`/System/Library/Fonts`. Each candidate file's internal name table is
parsed with opentype.js to confirm it's genuinely "Proxima Nova" at weight
600 — filenames alone aren't trusted. If found, that exact file path is
used directly (never copied into the project, staying compliant with the
Adobe Fonts license: it's a reference to the user's own already-installed
copy). If not found anywhere, it falls back to **Montserrat SemiBold
(600)**, bundled at `fonts/Montserrat-SemiBold.ttf` under the SIL Open
Font License (`fonts/OFL.txt`), downloaded from Google Fonts. Either way,
the resolved font path (or the fallback) is logged once at server startup.

The two caption styles are two independent code paths: **Outline** (white
fill, black stroke) is the only place stroke/`paint-order` logic exists;
**Box** (black text on a white rounded bubble) has no stroke anywhere in
its code.

## Notes

- Jobs are tracked in memory only (this is a single-user local tool, no
  database). Restarting the server clears job history, but files already
  written to `outputs/` remain on disk.
- Downloaded clips, uploaded files, and rendered outputs are stored in
  `downloads/`, `uploads/`, and `outputs/` respectively. Caption PNGs are
  written to `captions/` as temp files and deleted right after each render.
- Not included yet (planned as separate features): trimming, intro/outro
  branding.
