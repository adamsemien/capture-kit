import { base64ToBlob, blobToBase64 } from '../base64';

// Chrome's canvas limits: ~32,767px per dimension and ~2^28 px² of area.
// Beyond these, canvas creation or drawing fails silently with blank output,
// so we clamp up front and report the truncation honestly.
export const CANVAS_MAX_DIMENSION = 32767;
export const CANVAS_MAX_AREA = 1 << 28; // 268,435,456 px²

export function clampDimensions(
  width: number,
  height: number,
): { width: number; height: number; truncated: boolean } {
  let w = Math.min(width, CANVAS_MAX_DIMENSION);
  let h = Math.min(height, CANVAS_MAX_DIMENSION);
  if (w * h > CANVAS_MAX_AREA) h = Math.floor(CANVAS_MAX_AREA / w);
  return { width: w, height: h, truncated: w < width || h < height };
}

/**
 * Scroll offsets that tile `total` px with a `viewport`-px window: regular
 * steps of one viewport, with the final offset clamped so the last tile ends
 * exactly at the content edge. The clamped tile overlaps its neighbor with
 * identical content, so coarse placement stays exact.
 */
export function planScrollOffsets(total: number, viewport: number): number[] {
  if (viewport >= total) return [0];
  const offsets: number[] = [];
  for (let pos = 0; pos < total - viewport; pos += viewport) {
    offsets.push(pos);
  }
  offsets.push(total - viewport);
  return offsets;
}

/**
 * Joins segment PNGs by coarse rectangle placement at exact scroll offsets —
 * no overlap detection, no stitching heuristics. Segments are added one at a
 * time so only one decoded bitmap is in memory at once.
 */
export class SegmentCanvas {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2d canvas context for segment joining.');
    this.ctx = ctx;
  }

  async add(x: number, y: number, pngBase64: string): Promise<void> {
    const bitmap = await createImageBitmap(base64ToBlob(pngBase64, 'image/png'));
    this.ctx.drawImage(bitmap, x, y);
    bitmap.close();
  }

  async toPngBase64(): Promise<string> {
    return blobToBase64(await this.canvas.convertToBlob({ type: 'image/png' }));
  }
}
