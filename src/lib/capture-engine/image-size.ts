import type { PageDimensions } from './types';

/**
 * The encoded image's real pixel dimensions, read from its header.
 *
 * Every path used to *assume* the file matched the CSS layout it asked for.
 * That assumption is false on the single-shot path at devicePixelRatio > 1:
 * `Page.captureScreenshot` with `clip.scale: 1` does NOT pin the output to CSS
 * pixels, despite what the code once claimed. Measured 2026-08-23 — a 1200×5520
 * CSS page came back as a 2400×11040 file on a DPR-2 display while the report
 * said 1200×5520.
 *
 * Reading the header instead of trusting the request costs a base64 decode and
 * no image decode, so it is cheap enough to do on every capture. `imageSize`
 * then means "measured", not "expected", which is the only version of that
 * number worth printing.
 */

/** Decode only as much base64 as a header scan can need. */
function decodePrefix(base64: string, maxBytes: number): Uint8Array {
  // 4 base64 chars → 3 bytes; keep the slice on a 4-char boundary.
  const chars = Math.min(base64.length, Math.ceil((maxBytes / 3) * 4) + 4) & ~3;
  const binary = atob(base64.slice(0, chars));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readPng(bytes: Uint8Array): PageDimensions | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(bytes: Uint8Array): PageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // resync past padding
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    // SOF0..SOF15 hold the frame dimensions; C4/C8/CC are not frame headers.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return { width, height };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Returns null when the header cannot be read — callers fall back to the size
 * they asked for rather than reporting nothing.
 */
export function readEncodedImageSize(base64: string, format: 'png' | 'jpeg'): PageDimensions | null {
  try {
    // 64 KB is far past any Chrome screenshot's SOF/IHDR; screenshots carry no
    // EXIF, so the frame header sits near the front.
    const bytes = decodePrefix(base64, 64 * 1024);
    const size = format === 'png' ? readPng(bytes) : readJpeg(bytes);
    if (!size || !size.width || !size.height) return null;
    return size;
  } catch {
    return null;
  }
}
