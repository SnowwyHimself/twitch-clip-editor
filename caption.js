const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');

const FONT_SIZE = 64; // default/fallback when no per-request fontSize is given
const DEFAULT_CANVAS_W = 1080;
const MAX_TEXT_WIDTH_RATIO = 900 / DEFAULT_CANVAS_W; // fixed regardless of fontSize — leaves ~90px margin on each side at the 1080-wide canvas this ratio was tuned against; smaller text wraps less often within this same width rather than the boundary shrinking with it
const OUTER_PADDING = 10; // safety margin so stroke/antialiasing never clips at image edges
const BOX_PADDING_X = 34;
const BOX_PADDING_Y = 18;
const BOX_RADIUS_RATIO = 0.22; // fraction of the box's own height — matches TikTok's generously-rounded (not fixed-px) corner look
const OUTLINE_THICKNESS = 15; // percentage of font size — 9.6px at FONT_SIZE=64, matches TikTok's ~8-10px look
const FONT_FAMILY = 'Caption Font'; // alias used inside generated SVGs, decoupled from whichever real font file backs it
const EMOJI_SIZE_RATIO = 0.85; // emoji glyphs render slightly smaller than the font's own cell

const DATA_ROOT = process.env.CLIP_EDITOR_DATA_DIR || __dirname;
const EMOJI_CACHE_DIR = path.join(DATA_ROOT, 'emoji-cache');
const FONT_CACHE_DIR = path.join(DATA_ROOT, 'font-cache');

