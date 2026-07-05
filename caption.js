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
const TWEMOJI_DIR = path.join(__dirname, 'assets', 'emoji', 'twemoji');

// Bundled fonts, all free/open-licensed (SIL OFL) and downloaded from Google
// Fonts — see fonts/OFL-<name>.txt for each one's license text. "system:
// true" means the file isn't bundled at all; it's resolved from wherever
// the user's own copy actually lives on disk (see SYSTEM_FONT_SEARCH_DIRS),
// via that entry's "match" function — used for commercially-licensed fonts
// (Proxima Nova, Burbank Big Condensed) that can't legally be redistributed.
const FONT_REGISTRY = {
  'proxima-nova': { label: 'Proxima Nova', system: true, match: isProximaNovaSemibold },
  montserrat: { label: 'Montserrat SemiBold', path: path.join(__dirname, 'fonts', 'Montserrat-SemiBold.ttf') },
  manrope: { label: 'Manrope ExtraBold', path: path.join(__dirname, 'fonts', 'Manrope-ExtraBold.ttf') },
  poppins: { label: 'Poppins ExtraBold', path: path.join(__dirname, 'fonts', 'Poppins-ExtraBold.ttf') },
  'archivo-black': { label: 'Archivo Black', path: path.join(__dirname, 'fonts', 'ArchivoBlack-Regular.ttf') },
  'bebas-neue': { label: 'Bebas Neue', path: path.join(__dirname, 'fonts', 'BebasNeue-Regular.ttf') },
  anton: { label: 'Anton', path: path.join(__dirname, 'fonts', 'Anton-Regular.ttf') },
  'burbank-condensed': { label: 'Burbank Big Condensed', system: true, match: isBurbankBigCondensed(false) },
  'burbank-condensed-bold': { label: 'Burbank Big Condensed Bold', system: true, match: isBurbankBigCondensed(true) },
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

// Legacy default-resolution path, kept only for the one-line boot log in
// server.js — actual per-render font choice now goes through
// resolveFontEntry() below, driven by the caption font dropdown.
let resolvedFontPath = null;
function resolveFontPath() {
  if (resolvedFontPath) return resolvedFontPath;
  const systemProxima = getSystemFontPath('proxima-nova');
  if (systemProxima) {
    console.log(`[caption] Using system Proxima Nova Semibold: ${systemProxima}`);
  } else {
    console.log('[caption] Proxima Nova Semibold not found on this system — falling back to bundled Montserrat SemiBold.');
  }
  resolvedFontPath = systemProxima || FONT_REGISTRY[DEFAULT_FONT_ID].path;
  return resolvedFontPath;
}

// Proxima Nova is TikTok's actual caption font, so it's the preferred
// default whenever it's genuinely installed — falling back to bundled
// Montserrat (DEFAULT_FONT_ID) only when it isn't, never silently
// substituting a different font for one the user explicitly picked.
function resolveDefaultFontId() {
  return getSystemFontPath('proxima-nova') ? 'proxima-nova' : DEFAULT_FONT_ID;
}

// Reports every selectable caption font, whether it's actually usable on
// this machine right now (the frontend uses this to gray out system fonts
// like Proxima Nova or Burbank Big Condensed when they aren't installed,
// instead of silently substituting another font), and which one should be
// pre-selected by default.
function getFontOptions() {
  const defaultId = resolveDefaultFontId();
  return Object.entries(FONT_REGISTRY).map(([id, entry]) => ({
    id,
    label: entry.label,
    available: entry.system ? !!getSystemFontPath(id) : true,
    isDefault: id === defaultId,
  }));
}

function resolveFontEntry(fontId) {
  const id = FONT_REGISTRY[fontId] ? fontId : resolveDefaultFontId();
  const entry = FONT_REGISTRY[id];
  if (entry.system) {
    const systemPath = getSystemFontPath(id);
    if (systemPath) return { id, path: systemPath };
    return { id: DEFAULT_FONT_ID, path: FONT_REGISTRY[DEFAULT_FONT_ID].path };
  }
  return { id, path: entry.path };
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

function measureWidth(font, text, fontSize) {
  return font.getAdvanceWidth(text, fontSize);
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
function layoutLineSegments(font, line, fontSize, emojiSize) {
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
    const width = measureWidth(font, seg.value, fontSize);
    const item = { ...seg, x, width };
    x += width;
    return item;
  });
  return { segments, totalWidth: x };
}

function measureLineWidth(font, line, fontSize, emojiSize) {
  return layoutLineSegments(font, line, fontSize, emojiSize).totalWidth;
}

// Splits on explicit newlines first (preserves the user's manual line breaks),
// then greedily word-wraps each of those lines to fit maxWidth.
function wrapText(font, text, fontSize, maxWidth, emojiSize) {
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
      if (currentLine && measureLineWidth(font, candidate, fontSize, emojiSize) > maxWidth) {
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
function buildDropShadowFilterDef(fontSize) {
  const dx = (fontSize * 0.05).toFixed(2);
  const dy = (fontSize * 0.07).toFixed(2);
  const blur = (fontSize * 0.05).toFixed(2);
  return `<defs><filter id="dropshadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur}" flood-color="black" flood-opacity="0.4"/></filter></defs>`;
}

// Outline style: white fill, black stroke. This is the ONLY function in the
// module that touches stroke/paint-order — buildBoxSvg below never calls it
// and has no stroke logic of its own, so the two styles can't bleed into
// each other.
// Shared by both the Outline and (strokeless) Plain caption styles — they
// differ only in whether a black stroke is drawn around the text at all,
// so a single builder with stroke=false covers "Plain" instead of
// duplicating the whole line-layout/drop-shadow-grouping logic.
function buildOutlineSvg({ lines, font, fontSize, emojiSize, dropShadow, color, stroke = true }) {
  const textColor = color || '#ffffff';
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = ascenderPx + descenderPx;
  const textBlockHeight = lineHeight * lines.length;
  const strokeWidth = stroke ? fontSize * (OUTLINE_THICKNESS / 100) : 0;

  // Cropped tightly to the widest line (plus stroke/safety margin) rather
  // than always spanning the full canvas width — this is what lets the
  // server position the caption anywhere horizontally via the ffmpeg
  // overlay's x, the same way it already does vertically with height.
  const maxLineWidth = Math.max(...lines.map((line) => measureLineWidth(font, line, fontSize, emojiSize)));
  const width = Math.ceil(maxLineWidth + strokeWidth + OUTER_PADDING * 2);
  const height = Math.ceil(textBlockHeight + OUTER_PADDING * 2);
  const textTop = OUTER_PADDING;

  let elements = dropShadow ? buildDropShadowFilterDef(fontSize) : '';
  lines.forEach((line, i) => {
    const baselineY = textTop + i * lineHeight + ascenderPx;
    const lineTop = textTop + i * lineHeight;
    const { segments, totalWidth } = layoutLineSegments(font, line, fontSize, emojiSize);
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
        const strokeAttrs = stroke
          ? ` stroke="black" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" style="paint-order:stroke"`
          : '';
        lineContent += `<text x="${segX.toFixed(2)}" y="${baselineY.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="${textColor}"${strokeAttrs} text-anchor="start">${escapeXml(seg.value)}</text>`;
      }
    });

    elements += dropShadow ? `<g filter="url(#dropshadow)">${lineContent}</g>` : lineContent;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements}</svg>`;
  return { svg, width, height };
}

// Box style: solid black fill text on a white rounded box. No stroke
// attributes appear anywhere in this function. The drop shadow (when on)
// sits under the box itself, not the text — matching how CapCut's classic
// box caption casts one shadow for the whole bubble.
// Box style: unlike a single rectangle sized to the widest line, TikTok's
// own box caption gives EACH line its own rounded pill sized to that
// line's own text width, stacked together — so a short line under a long
// one reads as a visibly narrower, separately-rounded step, not centered
// inside one shared-width rectangle. Rendered as N independently-rounded
// <rect>s (one per line, same fill, touching with a 1px overlap to avoid
// any antialiasing seam) rather than a single path: at the seam between
// two differently-sized rows, each row's own corner rounding naturally
// produces the notched/connected look, with no custom path math needed.
function buildBoxSvg({ lines, font, fontSize, emojiSize, dropShadow, color }) {
  const boxColor = color || '#ffffff';
  const textColor = getContrastTextColor(boxColor);
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = ascenderPx + descenderPx;
  const lineWidths = lines.map((line) => measureLineWidth(font, line, fontSize, emojiSize));

  const boxY = OUTER_PADDING;
  const lineCount = lines.length;
  const ROW_OVERLAP = 1;

  // A single consistent radius for every row (derived from what a lone
  // single-line box's height would be), rather than each row's own actual
  // height — keeps corners visually uniform across the whole stack even
  // though first/last rows are taller (they carry the outer padding).
  const singleLineBoxHeight = lineHeight + BOX_PADDING_Y * 2;
  const boxRadius = singleLineBoxHeight * BOX_RADIUS_RATIO;

  const rectWidths = lineWidths.map((w) => w + BOX_PADDING_X * 2);
  // Cropped tightly to the widest row (plus safety margin) rather than
  // always spanning the full canvas width — lets the server position the
  // caption anywhere horizontally via the ffmpeg overlay's x, the same way
  // it already does vertically with height.
  const width = Math.ceil(Math.max(...rectWidths) + OUTER_PADDING * 2);

  let rowTop = boxY;
  const rows = lines.map((line, i) => {
    const topPad = i === 0 ? BOX_PADDING_Y : 0;
    const bottomPad = i === lineCount - 1 ? BOX_PADDING_Y : 0;
    const top = rowTop;
    const bottom = top + topPad + lineHeight + bottomPad;
    rowTop = bottom;
    const rectWidth = rectWidths[i];
    return { top, bottom, textTop: top + topPad, rectX: width / 2 - rectWidth / 2, rectWidth };
  });

  const height = Math.ceil(rows[lineCount - 1].bottom + OUTER_PADDING);

  let boxRects = '';
  rows.forEach((row, i) => {
    const rectHeight = row.bottom - row.top + (i < lineCount - 1 ? ROW_OVERLAP : 0);
    boxRects += `<rect x="${row.rectX.toFixed(2)}" y="${row.top.toFixed(2)}" width="${row.rectWidth.toFixed(2)}" height="${rectHeight.toFixed(2)}" rx="${boxRadius.toFixed(2)}" ry="${boxRadius.toFixed(2)}" fill="${boxColor}"/>`;
  });

  // Two adjacent rows of (near-)equal width would otherwise each round
  // their touching corners away from the seam, pinching the connection
  // into a visible waist even though there's no real width change to
  // justify a notch there. A small square filler patch spanning the seam
  // flattens that into one continuous edge — matching how TikTok's own
  // same-width stacked lines connect with no notch at all.
  const SAME_WIDTH_TOLERANCE = 3;
  for (let i = 0; i < lineCount - 1; i++) {
    if (Math.abs(rows[i].rectWidth - rows[i + 1].rectWidth) <= SAME_WIDTH_TOLERANCE) {
      const fillerWidth = Math.min(rows[i].rectWidth, rows[i + 1].rectWidth);
      const fillerX = width / 2 - fillerWidth / 2;
      const seamY = rows[i].bottom;
      boxRects += `<rect x="${fillerX.toFixed(2)}" y="${(seamY - boxRadius).toFixed(2)}" width="${fillerWidth.toFixed(2)}" height="${(boxRadius * 2).toFixed(2)}" fill="${boxColor}"/>`;
    }
  }

  let elements = dropShadow ? buildDropShadowFilterDef(fontSize) : '';
  // Grouped under one filter so the connected stack casts a single unified
  // shadow instead of each row casting (and overlapping) its own.
  elements += dropShadow ? `<g filter="url(#dropshadow)">${boxRects}</g>` : boxRects;

  lines.forEach((line, i) => {
    const row = rows[i];
    const baselineY = row.textTop + ascenderPx;
    const { segments, totalWidth } = layoutLineSegments(font, line, fontSize, emojiSize);
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
        elements += `<text x="${segX.toFixed(2)}" y="${baselineY.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="${textColor}" text-anchor="start">${escapeXml(seg.value)}</text>`;
      }
    });
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements}</svg>`;
  return { svg, width, height };
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
function renderCaptionPng({ text, style, fontId, dropShadow, fontSize, color, canvasWidth }) {
  const { path: fontPath } = resolveFontEntry(fontId);
  const font = loadFontFromPath(fontPath);
  const resolvedFontSize = fontSize || FONT_SIZE;
  const emojiSize = resolvedFontSize * EMOJI_SIZE_RATIO;
  const maxTextWidth = Math.round((canvasWidth || DEFAULT_CANVAS_W) * MAX_TEXT_WIDTH_RATIO);
  const lines = wrapText(font, text.trim(), resolvedFontSize, maxTextWidth, emojiSize);

  const buildArgs = { lines, font, fontSize: resolvedFontSize, emojiSize, dropShadow: !!dropShadow, color };
  let svg, width, height;
  if (style === 'box') {
    ({ svg, width, height } = buildBoxSvg(buildArgs));
  } else if (style === 'plain') {
    ({ svg, width, height } = buildOutlineSvg({ ...buildArgs, stroke: false }));
  } else {
    ({ svg, width, height } = buildOutlineSvg(buildArgs));
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontFiles: [fontPath],
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
