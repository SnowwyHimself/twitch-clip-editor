# Clip Editor

A timeline-based editor for turning Twitch clips into TikTok/Reels/Shorts
posts — CapCut-style layout (preview center, properties panel right,
timeline bottom), scoped specifically to the paste-a-clip-link workflow:

- **Paste a Twitch clip URL (or a VOD URL + time range) and it loads
  straight into the timeline** — no manual download/import step
- **Trim/split/cut** on the video track; preview playback and the export
  both skip cut segments
- **Multiple text layers**, each with its own font/color/style/shadow and
  its own start/end timing on the timeline, draggable anywhere in the
  preview
- **Auto captions** via local whisper.cpp transcription (no cloud API, no
  account) — one editable text layer per caption block
- **Blur-background aspect conversion** (9:16, 1:1, 4:5, 4:3, 16:9): the
  clip is zoomed and centered, leftover space filled with a blurred copy
  of the same footage instead of black bars
- **Export** renders through ffmpeg with a real progress bar

## Prerequisites

Make sure these are installed and available on your `PATH`:

- **Node.js 18+**
- **ffmpeg** — does the video processing
- **yt-dlp** — downloads clips from pasted URLs
- **whisper-cpp** *(optional)* — powers Auto captions; everything else
  works without it

Check with:

```bash
node -v
ffmpeg -version
yt-dlp --version
```

On macOS with Homebrew: `brew install node ffmpeg yt-dlp whisper-cpp`

For Auto captions you also need the speech model (~148MB, downloaded once
into `models/`):

```bash
npm run fetch-whisper-model
```

The server looks for `whisper-cli` (or the older `whisper-cpp` name) on
`PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin`, and for
any `ggml-*.bin` model in `models/` (override with the `WHISPER_MODEL` env
var). If either piece is missing, the Auto captions button tells you
exactly which one — nothing else is affected.

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
site changes) via `scripts/fetch-binaries-mac.sh` / `-win.sh`. The mac
script also compiles `emoji-render` (see "How emoji work" below) from
source, which requires Xcode's command line tools (`swiftc`) to be
installed on the build machine — not needed by end users, only by
whoever runs `npm run dist:mac`.

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

