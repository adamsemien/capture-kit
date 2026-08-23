import { base64ToBlob, blobToBase64 } from '../base64';
import { CANVAS_MAX_AREA, CANVAS_MAX_DIMENSION } from './segments';
import { JPEG_QUALITY, type CaptureResult, type StampRequest } from './types';

/**
 * The optional URL footer.
 *
 * Everything here operates on an already-encoded image inside the service
 * worker: no DOM, no page, no debugger, no CDP. That is the whole safety
 * argument for F3 and it is structural rather than a matter of timing — this
 * module cannot reach a live page even if it wanted to, so the footer cannot
 * appear mid-scroll in a segmented capture and cannot be photographed by the
 * capture that produced the image it is drawing on.
 *
 * The seam is one function. It has two call sites (captureFullPage, and the
 * sweep's per-width loop, which bypasses captureFullPage because one debugger
 * attachment has to span all three widths), but exactly one implementation, so
 * a stamped sweep width and a stamped page capture are the same pixels.
 */

/** Band geometry, exported so the acceptance checks assert the same arithmetic. */
export function bandHeight(imageWidth: number): number {
  return Math.min(40, Math.max(22, Math.round(imageWidth * 0.018)));
}

const BAND_BACKGROUND = '#0b0b0c';
const BAND_TEXT = '#f5f5f5';
const PADDING = 12;
const GAP = 16;
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Middle ellipsis: a URL's host and its last path segment are the two parts
 * worth keeping, and they sit at opposite ends. Truncating the tail would drop
 * the route, which on a single-host app is the only thing distinguishing two
 * captures.
 */
function fitText(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  let best = ellipsis;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = text.slice(0, Math.ceil(keep / 2));
    const tail = text.slice(text.length - Math.floor(keep / 2));
    const candidate = `${head}${ellipsis}${tail}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}

/**
 * Growing the canvas is the default; overlaying is the fallback for a page
 * already at Chrome's canvas ceiling, where one more row would fail the
 * allocation and hand back blank output. Losing the bottom 30px of a
 * 32,767px-tall page is a real cost, which is why the report says which
 * happened rather than leaving the reader to notice.
 */
function planBand(
  width: number,
  height: number,
): { band: number; mode: 'extended' | 'overlaid'; canvasHeight: number } {
  const band = bandHeight(width);
  const grown = height + band;
  const fits = grown <= CANVAS_MAX_DIMENSION && width * grown <= CANVAS_MAX_AREA;
  return fits
    ? { band, mode: 'extended', canvasHeight: grown }
    : { band, mode: 'overlaid', canvasHeight: height };
}

/**
 * Draws the footer onto a decoded copy of `imageBase64` and re-encodes.
 *
 * The re-encode is the honest cost of this feature: a JPEG goes through one
 * extra generation of loss. It only ever happens with the setting on.
 */
export async function stampCaptureResult(
  result: CaptureResult,
  stamp: StampRequest,
): Promise<CaptureResult> {
  const mime = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const bitmap = await createImageBitmap(base64ToBlob(result.imageBase64, mime));
  try {
    // The bitmap, not fullSize, is the source of truth for the pixels we hold:
    // a truncated capture's fullSize already describes them, but reading the
    // decoded image means the footer can never be drawn off the edge.
    const width = bitmap.width;
    const height = bitmap.height;
    const { band, mode, canvasHeight } = planBand(width, height);

    const canvas = new OffscreenCanvas(width, canvasHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2d canvas context for the URL footer.');
    ctx.drawImage(bitmap, 0, 0);

    const bandTop = canvasHeight - band;
    ctx.fillStyle = BAND_BACKGROUND;
    ctx.fillRect(0, bandTop, width, band);

    const fontPx = Math.max(11, Math.round(band * 0.58));
    ctx.font = `${fontPx}px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = BAND_TEXT;
    const centerY = bandTop + band / 2;

    // Timestamp is laid out first and keeps its full width — it is fixed-length
    // and it is the half a truncated URL must not eat into.
    const timestamp = stamp.capturedAt.toISOString();
    const timestampWidth = ctx.measureText(timestamp).width;
    const urlSpace = width - PADDING * 2 - timestampWidth - GAP;

    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, stamp.url, urlSpace), PADDING, centerY);
    ctx.textAlign = 'right';
    ctx.fillText(timestamp, width - PADDING, centerY);

    const blob = await canvas.convertToBlob(
      result.format === 'jpeg'
        ? { type: 'image/jpeg', quality: JPEG_QUALITY / 100 }
        : { type: 'image/png' },
    );
    return {
      ...result,
      imageBase64: await blobToBase64(blob),
      // fullSize stays page geometry; imageSize is the file.
      imageSize: { width, height: canvasHeight },
      stamp: { mode, height: band },
    };
  } finally {
    bitmap.close();
  }
}

/** Human-readable footer state for the report's context block. */
export function stampLabel(info: CaptureResult['stamp']): string {
  if (!info) return 'off';
  return info.mode === 'extended'
    ? `on — ${info.height}px footer appended below the page`
    : `on — ${info.height}px footer overlaid on the bottom of the page (canvas at Chrome's limit)`;
}
