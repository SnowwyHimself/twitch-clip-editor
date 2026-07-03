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

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

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
