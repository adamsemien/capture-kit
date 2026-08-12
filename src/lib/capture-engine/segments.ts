import { base64ToBlob, blobToBase64 } from '../base64';

// Chrome's canvas limits: ~32,767px per dimension and ~2^28 px² of area.
// Beyond these, canvas creation or drawing fails silently with blank output,
// so we clamp up front and report the truncation honestly.
export const CANVAS_MAX_DIMENSION = 32767;
export const CANVAS_MAX_AREA = 1 << 28; // 268,435,456 px²

export interface SegmentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
 * Grid plan for capturing a width×height page in segments of at most
 * segmentSize per dimension. A page that fits yields a single full rect.
 */
export function planSegments(width: number, height: number, segmentSize: number): SegmentRect[] {
  if (width <= segmentSize && height <= segmentSize) {
    return [{ x: 0, y: 0, width, height }];
  }
  const rects: SegmentRect[] = [];
  for (let y = 0; y < height; y += segmentSize) {
    for (let x = 0; x < width; x += segmentSize) {
      rects.push({
        x,
        y,
        width: Math.min(segmentSize, width - x),
        height: Math.min(segmentSize, height - y),
      });
    }
  }
  return rects;
}

/**
 * Joins segment PNGs by coarse rectangle placement at exact grid offsets —
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

  async add(rect: SegmentRect, pngBase64: string): Promise<void> {
    const bitmap = await createImageBitmap(base64ToBlob(pngBase64, 'image/png'));
    this.ctx.drawImage(bitmap, rect.x, rect.y);
    bitmap.close();
  }

  async toPngBase64(): Promise<string> {
    return blobToBase64(await this.canvas.convertToBlob({ type: 'image/png' }));
  }
}
