const fs = require('fs');
const os = require('os');
const path = require('path');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');

const CANVAS_W = 1080;
const FONT_SIZE = 64;
const MAX_TEXT_WIDTH = 900; // leaves ~90px margin on each side of the 1080 canvas
const OUTER_PADDING = 10; // safety margin so stroke/antialiasing never clips at image edges
const BOX_PADDING_X = 30;
const BOX_PADDING_Y = 22;
const BOX_RADIUS = 16;
const OUTLINE_THICKNESS = 15; // percentage of font size — 9.6px at FONT_SIZE=64, matches TikTok's ~8-10px look
const FONT_FAMILY = 'Caption Font'; // alias used inside generated SVGs, decoupled from whichever real font file backs it

const MONTSERRAT_PATH = path.join(__dirname, 'fonts', 'Montserrat-SemiBold.ttf');

// Where an installed "Proxima Nova" could actually live on this machine.
// Checked in this order: Adobe Fonts' sync cache first (Creative Cloud
// activates fonts into CoreSync's livetype cache under a *hidden* ".r"
// directory with obfuscated filenames like ".173.otf" — not a normal Font
// Book install, and easy to miss if you search for "r" instead of ".r"),
// then the standard macOS font directories.
const PROXIMA_SEARCH_DIRS = [
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

// Positively confirms a Proxima Nova Semibold font FILE exists on disk
// before trusting it — resvg-js's loadSystemFonts option can't report
// whether a family name actually resolved (verified empirically: asking
// for a nonexistent font name renders byte-identical output to asking for
// "Proxima Nova" when it isn't installed), so a real file is required both
// to prove availability and to let opentype.js measure text against it.
function findSystemProximaNovaSemibold() {
  for (const dir of PROXIMA_SEARCH_DIRS) {
    const candidates = listFontFilesRecursive(dir, 2);
    for (const candidate of candidates) {
      try {
        const buf = fs.readFileSync(candidate);
        const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        if (isProximaNovaSemibold(font)) {
          return candidate;
        }
      } catch {
        // Not a font opentype.js can parse (e.g. a .ttc collection) — skip it.
      }
    }
  }
  return null;
}

let resolvedFontPath = null;
function resolveFontPath() {
  if (resolvedFontPath) return resolvedFontPath;
  const systemProxima = findSystemProximaNovaSemibold();
  if (systemProxima) {
    console.log(`[caption] Using system Proxima Nova Semibold: ${systemProxima}`);
  } else {
    console.log('[caption] Proxima Nova Semibold not found on this system — falling back to bundled Montserrat SemiBold.');
  }
  resolvedFontPath = systemProxima || MONTSERRAT_PATH;
  return resolvedFontPath;
}

let cachedFont = null;
let cachedFontPath = null;
function loadFont() {
  const fontPath = resolveFontPath();
  if (!cachedFont || cachedFontPath !== fontPath) {
    const buf = fs.readFileSync(fontPath);
    cachedFont = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cachedFontPath = fontPath;
  }
  return cachedFont;
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

// Splits on explicit newlines first (preserves the user's manual line breaks),
// then greedily word-wraps each of those lines to fit maxWidth.
function wrapText(font, text, fontSize, maxWidth) {
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
      if (currentLine && measureWidth(font, candidate, fontSize) > maxWidth) {
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

// Outline style: white fill, black stroke. This is the ONLY function in the
// module that touches stroke/paint-order — buildBoxSvg below never calls it
// and has no stroke logic of its own, so the two styles can't bleed into
// each other.
function buildOutlineSvg({ lines, font, fontSize }) {
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = ascenderPx + descenderPx;
  const textBlockHeight = lineHeight * lines.length;

  const width = CANVAS_W;
  const height = Math.ceil(textBlockHeight + OUTER_PADDING * 2);
  const strokeWidth = fontSize * (OUTLINE_THICKNESS / 100);
  const textTop = OUTER_PADDING;

  let elements = '';
  lines.forEach((line, i) => {
    const baselineY = textTop + i * lineHeight + ascenderPx;
    elements += `<text x="${width / 2}" y="${baselineY.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="white" stroke="black" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" style="paint-order:stroke" text-anchor="middle">${escapeXml(line)}</text>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements}</svg>`;
  return { svg, width, height };
}

// Box style: solid black fill text on a white rounded box. No stroke
// attributes appear anywhere in this function.
function buildBoxSvg({ lines, font, fontSize }) {
  const ascenderPx = (font.ascender / font.unitsPerEm) * fontSize;
  const descenderPx = (Math.abs(font.descender) / font.unitsPerEm) * fontSize;
  const lineHeight = ascenderPx + descenderPx;
  const textBlockHeight = lineHeight * lines.length;
  const maxLineWidth = Math.max(...lines.map((line) => measureWidth(font, line, fontSize)));

  const boxWidth = maxLineWidth + BOX_PADDING_X * 2;
  const boxHeight = textBlockHeight + BOX_PADDING_Y * 2;
  const width = CANVAS_W;
  const height = Math.ceil(boxHeight + OUTER_PADDING * 2);

  const boxX = (width - boxWidth) / 2;
  const boxY = OUTER_PADDING;
  let elements = `<rect x="${boxX.toFixed(2)}" y="${boxY.toFixed(2)}" width="${boxWidth.toFixed(2)}" height="${boxHeight.toFixed(2)}" rx="${BOX_RADIUS}" ry="${BOX_RADIUS}" fill="white"/>`;

  const textTop = boxY + BOX_PADDING_Y;
  lines.forEach((line, i) => {
    const baselineY = textTop + i * lineHeight + ascenderPx;
    elements += `<text x="${width / 2}" y="${baselineY.toFixed(2)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" fill="black" text-anchor="middle">${escapeXml(line)}</text>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements}</svg>`;
  return { svg, width, height };
}

// Renders caption text to a transparent PNG matching the video canvas width.
// Returns the PNG buffer plus its pixel dimensions (needed by the caller to
// compute the overlay's vertical position).
function renderCaptionPng({ text, style }) {
  const font = loadFont();
  const fontPath = resolveFontPath();
  const lines = wrapText(font, text.trim(), FONT_SIZE, MAX_TEXT_WIDTH);

  const { svg, width, height } =
    style === 'box'
      ? buildBoxSvg({ lines, font, fontSize: FONT_SIZE })
      : buildOutlineSvg({ lines, font, fontSize: FONT_SIZE });

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

module.exports = { renderCaptionPng, resolveFontPath };