// resvg loads font files with its OWN (Rust) file reader, which — unlike Node's
// `fs` — cannot see inside Electron's `app.asar`. In a packaged build the bundled
// fonts live in app.asar, so resvg silently loads zero glyphs while the caption
// BOX still renders (the box is sized by the opentype measurement pass, which
// reads via asar-aware Node fs) — the classic "blank box, no text" export bug.
// Mirror the font out to a real, writable dir (read via Node fs, write to
// userData) and give resvg that path. Only needed for asar paths, so dev/source
// runs use the original path untouched. Cached per source path.
const realFontPaths = new Map();
function realFontPath(fontPath) {
  if (!fontPath.includes('app.asar')) return fontPath; // dev / already on real fs
  if (realFontPaths.has(fontPath)) return realFontPaths.get(fontPath);
  let usable = fontPath;
  try {
    const dest = path.join(FONT_CACHE_DIR, path.basename(fontPath));
    let sameSize = false;
    try {
      sameSize = fs.statSync(dest).size === fs.statSync(fontPath).size;
    } catch {
      /* dest missing -> copy */
    }
    if (!sameSize) {
      fs.mkdirSync(FONT_CACHE_DIR, { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(fontPath)); // readFileSync is asar-aware
    }
    usable = dest;
  } catch {
    usable = fontPath; // extraction failed -> no worse than before
  }
  realFontPaths.set(fontPath, usable);
  return usable;
}
const TWEMOJI_DIR = path.join(__dirname, 'assets', 'emoji', 'twemoji');

// Bundled fonts, all free/open-licensed (SIL OFL or Apache) and downloaded
// from Google Fonts — see fonts/OFL-<name>.txt / fonts/LICENSE-<name>.txt for
// each one's license text. Every font here ships inside the app, so there's
// nothing for the user to install and nothing that can show up as "not
// installed". The list leans toward the fonts most used for clipping /
// short-form video captions (bold, condensed, and meme/impact styles).
const bundledFont = (label, file) => ({ label, path: path.join(__dirname, 'fonts', file) });
const FONT_REGISTRY = {
  montserrat: bundledFont('Montserrat SemiBold', 'Montserrat-SemiBold.ttf'),
  poppins: bundledFont('Poppins ExtraBold', 'Poppins-ExtraBold.ttf'),
  manrope: bundledFont('Manrope ExtraBold', 'Manrope-ExtraBold.ttf'),
  'archivo-black': bundledFont('Archivo Black', 'ArchivoBlack-Regular.ttf'),
  anton: bundledFont('Anton', 'Anton-Regular.ttf'),
  'bebas-neue': bundledFont('Bebas Neue', 'BebasNeue-Regular.ttf'),
  'fjalla-one': bundledFont('Fjalla One', 'FjallaOne-Regular.ttf'),
  kanit: bundledFont('Kanit Bold', 'Kanit-Bold.ttf'),
  'alfa-slab-one': bundledFont('Alfa Slab One', 'AlfaSlabOne-Regular.ttf'),
  'titan-one': bundledFont('Titan One', 'TitanOne-Regular.ttf'),
  'paytone-one': bundledFont('Paytone One', 'PaytoneOne-Regular.ttf'),
  righteous: bundledFont('Righteous', 'Righteous-Regular.ttf'),
  bangers: bundledFont('Bangers', 'Bangers-Regular.ttf'),
  'luckiest-guy': bundledFont('Luckiest Guy', 'LuckiestGuy-Regular.ttf'),
};
const DEFAULT_FONT_ID = 'montserrat';

// Where an installed commercial font (Proxima Nova, Burbank Big Condensed)
// could actually live on this machine. Checked in this order: Adobe Fonts'
// sync cache first (Creative Cloud activates fonts into CoreSync's
// livetype cache under a *hidden* ".r" directory with obfuscated filenames
// like ".173.otf" — not a normal Font Book install, and easy to miss if you
// search for "r" instead of ".r"), then the standard macOS font directories
// (where a manually-installed .otf/.ttf, e.g. a licensed Burbank Big
// Condensed file, would normally end up).
const SYSTEM_FONT_SEARCH_DIRS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', '.r'),
  path.join(os.homedir(), 'Library', 'Fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts',
];

function listFontFilesRecursive(dir, depth) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listFontFilesRecursive(fullPath, depth - 1));
    } else if (/\.(ttf|otf)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

// opentype.js nests name-table records per platform (font.names.windows.*,
// font.names.macintosh.*) rather than exposing them flat on font.names —
// reading font.names.fontFamily directly (as an earlier version of this
// file did) silently returns undefined for every font, which made this
// check always fail regardless of whether the right file was found.
function getNameRecord(font, field) {
  const platforms = ['windows', 'macintosh'];
  for (const platform of platforms) {
    const table = font.names[platform];
    if (table && table[field] && table[field].en) {
      return table[field].en;
    }
  }
  return '';
}

function isProximaNovaSemibold(font) {
  const family = getNameRecord(font, 'fontFamily').toLowerCase();
  const subfamily = getNameRecord(font, 'fontSubfamily').toLowerCase();
  const fullName = getNameRecord(font, 'fullName').toLowerCase();
  const preferredFamily = getNameRecord(font, 'preferredFamily').toLowerCase();
  const preferredSubfamily = getNameRecord(font, 'preferredSubfamily').toLowerCase();
  const weightClass = font.tables.os2 && font.tables.os2.usWeightClass;

  const nameMatches =
    family.includes('proxima nova') || fullName.includes('proxima nova') || preferredFamily.includes('proxima nova');
  const weightMatches =
    weightClass === 600 ||
    subfamily.includes('semibold') ||
    subfamily.includes('semi bold') ||
    subfamily.includes('demibold') ||
    fullName.includes('semibold') ||
    fullName.includes('semi bold') ||
    preferredSubfamily.includes('semibold');

  return nameMatches && weightMatches;
}

// Burbank Big Condensed ships (when licensed and installed) with several
// weights — Black/Bold for the heavy look, Medium/Regular for the lighter
// one. Real weight naming varies by where the user's copy came from, so
// this matches loosely: "bold" wants Black/Bold-ish subfamilies (weight
// class >= 700), "normal" wants anything that isn't one of those.
function isBurbankBigCondensed(wantBold) {
  return function matchBurbank(font) {
    const family = getNameRecord(font, 'fontFamily').toLowerCase();
    const subfamily = getNameRecord(font, 'fontSubfamily').toLowerCase();
    const fullName = getNameRecord(font, 'fullName').toLowerCase();
    const preferredFamily = getNameRecord(font, 'preferredFamily').toLowerCase();
    const weightClass = font.tables.os2 && font.tables.os2.usWeightClass;

    const nameMatches =
      family.includes('burbank big condensed') ||
      fullName.includes('burbank big condensed') ||
      preferredFamily.includes('burbank big condensed');
    if (!nameMatches) return false;

    const isHeavy = weightClass >= 700 || subfamily.includes('black') || subfamily.includes('bold');
    return wantBold ? isHeavy : !isHeavy;
  };
}

// Positively confirms a system font FILE exists on disk before trusting it
// — resvg-js's loadSystemFonts option can't report whether a family name
// actually resolved (verified empirically: asking for a nonexistent font
// name renders byte-identical output to asking for a real family that
// isn't installed), so a real file is required both to prove availability
// and to let opentype.js measure text against it.
function findSystemFontFile(matchFn) {
  for (const dir of SYSTEM_FONT_SEARCH_DIRS) {
    const candidates = listFontFilesRecursive(dir, 2);
    for (const candidate of candidates) {
      try {
        const buf = fs.readFileSync(candidate);
        const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        if (matchFn(font)) {
          return candidate;
        }
      } catch {
        // Not a font opentype.js can parse (e.g. a .ttc collection) — skip it.
      }
    }
  }
  return null;
}

// Filesystem scan happens at most once per system-font entry per server
// run — cached the first time either the boot-log path or the font-registry
// availability check (getFontOptions) asks for it, whichever comes first.
const systemFontPathCache = new Map(); // fontId -> resolved path, or null if not found
function getSystemFontPath(fontId) {
  if (!systemFontPathCache.has(fontId)) {
    systemFontPathCache.set(fontId, findSystemFontFile(FONT_REGISTRY[fontId].match));
  }
  return systemFontPathCache.get(fontId);
}

// Kept only for the one-line boot log in server.js — actual per-render font
// choice now goes through resolveFontEntry() below, driven by the caption
// font dropdown. Every font is bundled, so this is always the default file.
let resolvedFontPath = null;
function resolveFontPath() {
  if (resolvedFontPath) return resolvedFontPath;
  resolvedFontPath = FONT_REGISTRY[DEFAULT_FONT_ID].path;
  console.log(`[caption] Default caption font: ${FONT_REGISTRY[DEFAULT_FONT_ID].label} (bundled).`);
  return resolvedFontPath;
}

// All fonts are bundled now, so the default is simply DEFAULT_FONT_ID.
function resolveDefaultFontId() {
  return DEFAULT_FONT_ID;
}

// Reports every selectable caption font. They're all bundled with the app,
// so every one is always usable (available: true) — nothing to gray out as
// "not installed" anymore.
function getFontOptions() {
  const defaultId = resolveDefaultFontId();
  return Object.entries(FONT_REGISTRY).map(([id, entry]) => ({
    id,
    label: entry.label,
    available: true,
    isDefault: id === defaultId,
  }));
}

// Personal-library font resolution. A library font id is `lib:<uuid>`; look it
// up in the library index and return its stored file. Returns null when the id
// isn't a library font, or when the entry/file is gone — the caller then falls
// back to the default bundled font, so a deleted library font never crashes an
// export (graceful "missing asset"). storedName is a server-generated leaf, but
// we reject any separator defensively before joining.
const LIBRARY_FONTS_DIR = path.join(DATA_ROOT, 'library', 'fonts');
const LIBRARY_INDEX_FILE = path.join(DATA_ROOT, 'library', 'library.json');
function resolveLibraryFontPath(fontId) {
  if (typeof fontId !== 'string' || !fontId.startsWith('lib:')) return null;
  const id = fontId.slice(4);
  try {
    const idx = JSON.parse(fs.readFileSync(LIBRARY_INDEX_FILE, 'utf8'));
    const it = (idx.items || []).find((x) => x.id === id && x.category === 'fonts');
    if (!it || !it.storedName || /[\\/]/.test(it.storedName)) return null;
    const p = path.join(LIBRARY_FONTS_DIR, it.storedName);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function resolveFontEntry(fontId) {
  const libPath = resolveLibraryFontPath(fontId);
  if (libPath) return { id: fontId, path: libPath };
  const id = FONT_REGISTRY[fontId] ? fontId : resolveDefaultFontId();
  return { id, path: FONT_REGISTRY[id].path };
}

const fontCache = new Map(); // resolved file path -> parsed opentype Font
function loadFontFromPath(fontPath) {
  if (!fontCache.has(fontPath)) {
    const buf = fs.readFileSync(fontPath);
    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    fontCache.set(fontPath, font);
  }
  return fontCache.get(fontPath);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// letterSpacingPx (D1) adds after every character, matching CSS letter-spacing
// (preview) and the SVG letter-spacing attribute — so wrap widths agree.
function measureWidth(font, text, fontSize, letterSpacingPx = 0) {
  const ls = letterSpacingPx ? letterSpacingPx * [...text].length : 0;
  try {
    return font.getAdvanceWidth(text, fontSize) + ls;
  } catch (err) {
    // Some display fonts (e.g. Bangers, Paytone One) carry GSUB tables
    // opentype.js can't apply and throw while shaping. This width only feeds
    // wrap/positioning math — the actual glyph rendering is done by resvg
    // straight from the TTF — so fall back to summing per-glyph advance
    // widths (cmap lookup only, no shaping), which never throws.
    const scale = fontSize / font.unitsPerEm;
    let width = 0;
    for (const ch of text) {
      const glyph = font.charToGlyph(ch);
      width += (glyph.advanceWidth || 0) * scale;
    }
    return width + ls;
  }
}

// Matches a single emoji character (optionally followed by the U+FE0F
// "emoji presentation" variation selector). Deliberately does not attempt
// multi-codepoint ZWJ sequences (families, flags, skin-tone modifiers) —
// out of scope for a simple curated emoji picker.
const EMOJI_REGEX = /\p{Extended_Pictographic}️?/gu;

function tokenizeSegments(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'emoji', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

// Lays a line out as a sequence of text/emoji segments with cumulative x
// offsets, so emoji can sit inline with text instead of only being
// appendable as a whole separate element. Reused for both wrap-width
// measurement and actual SVG positioning, so the two never disagree.
// A small gap is added on each side of an emoji token — without it, emoji
// glyphs (which have no side bearing of their own, unlike text glyphs) sit
// visibly tighter against neighboring text than word-spacing elsewhere.
function layoutLineSegments(font, line, fontSize, emojiSize, letterSpacingPx = 0) {
  const emojiGap = fontSize * 0.08;
  const tokens = tokenizeSegments(line);
  let x = 0;
  const segments = tokens.map((seg, i) => {
    if (seg.type === 'emoji') {
      if (i > 0) x += emojiGap;
      const item = { ...seg, x, width: emojiSize };
      x += emojiSize;
      if (i < tokens.length - 1) x += emojiGap;
      return item;
    }
    const width = measureWidth(font, seg.value, fontSize, letterSpacingPx);
    const item = { ...seg, x, width };
    x += width;
    return item;
  });
  return { segments, totalWidth: x };
}

function measureLineWidth(font, line, fontSize, emojiSize, letterSpacingPx = 0) {
  return layoutLineSegments(font, line, fontSize, emojiSize, letterSpacingPx).totalWidth;
}

// Splits on explicit newlines first (preserves the user's manual line breaks),
// then greedily word-wraps each of those lines to fit maxWidth.
function wrapText(font, text, fontSize, maxWidth, emojiSize, letterSpacingPx = 0) {
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let currentLine = '';
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (currentLine && measureLineWidth(font, candidate, fontSize, emojiSize, letterSpacingPx) > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

// Picks black or white text for whatever's laid on top of a given hex
// color, using perceived-brightness (standard luma weights) rather than
// plain average — so e.g. pure yellow (bright) still gets black text
// while pure blue (dark-reading despite full saturation) gets white.
function getContrastTextColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? '#000000' : '#ffffff';
}

// Soft, down-and-right offset shadow (CapCut-style). Scaled relative to
// fontSize rather than fixed pixels so it stays proportional if FONT_SIZE
// ever changes.
function buildDropShadowFilterDef(fontSize, dist = 0.07, blur = 0.05, opacity = 0.4) {
  const dx = (fontSize * dist * 0.7).toFixed(2);
  const dy = (fontSize * dist).toFixed(2);
  const b = (fontSize * blur).toFixed(2);
  return `<defs><filter id="dropshadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${b}" flood-color="black" flood-opacity="${opacity}"/></filter></defs>`;
}

// Wraps SVG body in a rotate-about-centre group, growing the canvas to the
// rotated bounding box so nothing clips. The overlay still centres the PNG, and
// the preview rotates the element about its own centre — so they match (D1).
function wrapRotation(body, width, height, rotationDeg) {
  const deg = Number(rotationDeg) || 0;
  if (!deg) return { body, width, height };
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const nw = Math.ceil(width * Math.cos(rad) + height * Math.sin(rad));
  const nh = Math.ceil(width * Math.sin(rad) + height * Math.cos(rad));
  const wrapped = `<g transform="rotate(${deg} ${(nw / 2).toFixed(2)} ${(nh / 2).toFixed(2)})"><g transform="translate(${((nw - width) / 2).toFixed(2)} ${((nh - height) / 2).toFixed(2)})">${body}</g></g>`;
  return { body: wrapped, width: nw, height: nh };
}

// Outline style: white fill, black stroke. This is the ONLY function in the
// module that touches stroke/paint-order — buildBoxSvg below never calls it
// and has no stroke logic of its own, so the two styles can't bleed into
// each other.
// Shared by both the Outline and (strokeless) Plain caption styles — they
// differ only in whether a black stroke is drawn around the text at all,
// so a single builder with stroke=false covers "Plain" instead of
// duplicating the whole line-layout/drop-shadow-grouping logic.
function buildOutlineSvg({ lines, font, fontSize, emojiSize, dropShadow, color, strokePct = OUTLINE_THICKNESS, strokeColor = 'black', opacity = 1, karaoke = false, emphasizeWordIndex = -1, karaokeColor = '#ffe600', letterSpacingPx = 0, lineHeightMult = 1, shadowDist = 0.07, shadowBlur = 0.05, shadowOpacity = 0.4, rotation = 0 }) {
  const textColor = color || '#ffffff';
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = (ascenderPx + descenderPx) * lineHeightMult;
  const textBlockHeight = lineHeight * lines.length;
  const strokeWidth = fontSize * (Math.max(0, strokePct) / 100);
  const stroke = strokeWidth > 0;
  const lsAttr = letterSpacingPx ? ` letter-spacing="${letterSpacingPx.toFixed(2)}"` : '';

  // Cropped tightly to the widest line (plus stroke/safety margin) rather
  // than always spanning the full canvas width — this is what lets the
  // server position the caption anywhere horizontally via the ffmpeg
  // overlay's x, the same way it already does vertically with height.
  const maxLineWidth = Math.max(...lines.map((line) => measureLineWidth(font, line, fontSize, emojiSize, letterSpacingPx)));
  const width = Math.ceil(maxLineWidth + strokeWidth + OUTER_PADDING * 2);
  const height = Math.ceil(textBlockHeight + OUTER_PADDING * 2);
  const textTop = OUTER_PADDING;

  const strokeAttrs = stroke
    ? ` stroke="${strokeColor}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" style="paint-order:stroke"`
    : '';
  const textEl = (x, y, fill, value) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="${fill}"${strokeAttrs}${lsAttr} text-anchor="start">${escapeXml(value)}</text>`;
  let elements = dropShadow ? buildDropShadowFilterDef(fontSize, shadowDist, shadowBlur, shadowOpacity) : '';
  let wordCounter = 0; // global word index across lines (karaoke)
  lines.forEach((line, i) => {
    const baselineY = textTop + i * lineHeight + ascenderPx;
    const lineTop = textTop + i * lineHeight;
    const { segments, totalWidth } = layoutLineSegments(font, line, fontSize, emojiSize, letterSpacingPx);
    const startX = width / 2 - totalWidth / 2;

    let lineContent = '';
    segments.forEach((seg) => {
      const segX = startX + seg.x;
      if (seg.type === 'emoji') {
        const emojiBase64 = getEmojiPngBase64(seg.value);
        if (emojiBase64) {
          const emojiY = lineTop + (lineHeight - emojiSize) / 2;
          lineContent += `<image x="${segX.toFixed(2)}" y="${emojiY.toFixed(2)}" width="${emojiSize}" height="${emojiSize}" href="data:image/png;base64,${emojiBase64}"/>`;
        }
      } else if (seg.value) {
        if (karaoke) {
          // Render word-by-word so the spoken word can take karaokeColor while
          // every other word (and the layout) stays identical to the base PNG.
          const parts = seg.value.split(' ');
          let wx = segX;
          parts.forEach((word, k) => {
            if (word) {
              const fill = wordCounter === emphasizeWordIndex ? karaokeColor : textColor;
              lineContent += textEl(wx, baselineY, fill, word);
              wx += measureWidth(font, word, fontSize, letterSpacingPx);
              wordCounter += 1;
            }
            if (k < parts.length - 1) wx += measureWidth(font, ' ', fontSize, letterSpacingPx);
          });
        } else {
          lineContent += textEl(segX, baselineY, textColor, seg.value);
        }
      }
    });

    elements += dropShadow ? `<g filter="url(#dropshadow)">${lineContent}</g>` : lineContent;
  });

  const inner = opacity < 1 ? `<g opacity="${opacity.toFixed(3)}">${elements}</g>` : elements;
  const r = wrapRotation(inner, width, height, rotation);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}">${r.body}</svg>`;
  return { svg, width: r.width, height: r.height };
}

// Box style: solid black fill text on a white rounded box. No stroke
// attributes appear anywhere in this function. The drop shadow (when on)
// sits under the box itself, not the text — matching how CapCut's classic
// box caption casts one shadow for the whole bubble.
// Box style: text on a single rounded box sized to the widest line and
// centered, so every line shares one continuous bubble. (An earlier version
// drew a separate per-line pill for each row; lines of different widths then
// left a visible gap between them — a short line floated in its own detached
// bubble under a long one — which read as broken. One shared box removes any
// seam.) The drop shadow (when on) sits under the box, not the text.
function buildBoxSvg({ lines, font, fontSize, emojiSize, dropShadow, color, opacity = 1, bgOpacity = 1, bgPadding = 1, bgRadius = 1, letterSpacingPx = 0, lineHeightMult = 1, shadowDist = 0.07, shadowBlur = 0.05, shadowOpacity = 0.4, rotation = 0 }) {
  const boxColor = color || '#ffffff';
  const textColor = getContrastTextColor(boxColor);
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = (ascenderPx + descenderPx) * lineHeightMult;
  const padX = BOX_PADDING_X * bgPadding;
  const padY = BOX_PADDING_Y * bgPadding;
  const lsAttr = letterSpacingPx ? ` letter-spacing="${letterSpacingPx.toFixed(2)}"` : '';
  const lineWidths = lines.map((line) => measureLineWidth(font, line, fontSize, emojiSize, letterSpacingPx));

  const boxY = OUTER_PADDING;
  const lineCount = lines.length;

  // A single consistent radius for every row (derived from what a lone
  // single-line box's height would be), rather than each row's own actual
  // height — keeps corners visually uniform across the whole stack even
  // though first/last rows are taller (they carry the outer padding).
  const singleLineBoxHeight = lineHeight + padY * 2;
  const boxRadius = singleLineBoxHeight * BOX_RADIUS_RATIO * bgRadius;

  const rectWidths = lineWidths.map((w) => w + padX * 2);
  // Cropped tightly to the widest row (plus safety margin) rather than
  // always spanning the full canvas width — lets the server position the
  // caption anywhere horizontally via the ffmpeg overlay's x, the same way
  // it already does vertically with height.
  const width = Math.ceil(Math.max(...rectWidths) + OUTER_PADDING * 2);

  let rowTop = boxY;
  const rows = lines.map((line, i) => {
    const topPad = i === 0 ? padY : 0;
    const bottomPad = i === lineCount - 1 ? padY : 0;
    const top = rowTop;
    const bottom = top + topPad + lineHeight + bottomPad;
    rowTop = bottom;
    const rectWidth = rectWidths[i];
    return { top, bottom, textTop: top + topPad, rectX: width / 2 - rectWidth / 2, rectWidth };
  });

  const height = Math.ceil(rows[lineCount - 1].bottom + OUTER_PADDING);

  // One unified rounded box wrapping the whole stack, sized to the widest
  // row, rather than a per-line pill for each row. Per-line pills left a
  // visible gap/step between lines of different widths (a short line under a
  // long one floated in its own separate bubble); a single box reads as one
  // solid caption bubble with no seams to break — matching the live preview.
  const boxWidth = Math.max(...rectWidths);
  const boxX = width / 2 - boxWidth / 2;
  const boxTop = rows[0].top;
  const boxHeight = rows[lineCount - 1].bottom - boxTop;
  const bgOpAttr = bgOpacity < 1 ? ` fill-opacity="${bgOpacity.toFixed(3)}"` : '';
  const boxRects = `<rect x="${boxX.toFixed(2)}" y="${boxTop.toFixed(2)}" width="${boxWidth.toFixed(2)}" height="${boxHeight.toFixed(2)}" rx="${boxRadius.toFixed(2)}" ry="${boxRadius.toFixed(2)}" fill="${boxColor}"${bgOpAttr}/>`;

  let elements = dropShadow ? buildDropShadowFilterDef(fontSize, shadowDist, shadowBlur, shadowOpacity) : '';
  // Grouped under one filter so the connected stack casts a single unified
  // shadow instead of each row casting (and overlapping) its own.
  elements += dropShadow ? `<g filter="url(#dropshadow)">${boxRects}</g>` : boxRects;

  lines.forEach((line, i) => {
    const row = rows[i];
    const baselineY = row.textTop + ascenderPx;
    const { segments, totalWidth } = layoutLineSegments(font, line, fontSize, emojiSize, letterSpacingPx);
    const startX = width / 2 - totalWidth / 2;

    segments.forEach((seg) => {
      const segX = startX + seg.x;
      if (seg.type === 'emoji') {
        const emojiBase64 = getEmojiPngBase64(seg.value);
        if (emojiBase64) {
          const emojiY = row.textTop + (lineHeight - emojiSize) / 2;
          elements += `<image x="${segX.toFixed(2)}" y="${emojiY.toFixed(2)}" width="${emojiSize}" height="${emojiSize}" href="data:image/png;base64,${emojiBase64}"/>`;
        }
      } else if (seg.value) {
        elements += `<text x="${segX.toFixed(2)}" y="${baselineY.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="${textColor}"${lsAttr} text-anchor="start">${escapeXml(seg.value)}</text>`;
      }
    });
  });

  const inner = opacity < 1 ? `<g opacity="${opacity.toFixed(3)}">${elements}</g>` : elements;
  const r = wrapRotation(inner, width, height, rotation);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="0 0 ${r.width} ${r.height}">${r.body}</svg>`;
  return { svg, width: r.width, height: r.height };
}

// --- Emoji rendering ---------------------------------------------------
//
// resvg (the SVG renderer used for the rest of the caption pipeline) can't
// rasterize Apple Color Emoji's sbix color-bitmap glyphs at all — it
// silently produces a blank image, no error. So emoji are rendered
// completely separately from the text, as PNGs composited into the SVG via
// <image href="data:image/png;base64,...">:
//
//   - macOS: a tiny bundled Swift/AppKit CLI (native/emoji-render-mac)
//     rasterizes the real system "Apple Color Emoji" font directly — never
//     bundled/copied anywhere, since Apple's font/graphics aren't
//     redistributable. Output is cached to disk so the binary is only
//     spawned once per distinct emoji.
//   - Any other platform (or if the mac path fails for any reason): falls
//     back to bundled Twemoji PNGs (assets/emoji/twemoji/), Twitter's
//     open-source emoji set (CC-BY 4.0 — see assets/emoji/twemoji/NOTICE.md).

function twemojiCodepointHex(emojiChar) {
  const codepoints = Array.from(emojiChar).map((c) => c.codePointAt(0));
  // Twemoji filenames omit the trailing U+FE0F variation selector even
  // though the source emoji character legitimately includes it.
  if (codepoints.length > 1 && codepoints[codepoints.length - 1] === 0xfe0f) {
    codepoints.pop();
  }
  return codepoints.map((cp) => cp.toString(16)).join('-');
}

function resolveTwemojiPngPath(emojiChar) {
  const candidate = path.join(TWEMOJI_DIR, `${twemojiCodepointHex(emojiChar)}.png`);
  return fs.existsSync(candidate) ? candidate : null;
}

let emojiRenderBinaryPath; // undefined = not checked yet, null = checked, not found
function resolveEmojiRenderBinary() {
  if (emojiRenderBinaryPath !== undefined) return emojiRenderBinaryPath;
  const resourcesDir = process.env.CLIP_EDITOR_RESOURCES;
  if (resourcesDir) {
    const packaged = path.join(resourcesDir, 'bin', 'emoji-render');
    if (fs.existsSync(packaged)) {
      emojiRenderBinaryPath = packaged;
      return emojiRenderBinaryPath;
    }
  }
  const devBuild = path.join(__dirname, 'native', 'emoji-render-mac', 'emoji-render');
  emojiRenderBinaryPath = fs.existsSync(devBuild) ? devBuild : null;
  return emojiRenderBinaryPath;
}

// Renders (or reuses a cached render of) the real Apple Color Emoji glyph
// via the native helper. Returns null on any failure so the caller can
// fall back to Twemoji instead of breaking the whole caption render.
function renderAppleEmojiBase64(emojiChar) {
  try {
    const bin = resolveEmojiRenderBinary();
    if (!bin) return null;
    const cachePath = path.join(EMOJI_CACHE_DIR, `${twemojiCodepointHex(emojiChar)}.png`);
    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(EMOJI_CACHE_DIR, { recursive: true });
      execFileSync(bin, [emojiChar, cachePath, '128']);
    }
    return fs.readFileSync(cachePath).toString('base64');
  } catch (err) {
    console.log(`[caption] Apple emoji render failed for "${emojiChar}", falling back to Twemoji: ${err.message}`);
    return null;
  }
}

const emojiPngCache = new Map(); // emoji char -> base64 string, or null if unresolvable anywhere
function getEmojiPngBase64(emojiChar) {
  if (emojiPngCache.has(emojiChar)) return emojiPngCache.get(emojiChar);

  let result = process.platform === 'darwin' ? renderAppleEmojiBase64(emojiChar) : null;
  if (!result) {
    const twemojiPath = resolveTwemojiPngPath(emojiChar);
    if (twemojiPath) {
      result = fs.readFileSync(twemojiPath).toString('base64');
    } else {
      console.log(`[caption] No emoji asset available for "${emojiChar}" — skipping it in the caption.`);
      result = null;
    }
  }
  emojiPngCache.set(emojiChar, result);
  return result;
}

// Renders caption text to a transparent PNG cropped tightly to its own
// content (both dimensions) — the caller positions that image anywhere on
// the canvas via the ffmpeg overlay's x/y, rather than this always
// producing a full-canvas-width image with internally-centered content.
// fontSize is user-adjustable (a caption "size" control); the max text
// width is deliberately NOT scaled with it, so a smaller font just wraps
// less often within the same fixed on-screen width instead of the wrap
// boundary shrinking along with the text. It IS scaled with canvasWidth
// (defaulting to the original 1080px canvas this was tuned against) so
// switching aspect ratios keeps the same proportional side margins.
function renderCaptionPng({
  text,
  style,
  fontId,
  dropShadow,
  fontSize,
  color,
  canvasWidth,
  wrapWidth,
  strokeWidth,
  strokeColor,
  uppercase,
  opacity,
  karaoke,
  emphasizeWordIndex,
  karaokeColor,
  shadowDistance,
  shadowBlur,
  shadowOpacity,
  bgOpacity,
  bgPadding,
  bgRadius,
  letterSpacing,
  lineHeight,
  rotation,
}) {
  const { path: fontPath } = resolveFontEntry(fontId);
  const font = loadFontFromPath(fontPath);
  const resolvedFontSize = fontSize || FONT_SIZE;
  const emojiSize = resolvedFontSize * EMOJI_SIZE_RATIO;
  // D1: uppercase before wrapping so word-wrap widths match the preview.
  const displayText = (uppercase ? String(text).toUpperCase() : String(text)).trim();
  // D1: letter-spacing (em → px) folds into measurement so wrapping matches.
  const letterSpacingPx = (Number.isFinite(letterSpacing) ? letterSpacing : 0) * resolvedFontSize;
  // Per-layer wrap width (fraction of canvas width); falls back to the legacy
  // fixed ratio. Multiplying canvas width by the same ratio the preview uses
  // keeps word-wrap identical between preview and render.
  const wrapRatio = Number.isFinite(wrapWidth) ? wrapWidth : MAX_TEXT_WIDTH_RATIO;
  const maxTextWidth = Math.round((canvasWidth || DEFAULT_CANVAS_W) * wrapRatio);
  const lines = wrapText(font, displayText, resolvedFontSize, maxTextWidth, emojiSize, letterSpacingPx);

  // D1: configurable stroke (% of font size; null follows the style) + colour,
  // and group opacity. Mirrors preview.js updateLayerEl.
  const defaultStrokePct = style === 'outline' ? OUTLINE_THICKNESS : 0;
  const strokePct = Number.isFinite(strokeWidth) ? strokeWidth : defaultStrokePct;
  const groupOpacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
  const buildArgs = {
    lines,
    font,
    fontSize: resolvedFontSize,
    emojiSize,
    dropShadow: !!dropShadow,
    color,
    strokePct,
    strokeColor: strokeColor || 'black',
    opacity: groupOpacity,
    karaoke: !!karaoke,
    emphasizeWordIndex: Number.isFinite(emphasizeWordIndex) ? emphasizeWordIndex : -1,
    karaokeColor: karaokeColor || '#ffe600',
    // D1 remainder.
    letterSpacingPx,
    lineHeightMult: Number.isFinite(lineHeight) ? lineHeight : 1,
    shadowDist: Number.isFinite(shadowDistance) ? shadowDistance : 0.07,
    shadowBlur: Number.isFinite(shadowBlur) ? shadowBlur : 0.05,
    shadowOpacity: Number.isFinite(shadowOpacity) ? shadowOpacity : 0.4,
    bgOpacity: Number.isFinite(bgOpacity) ? bgOpacity : 1,
    bgPadding: Number.isFinite(bgPadding) ? bgPadding : 1,
    bgRadius: Number.isFinite(bgRadius) ? bgRadius : 1,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
  let svg, width, height;
  if (style === 'box') {
    // Box karaoke falls back to normal box rendering (word-level pills would
    // shift the bubble); outline/plain carry the word emphasis.
    ({ svg, width, height } = buildBoxSvg(buildArgs));
  } else {
    ({ svg, width, height } = buildOutlineSvg(buildArgs));
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      // realFontPath mirrors the font out of app.asar in packaged builds so
      // resvg's non-asar-aware reader can actually load the glyphs.
      fontFiles: [realFontPath(fontPath)],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  const buffer = rendered.asPng();

  return { buffer, width: rendered.width, height: rendered.height };
}

module.exports = { renderCaptionPng, resolveFontPath, getFontOptions };