1. **Load a clip**: paste a Twitch clip URL into the top bar — it starts
   loading the moment you paste (or press Enter / click **Load**). For a
   full VOD, open **VOD range** next to the field first and enter a
   start/end timestamp (`1:02:30` style) so only that slice is fetched
   (via yt-dlp's `--download-sections`, with frame-accurate cut points).
   **Open file** loads a video already on disk instead. Whatever gets
   fetched for a URL is cached and reused by the export, never downloaded
   twice.
2. **Trim on the timeline**: every piece of the clip on the video track
   has its own trim handles on both edges — drag them to shorten or
   extend that piece. Trims are non-destructive: an edge can always be
   dragged back out over trimmed/deleted footage, because pieces are just
   pointers into the untouched source. **✂ Split** cuts the piece under
   the playhead in two; click a piece to select it and hit **🗑 Delete**
   (or the Delete key). The **Snap** toggle (top-right of the toolbar)
   picks the editing style: on (CapCut, default) pieces always close up —
   deletes ripple and dropped pieces snap home; off (Premiere-style
   free-form) pieces can be dragged anywhere and deletes leave a gap that
   plays — and exports — as black. The pixel scale is pinned to the
   source length, so trimming never rescales the track under your cursor.
   **↩/↪ Undo/Redo** (or ⌘Z / ⇧⌘Z) cover every timeline and text edit.
   Preview playback skips cuts seamlessly. Scrub by dragging the ruler or
   the playhead.
3. **Add text**: click **+ Text** to drop a text layer at the playhead
   (3s long by default). Each layer is its own row on the timeline —
   drag the bar to move it in time, drag its edges to change duration,
   click it to select. With a layer selected, the right panel switches to
   **Text**: content (with emoji picker), style (**None**/**Outline**/
   **Box**), font, color, size, drop shadow, and exact start/end times.
   Drag the text in the preview to position it anywhere (snaps to center
   with guide lines); it stays clamped fully on-screen. Selected layers
   are visible in the preview even when the playhead is outside their
   time range, so you can style them without chasing the playhead.
4. **Auto captions**: click **Auto captions** in the timeline toolbar to
   open the **Captions** tab. Pick a mode — **Word by word** (each word
   appears exactly as it's spoken, TikTok-style; the default) or **Short
   lines** — and hit **Generate**: the clip's audio is transcribed
   locally with whisper.cpp (DTW token alignment for tight sync, plus
   **Voice Activity Detection** when the silero VAD model is present — it
   skips wind/background noise, which is the main cause of bad timing on
   noisy clips) and each block becomes a text layer on the timeline. A
   **Timing nudge** slider shifts every caption later (+) or earlier (−)
   if they're consistently off — whisper tends to run a touch early, so it
   defaults to +0.15s. The tab's style controls
   (style/font/color/size/shadow/vertical position) restyle **all**
   caption blocks at once, like CapCut's caption styling; select a single
   block to fine-tune it in the Text tab. Regenerating replaces the
   caption set but never touches hand-made text.
5. **Overlays and sounds**: **+ Overlay** and **+ Sound** in the timeline
   toolbar open their own panel tabs, each offering **your own file** or
   a **bundled preset** (whatever's in `assets/overlays/` and
   `assets/sfx/` — three starter sounds ship: Pop, Ding, Whoosh; presets
   added there show up for everyone). You can add **as many overlays and
   sounds as you like** — each is an independent clip on its row (Overlay
   / Sound) that you select, drag, edge-resize, **split** (with the piece
   selected), and delete, exactly like a text layer. Overlays (image or
   video) render above the video and drag anywhere in the preview; a
   **video** overlay plays/pauses in sync with the editor, and the Overlay
   tab has a **Crop** control (four edge sliders, images and videos).
   Sounds mix over the original audio (`adelay` + `amix`). Every clip
   type gets its own timeline row: Video, Overlay, Captions, Text, Sound.
6. **Transitions**: the **Transitions** toolbar button opens its tab —
   pick **White Flash** (dip to white), set a duration, put the playhead
   near a cut between two pieces, and **Add**. A ✦ badge marks the cut
   (click it, or ✕ in the tab's list, to remove). The preview flashes
   live; the export builds it from two ffmpeg white-fades around the
   boundary.
7. **Video settings** (right panel, **Video** tab — also shown whenever
   nothing is selected): **aspect ratio** (9:16 default), **zoom**
   (100–200%, how tightly the clip is cropped), **background blur**
   (0–100%; at 0% the leftover space is plain black), **Position X / Y**
   (move the main clip left/right and up/down over the background),
   **speed** (0.5x–2x; audio pitch stays natural), and **mirror**
   (flips the footage horizontally — text layers are never mirrored).
   Everything starts neutral (zoom 100%, no blur, no pan). Save up to
   **3 named presets** of these settings; ★ one and it auto-applies every
   time you load a clip, so imported clips land in your template.
8. **Export**: click **Export** in the top bar. A progress bar tracks the
   render (real ffmpeg progress, not a spinner); when it's done, preview
   the result inline and click **Download**.

Keyboard: **Space** plays/pauses, **Delete** removes whatever is selected
(a text layer or a video piece), **⌘Z / ⇧⌘Z** undo/redo.

## How the live preview works

Once a video source is loaded — a local file, or a clip fetched for the
URL tab — the live preview is pure CSS on two `<video>` elements playing
it, updated on every slider/toggle change with no server round-trip:

- **Aspect ratio**: the preview frame's pixel size is recomputed in JS
  whenever you pick a different ratio, fitting the real W:H into the
  available preview area — `fitPreviewFrame` in `public/js/preview.js` —
  rather than a single hardcoded `aspect-ratio: 9/16` in CSS.
  `GET /api/aspect-ratios` reports each option's id/label/width/height so
  the frontend never has to duplicate the pixel-dimension table server.js
  actually renders with.
- **Trim**: the preview only plays back kept segments — a `timeupdate`
  listener jumps over cut ranges and loops back to the first kept segment
  at the end — and dragging a trim handle scrubs the preview to that
  exact frame, both matching what the real export contains (see "How
  trimming works" below).
- **Zoom**: the foreground video uses `object-fit: contain`, which already
  letterboxes exactly like the real width-locked crop does at zoom 100%,
  then `transform: scale()` zooms in from there the same way the real crop
  grows with zoom.
- **Blur background**: a second copy of the same video with
  `object-fit: cover` (matches the real scale+crop "increase" background
  fill) and a CSS `blur()` filter approximating `gblur`. Hidden entirely at
  0% so the frame's own black background shows through, matching the real
  plain-letterboxing behavior.
- **Mirror**: folded into the foreground's `scale()` as a negative x
  factor, plus `scaleX(-1)` on the background.
- **Speed**: applied directly via the video elements' `playbackRate`.
- **Text layers**: each layer in the editor gets its own HTML/CSS overlay
  element, positioned with the same center-clamping formula server.js
  uses for the real render — the element's `offsetWidth`/`offsetHeight`
  (measured after font size is applied) stand in for the real render's
  PNG dimensions. Layers are draggable on both axes with center-snap
  guide lines, shown/hidden live as the playhead enters/leaves their time
  range (a selected layer stays visible so it can be styled without
  chasing the playhead). Font, outline `text-stroke`, and drop shadow all
  approximate the real SVG styling, using the same bundled font files
  (served at `/fonts` for `@font-face`). **Color** applies to the outline
  text fill directly; for the **box** style it's the pill background
  color instead, with the text switching to black or white for contrast
  (perceived-luminance formula `0.299r + 0.587g + 0.114b`, matching
  caption.js's server-side `getContrastTextColor` exactly so the preview
  and the real render never disagree on which one to use). The **box**
  style's pill backgrounds are built as plain positioned `<div>`s (in
  each layer's `.preview-caption-fillers`, behind the text) rather than
  CSS `box-decoration-break` — that approach applied full padding to
  every wrapped line independently, doubling the gap at each internal
  seam and making connected lines look like separate stacked pills.
  Building them from `Range.getClientRects()` (one rect per actual
  rendered line, after merging same-row fragments — wrapped text reports
  an extra near-zero-width rect for the collapsed trailing space at each
  wrap point, sharing the same row as the real line before it) instead
  means they touch exactly at internal seams just like the real render,
  only the first and last line getting the extra outer padding.

This is intentionally an approximation, not a preview of the exact output
pixels — exact stroke rendering, emoji compositing, and Proxima Nova/system
font fallback are all handled precisely by the real ffmpeg + resvg render,
not by this CSS preview.

**Getting the video into the preview** differs by source: **Open file**
uses `URL.createObjectURL` on the local file directly, no network
involved. A pasted URL has no local file to point a `<video>` at, so
loading it hits `POST /api/preview-source`, which downloads the clip with
yt-dlp into `preview-cache/` (keyed by a hash of the URL plus the VOD
range, if any — so re-loading, or loading then exporting, the same URL
never re-downloads it) and returns a `/preview-cache/...` URL the
`<video>` elements can load directly.

## How the conversion works

**Aspect ratio** picks the output canvas's pixel dimensions from a small
registry (`ASPECT_RATIOS` in `server.js`):

| Ratio | Dimensions | Orientation |
| --- | --- | --- |
| 9:16 (default) | 1080x1920 | portrait |
| 1:1 | 1080x1080 | square |
| 4:5 | 1080x1350 | portrait |
| 4:3 | 1440x1080 | landscape |
| 16:9 | 1920x1080 | landscape |

Every ratio's width:height literally matches its own numbers — the same
convention every major editor uses — so 4:3 and 16:9 render landscape
rather than being flipped into a portrait crop just because this tool's
main use case is vertical video. `GET /api/aspect-ratios` reports the
same table (id/label/width/height/isDefault) so the frontend never
duplicates it. The caption renderer's max text-wrap width scales
proportionally with the chosen canvas's width too, so switching ratios
keeps the same proportional side margins instead of a fixed pixel value
tuned only for the 1080-wide default.

Given a zoom value (e.g. 1.35) and the selected canvas's width/height
(`canvasW`/`canvasH`):

- **Background layer**: the source is scaled to cover `canvasW`x`canvasH`
  (`force_original_aspect_ratio=increase`), cropped to exactly that size,
  then blurred (`gblur=sigma=20`).
- **Foreground layer**: the source is scaled so its width is
  `canvasW * zoom` (aspect ratio preserved), then cropped back down to
  width `canvasW`, centered horizontally, full height — giving a
  uniformly zoomed-in crop of the clip.
- The foreground is overlaid centered on the blurred background.
- If a caption is set, it's rendered separately (see below) and overlaid
  on top of that composite, before final encode.
- Output is encoded with `libx264` (preset `fast`, `crf 19`) and `aac`
  audio (`192k`).

## How captions work

Each text layer is built as an SVG (using
[opentype.js](https://github.com/opentypejs/opentype.js) to measure text
and word-wrap against the actual font), rasterized to a transparent PNG
with [@resvg/resvg-js](https://github.com/thx/resvg-js), and burned in as
one more ffmpeg overlay stage — one PNG input per layer, stacked in layer
order on top of the (optional) media overlay, all before the video is
ever encoded.

The rendered PNG is cropped tightly to its own content on both axes
(rather than always spanning the full canvas width with the text centered
inside it), so it can be positioned anywhere via the ffmpeg overlay
filter's x/y. Every layer carries its own 0–100% center position on both
axes (set by dragging it in the preview), clamped so its full bounding
box always stays on-canvas: `center = contentSize/2 + (percent/100) *
(canvasSize - contentSize)` — 0% and 100% mean "flush against that edge,"
not "centered based on some fixed margin."

A layer's start/end timing becomes an
`enable='between(t,start,end)'` expression on its overlay stage. `t`
there is OUTPUT time — after cut segments are concatenated away and speed
is applied — so the frontend maps each layer's source-timeline times
across the cuts (and divides by speed) before submitting
(`mapToOutput` in `public/js/export.js`); a layer that fell entirely
inside cut footage is dropped from the request. Layers with no timing
span the whole video.

**Color:** a 9-swatch picker (white, yellow, orange, red, pink, purple,
blue, green, black) — `color` is validated server-side against a strict
`/^#[0-9a-f]{6}$/i` pattern before it's interpolated into the caption SVG
(`normalizeColor` in `server.js`), since it's user-controlled data going
straight into an SVG attribute; anything that doesn't match is rejected
and the default is used instead. For **Outline**, color sets the text
fill directly. For **Box**, color sets the pill background, and the text
switches to black or white automatically for contrast
(`getContrastTextColor` in `caption.js`, perceived-luminance formula
`0.299r + 0.587g + 0.114b`) — the same function (ported to JS) drives the
live preview's contrast choice too, so they can't disagree.

**Font:** the caption font dropdown offers nine options:

- **Proxima Nova** — the default whenever it's genuinely available, since
  it's the actual font TikTok's own captions use. A real system font,
  never bundled — the app searches, in order: Adobe Fonts' sync cache on
  macOS (`~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r`
  — note the leading dot; Creative Cloud syncs activated fonts here under
  obfuscated filenames like `.173.otf`, not into a normal Font Book
  install), then `~/Library/Fonts`, `/Library/Fonts`, and
  `/System/Library/Fonts`. Each candidate file's internal name table is
  parsed with opentype.js to confirm it's genuinely "Proxima Nova" at
  weight 600 — filenames alone aren't trusted. If it isn't found, the
  dropdown option is disabled/grayed out (never silently substituted for
  another font) and **Montserrat SemiBold** becomes the default instead —
  both the dropdown's pre-selected option and the server-side fallback
  when no font is specified follow this same "Proxima Nova if available,
  else Montserrat" rule (`resolveDefaultFontId`), so they can't disagree.
- **Montserrat SemiBold**, **Poppins ExtraBold**, **Archivo Black**,
  **Bebas Neue**, and **Anton** — bundled at `fonts/*.ttf`, all downloaded
  from Google Fonts under the SIL Open Font License (`fonts/OFL-*.txt`,
  one per family since each has its own copyright header). Bebas Neue and
  Anton are both free, bold condensed display faces in the same aesthetic
  family as Burbank Big Condensed below, for anyone who wants that look
  without needing a licensed copy of the real thing installed.
- **Manrope ExtraBold** — also bundled the same way. (Inter was tried
  first, since it's a common choice for this kind of bold caption font,
  but its font file trips an unrelated parser bug in opentype.js — a GSUB
  contextual-substitution format it doesn't implement — that breaks text
  measurement for almost any multi-character string. Manrope has no such
  issue and looks similar.)
- **Burbank Big Condensed** and **Burbank Big Condensed Bold** — real
  system fonts, same never-bundled treatment as Proxima Nova, since it's
  a commercially-licensed font (designer Tal Leming, associated with
  Fortnite's branding) with no legitimate open license, despite showing up
  on font-piracy-style "free download" sites. The two dropdown entries
  match on family name plus weight class/subfamily (`isBurbankBigCondensed`
  in `caption.js`) — Bold/Black-ish weights for the Bold entry, anything
  lighter for the plain one — searched across the same system font
  directories Proxima Nova uses. Grayed out unless a licensed copy is
  actually installed.

`GET /api/fonts` reports each option's id/label/availability/isDefault;
the frontend uses it to populate the dropdown, pre-select the right
default, and gray out unavailable system fonts live, per machine.

**Drop shadow:** an optional soft, down-and-right-offset shadow (SVG
`feDropShadow`, scaled relative to font size), CapCut-caption-style. For
Outline captions it's grouped per line so the whole line casts one shadow;
for Box captions it's applied to the box itself, not the text on top of
it — matching how CapCut's classic box caption only shadows the bubble.

The two caption styles are otherwise two independent code paths:
**Outline** (colored fill, black stroke) is the only place stroke/
`paint-order` logic exists; **Box** (contrast-colored text on a rounded
color bubble) has no stroke anywhere in its code. The fixed
15%-of-font-size outline thickness applies the same way regardless of
which font is selected.

**Box style** matches TikTok's real in-app box caption rather than a single
shared rectangle: each line gets its own rounded pill sized to that line's
own text width (not the widest line), stacked with a 1px overlap so a short
line under a long one reads as a visibly narrower, separately-rounded step
— the same connected/notched look TikTok's own caption tool produces.
This comes from rendering N independently-rounded `<rect>`s (one per line)
rather than one shared box or custom path math: at the seam between two
differently-sized rows, each row's own corner rounding naturally produces
the notch. The corner radius is a fixed fraction of a single line's own box
height (`BOX_RADIUS_RATIO`), not a fixed pixel value, so it stays a
consistent, proportionally-rounded shape at any caption size. See "How the
live preview works" above for how the browser-side version of this same
shape is built (plain positioned `<div>`s, not CSS
`box-decoration-break` — that was tried first and abandoned).

Rounding every row's corners unconditionally would also pinch the seam
between two lines that happen to be (nearly) the same width, even though
there's no real width change to justify a notch there — TikTok's own
captions show a flat, uninterrupted edge in that case. A small opaque
patch spanning any seam where two consecutive lines are within a few
pixels of the same width squares it back off; in the live preview this
uses `Range.getClientRects()` to measure each rendered line's actual width
(no need to duplicate word-wrap math client-side for this either).

## How trimming works

The video track models the clip as KEPT segments — like clips on a
CapCut/Premiere track — and the gaps between them (in source time) ARE
the cuts. Every segment has its own trim handles on both edges (clamped
so neighbors never overlap; dragging outward un-cuts that footage),
**Split** divides the segment under the playhead, and **Delete** removes
the selected segment entirely (`public/js/timeline.js`, segment model in
`public/js/state.js`).

The timeline and playback bar display OUTPUT time. Every piece carries an
explicit `outStart` — its position on the output timeline
(`sourceToOutput`/`outputToSource` in `state.js`). In **snap** mode
pieces are always packed end to end (`normalizeOutStarts`): deleting a
middle piece closes the rest up, trimming an edge ripples everything
after it, and a dragged piece floats while held then snaps home. In
**free** mode pieces keep whatever `outStart` they're dropped at; output
gaps play as black in the preview (a synthetic clock walks the playhead
across them) and render as black in the export (filler pieces derived
from the source via trim + drawbox blackout + muted audio — synthetic
color/anullsrc sources have mismatched frame rates/timebases and made
concat's encoder mass-duplicate frames). All state stays in source
seconds underneath; only the display and the export payload convert.
Text-layer bars are dragged in output coordinates too, so they stay glued
to the same footage however the track is cut. Undo/redo is snapshot
history over segments/transitions/layers (`state.js`), with immediate
records for discrete segment ops and debounced records for typing.

Dragging a handle scrubs the preview to that exact frame, and playback
skips cuts with a per-animation-frame watcher that seeks just before the
boundary renders (`targetTime` in `public/js/preview.js`) — 'timeupdate'
only fires a few times a second, which used to visibly play a beat of
deleted footage before jumping. Seeks are never stacked onto one still in
flight, and the blurred background copy uses `fastSeek` (keyframe
accuracy is plenty under that much blur).

Only the KEPT `[start,end]` ranges are sent to the backend (`segments`),
and only once a source's real duration is known; omitted entirely
otherwise, so the server's own "no trim" default applies rather than
sending a bogus range. Server-side (`buildSegments`/`runFfmpeg` in
`server.js`), a single kept range — the common case, just trimming the
two ends — uses fast, frame-accurate input-side `-ss`/`-t` (placed before
the main video's `-i`, so they only affect that input, not the text-layer
PNGs' separate `-i`s). Only when more than one kept range exists (a
middle piece was actually cut out) does the heavier per-range
trim + `setpts` reset + `concat` filter chain kick in. Since ffmpeg just
stops at end-of-file if a range asks past the end, a stale duration read
on the client never errors out.

## How auto captions work

`POST /api/transcribe` (see `transcribe.js`) extracts the clip's audio as
16kHz mono WAV with ffmpeg, runs it through a local **whisper.cpp**
binary, and returns `{start, end, text}` blocks in source-clip time. Two
modes: `words` (`--max-len 1` — one block per word, for the
word-at-a-time caption style) and `blocks` (`--max-len 28
--split-on-word` — short TikTok-caption-shaped lines). Both pass
`--dtw <model>` (derived from the model filename) so timestamps come from
whisper's DTW token alignment instead of its looser default heuristic —
that's what keeps word captions locked to the audio. The frontend turns
each block into a `group:'caption'` text layer; the Captions tab styles
the whole group at once (`applyCaptionStyle` in `state.js`) and
regeneration replaces only that group. For a URL source the
already-cached download is transcribed server-side; a local file is
uploaded for transcription. `GET /api/whisper-status` reports whether the
binary and model are present so the UI can explain what's missing instead
of failing a whole transcription.

## How emoji work

The caption text box has an emoji picker (a small curated grid of ~45
common emoji) that inserts the clicked emoji at the cursor position. Since
[@resvg/resvg-js](https://github.com/thx/resvg-js) (the SVG renderer the
rest of the caption pipeline uses) can't rasterize Apple Color Emoji's
color-bitmap glyphs at all — it silently renders nothing, no error — emoji
are rendered completely separately from the text and composited into the
caption SVG as `<image>` elements, with the source PNG chosen per OS at
render time:

- **macOS**: a tiny bundled Swift/AppKit command-line tool
  (`native/emoji-render-mac/`, compiled at build time — see the desktop
  app section above) rasterizes the real system "Apple Color Emoji" font
  directly, the same way real Apple emoji looks everywhere else on the
  Mac. Renders are cached to disk (`emoji-cache/`) so the tool only runs
  once per distinct emoji. Apple's font/graphics are never bundled or
  copied anywhere in this project — only referenced by name on a machine
  that already has them.
- **Any other OS** (or if the mac path fails for any reason): falls back
  to bundled [Twemoji](https://github.com/jdecked/twemoji) PNGs
  (`assets/emoji/twemoji/`), Twitter's open-source emoji set — code MIT
  licensed, graphics CC-BY 4.0 (attribution notice in
  `assets/emoji/twemoji/NOTICE.md`).

This is fully automatic and per-machine — a Mac user gets real Apple
emoji, a Windows user gets Twemoji, with no manual switching.

## Notes

- Jobs are tracked in memory only (this is a single-user local tool, no
  database). Restarting the server clears job history, but files already
  written to `outputs/` remain on disk.
- Downloaded clips, uploaded files, and rendered outputs are stored in
  `downloads/`, `uploads/`, and `outputs/` respectively. Text-layer PNGs
  are written to `captions/` as temp files and deleted right after each
  render; `transcribe-cache/` similarly holds each transcription's
  short-lived WAV/JSON intermediates. `models/` holds the downloaded
  whisper model (see Prerequisites).
  `emoji-cache/` (macOS only) persists rendered Apple emoji PNGs across
  renders/restarts as a performance cache — safe to delete anytime, it's
  regenerated on demand. `preview-cache/` similarly persists clips fetched
  for the Clip URL tab's live preview, safe to delete anytime — it just
  means the next preview (or Generate) for that URL re-downloads it.
- Not included yet (planned as a separate feature): intro/outro branding.
