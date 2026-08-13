// Generates the extension icons: a dark rounded square with a white bracket
// glyph, rendered procedurally and encoded as PNG by hand (zlib is the only
// dependency, and it ships with Node). The geometry below is the source of
// truth — re-run `node scripts/gen-icons.mjs` after changing it.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const BG = [27, 27, 31]; // dark charcoal
const FG = [255, 255, 255];
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Rendering --------------------------------------------------------------

function insideRoundedSquare(px, py, size, radius) {
  if (px < 0 || py < 0 || px > size || py > size) return false;
  const cx = px < radius ? radius : px > size - radius ? size - radius : null;
  const cy = py < radius ? radius : py > size - radius ? size - radius : null;
  if (cx === null || cy === null) return true; // edge bands, not a corner box
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

// Bracket glyph "[ ]" built from axis-aligned rectangles [x0, y0, x1, y1].
function glyphRects(s) {
  const stroke = Math.max(1.5, s * 0.085);
  const top = s * 0.3;
  const bottom = s * 0.7;
  const arm = s * 0.14;
  const left = s * 0.26;
  const right = s * 0.74;
  return [
    [left, top, left + stroke, bottom],
    [left, top, left + arm, top + stroke],
    [left, bottom - stroke, left + arm, bottom],
    [right - stroke, top, right, bottom],
    [right - arm, top, right, top + stroke],
    [right - arm, bottom - stroke, right, bottom],
  ];
}

function render(size) {
  const radius = size * 0.22;
  const rects = glyphRects(size);
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4×4 supersampling for antialiased corners and strokes
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRoundedSquare(px, py, size, radius)) continue;
          bgHits += 1;
          if (rects.some(([x0, y0, x1, y1]) => px >= x0 && px < x1 && py >= y0 && py < y1)) {
            fgHits += 1;
          }
        }
      }
      const coverage = bgHits / (SS * SS);
      const glyphShare = bgHits ? fgHits / bgHits : 0;
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(BG[c] * (1 - glyphShare) + FG[c] * glyphShare);
      }
      rgba[offset + 3] = Math.round(coverage * 255);
    }
  }
  return rgba;
}

// --- Main -------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
