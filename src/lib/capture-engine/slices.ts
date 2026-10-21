/*
 * Tall pages (NOBC-161).
 *
 * Two problems, one module. Chrome cannot hold more than 32,767 px per side,
 * or 2^28 px of area, in one canvas, so a long page used to be cut off at
 * that height. And even when a page fits, an assistant shrinks one tall image
 * until its text cannot be read - a 1280 x 30,000 capture reaches Claude as a
 * strip about 70 px wide.
 *
 * So a capture now does two things with the pixels it gathers:
 *
 *   - the whole-page image, scaled down only when the page is past Chrome's
 *     limits, so nothing is ever cut off; and
 *   - slices: screen-sized, full-resolution pieces of the page, top to bottom,
 *     each overlapping the next a little so no line of text is only ever seen
 *     cut in half.
 *
 * The plan is pure arithmetic and unit-tested. The canvases are built as the
 * segmented capture's rows pass, so only the slices the current row touches
 * are held in memory at once.
 */

import { base64ToBlob, blobToBase64 } from '../base64';
import { CANVAS_MAX_AREA, CANVAS_MAX_DIMENSION } from './segments';
import { JPEG_QUALITY, type CaptureFormat, type CaptureSlice } from './types';

/** Rows two neighbouring slices share, so a line of text cut by one edge is whole in the other. */
export const SLICE_OVERLAP = 64;
/** A slice is about a screen: 1.25 x the image width, kept between these bounds. */
export const SLICE_WIDTH_RATIO = 1.25;
export const SLICE_MIN_HEIGHT = 1000;
export const SLICE_MAX_HEIGHT = 4000;
/**
 * Past this many, slices grow taller instead of more numerous. Every slice is a
 * file (and on the Downloads path, a download), and an assistant reading 60 of
 * them is no better served than one reading 40 slightly taller ones.
 */
export const MAX_SLICES = 40;
/**
 * The tallest page a capture will scroll through. Past this the capture stops
 * and the report says the page was cut, as it did at 32,767 px before. 2^17 px
 * is about 100 screens; an infinite feed would otherwise never end.
 */
export const MAX_CAPTURE_HEIGHT = 131072;

/** Content kept either side of the trimmed area, so a glyph on the edge is never shaved. */
export const TRIM_PADDING = 16;
/** Trimming happens only when it removes at least this share of the width; less is not worth a changed width. */
export const TRIM_MIN_SHARE = 0.1;
/** Every Nth row is sampled when looking for empty margins. */
export const TRIM_ROW_STEP = 4;
/** Per-channel difference still counted as "the same background". JPEG-safe. */
export const TRIM_TOLERANCE = 6;

export interface SlicePlanEntry {
  top: number;
  height: number;
}

/** The slice height for an image this wide, before the MAX_SLICES adjustment. */
export function baseSliceHeight(width: number): number {
  return Math.min(SLICE_MAX_HEIGHT, Math.max(SLICE_MIN_HEIGHT, Math.round(width * SLICE_WIDTH_RATIO)));
}

/**
 * Where each slice sits, top to bottom, in image pixels. Null when the image
 * is short enough to read whole - two slice heights or less.
 *
 * Steps are one slice height minus the overlap; the last slice is pulled up so
 * it ends exactly at the bottom edge (overlapping its neighbour by more), the
 * same clamp planScrollOffsets uses. Every row of the image is in at least one
 * slice and every slice is the same height.
 */
export function planSlices(width: number, height: number): SlicePlanEntry[] | null {
  if (!(width > 0) || !(height > 0)) return null;
  let sliceHeight = baseSliceHeight(width);
  if (height <= sliceHeight * 2) return null;
  const count = (h: number) => Math.ceil((height - SLICE_OVERLAP) / (h - SLICE_OVERLAP));
  if (count(sliceHeight) > MAX_SLICES) {
    sliceHeight = Math.ceil((height - SLICE_OVERLAP) / MAX_SLICES) + SLICE_OVERLAP;
  }
  const step = sliceHeight - SLICE_OVERLAP;
  const plan: SlicePlanEntry[] = [];
  for (let top = 0; top + sliceHeight < height; top += step) {
    plan.push({ top, height: sliceHeight });
  }
  plan.push({ top: height - sliceHeight, height: sliceHeight });
  return plan;
}

/**
 * How much the whole-page image has to shrink to fit in one canvas: 1 when it
 * already fits, else the largest scale that keeps both sides within 32,767 px
 * and the area within 2^28 px. Scaling keeps the whole page; the old clamp
 * kept the top and dropped the rest.
 */
export function wholeImageScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const scale = Math.min(
    1,
    CANVAS_MAX_DIMENSION / width,
    CANVAS_MAX_DIMENSION / height,
    Math.sqrt(CANVAS_MAX_AREA / (width * height)),
  );
  // Floor to three places so the canvas built from it is never a pixel over.
  return scale >= 1 ? 1 : Math.floor(scale * 1000) / 1000;
}

export function scaledSize(width: number, height: number, scale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * The columns that hold something, given sampled rows of RGBA pixels packed
 * one after another (`rows` rows of `width` pixels).
 *
 * A column is empty when, on every sampled row, it matches that row's own
 * edge pixel - the left edge when scanning in from the left, the right edge
 * from the right. Comparing per row rather than to one colour is what lets a
 * full-width header band or a striped background count as margin. Returns
 * the half-open range [left, right); the whole width when nothing is empty
 * or nothing is there at all.
 */
export function contentColumns(
  data: Uint8ClampedArray,
  width: number,
  rows: number,
  tolerance = TRIM_TOLERANCE,
): { left: number; right: number } {
  if (width <= 0 || rows <= 0) return { left: 0, right: Math.max(0, width) };
  const same = (x: number, edge: number, row: number): boolean => {
    const base = row * width * 4;
    const a = base + x * 4;
    const b = base + edge * 4;
    return (
      Math.abs(data[a] - data[b]) <= tolerance &&
      Math.abs(data[a + 1] - data[b + 1]) <= tolerance &&
      Math.abs(data[a + 2] - data[b + 2]) <= tolerance
    );
  };
  const columnEmpty = (x: number, edge: number): boolean => {
    for (let row = 0; row < rows; row++) {
      if (!same(x, edge, row)) return false;
    }
    return true;
  };
  let left = 0;
  while (left < width && columnEmpty(left, 0)) left++;
  if (left === width) return { left: 0, right: width };
  let right = width;
  while (right > left && columnEmpty(right - 1, width - 1)) right--;
  return { left, right };
}

/**
 * Where to crop a slice of this width with content in [left, right): padded,
 * and only when it pays. Null means keep the full width.
 */
export function planTrim(width: number, left: number, right: number): { left: number; width: number } | null {
  const from = Math.max(0, left - TRIM_PADDING);
  const to = Math.min(width, right + TRIM_PADDING);
  if (to <= from) return null;
  if (width - (to - from) < width * TRIM_MIN_SHARE) return null;
  return { left: from, width: to - from };
}

/**
 * Crops a slice canvas to its content columns. Wide screens are where this
 * matters: a 2560 px capture of a page whose text sits in a 1,600 px column
 * is mostly empty, and an assistant shrinks the whole thing, text included,
 * to fit. Trimming the margins first keeps the text larger.
 */
function trimSlice(canvas: OffscreenCanvas): { canvas: OffscreenCanvas; left: number } {
  const { width, height } = canvas;
  const ctx = context(canvas);
  const rows = Math.ceil(height / TRIM_ROW_STEP);
  const data = new Uint8ClampedArray(rows * width * 4);
  for (let i = 0; i < rows; i++) {
    data.set(ctx.getImageData(0, Math.min(height - 1, i * TRIM_ROW_STEP), width, 1).data, i * width * 4);
  }
  const columns = contentColumns(data, width, rows);
  const trim = planTrim(width, columns.left, columns.right);
  if (!trim) return { canvas, left: 0 };
  const cropped = new OffscreenCanvas(trim.width, height);
  context(cropped).drawImage(canvas, -trim.left, 0);
  return { canvas: cropped, left: trim.left };
}

async function encodeSlice(
  canvas: OffscreenCanvas,
  format: CaptureFormat,
  slice: SlicePlanEntry,
): Promise<CaptureSlice> {
  const trimmed = trimSlice(canvas);
  return {
    imageBase64: await encode(trimmed.canvas, format),
    top: slice.top,
    height: slice.height,
    width: trimmed.canvas.width,
    left: trimmed.left,
  };
}

async function encode(canvas: OffscreenCanvas, format: CaptureFormat): Promise<string> {
  const blob = await canvas.convertToBlob(
    format === 'jpeg' ? { type: 'image/jpeg', quality: JPEG_QUALITY / 100 } : { type: 'image/png' },
  );
  return blobToBase64(blob);
}

function context(canvas: OffscreenCanvas, readBack = false): OffscreenCanvasRenderingContext2D {
  // The first getContext call fixes the options; later calls return the same context.
  const ctx = canvas.getContext('2d', readBack ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Could not create a 2d canvas context.');
  return ctx;
}

/**
 * The segmented path's canvas. Segments arrive row by row at the scroll
 * offsets the page reached; each one is drawn into the whole-page image
 * (scaled when the page is past Chrome's limits) and into every slice it
 * overlaps. A slice is encoded and released as soon as the rows have moved
 * past its bottom edge, so a 100-screen page never holds 100 screens of
 * pixels.
 */
export class PageCanvas {
  readonly scale: number;
  readonly wholeSize: { width: number; height: number };
  private readonly whole: OffscreenCanvas;
  private readonly wholeCtx: OffscreenCanvasRenderingContext2D;
  private readonly plan: SlicePlanEntry[] | null;
  private readonly open = new Map<number, OffscreenCanvasRenderingContext2D>();
  private readonly encoded: CaptureSlice[] = [];
  private next = 0;

  constructor(
    private readonly width: number,
    height: number,
    private readonly format: CaptureFormat,
    withSlices: boolean,
  ) {
    this.scale = wholeImageScale(width, height);
    this.wholeSize = scaledSize(width, height, this.scale);
    this.whole = new OffscreenCanvas(this.wholeSize.width, this.wholeSize.height);
    this.wholeCtx = context(this.whole);
    this.wholeCtx.imageSmoothingQuality = 'high';
    this.plan = withSlices ? planSlices(width, height) : null;
  }

  async add(x: number, y: number, pngBase64: string): Promise<void> {
    // Rows only move down, so a slice whose bottom is above this row is final.
    await this.closeAbove(y);
    const bitmap = await createImageBitmap(base64ToBlob(pngBase64, 'image/png'));
    try {
      if (this.scale === 1) {
        this.wholeCtx.drawImage(bitmap, x, y);
      } else {
        // Rounded outward: neighbouring segments overlap by under a pixel
        // instead of leaving a hairline of unpainted canvas between them,
        // which encodes as a black line in JPEG.
        const s = this.scale;
        const left = Math.floor(x * s);
        const top = Math.floor(y * s);
        const right = Math.ceil((x + bitmap.width) * s);
        const bottom = Math.ceil((y + bitmap.height) * s);
        this.wholeCtx.drawImage(bitmap, left, top, right - left, bottom - top);
      }
      if (this.plan) {
        for (let i = this.next; i < this.plan.length; i++) {
          const slice = this.plan[i];
          if (slice.top >= y + bitmap.height) break;
          if (slice.top + slice.height <= y) continue;
          this.sliceContext(i).drawImage(bitmap, x, y - slice.top);
        }
      }
    } finally {
      bitmap.close();
    }
  }

  /**
   * `paintedHeight` (canvas rows, before any scale) crops the whole image to
   * the rows that were actually drawn. The scroll-and-stitch path allocates
   * for the length the page had when it started; a page that gets shorter
   * while it scrolls would otherwise end in unpainted rows, which encode as
   * black in JPEG. With slices the whole image is cropped the same way; the
   * caller drops slices that start below the painted rows.
   */
  async finish(paintedHeight?: number): Promise<{ imageBase64: string; slices: CaptureSlice[] }> {
    await this.closeAbove(Number.POSITIVE_INFINITY);
    let canvas = this.whole;
    if (paintedHeight !== undefined) {
      const rows = Math.max(1, Math.min(this.wholeSize.height, Math.round(paintedHeight * this.scale)));
      if (rows < this.wholeSize.height) {
        canvas = new OffscreenCanvas(this.wholeSize.width, rows);
        context(canvas).drawImage(this.whole, 0, 0);
      }
    }
    const imageBase64 = await encode(canvas, this.format);
    return { imageBase64, slices: this.encoded };
  }

  private sliceContext(index: number): OffscreenCanvasRenderingContext2D {
    let ctx = this.open.get(index);
    if (!ctx) {
      const slice = (this.plan as SlicePlanEntry[])[index];
      // Read back row by row by the margin trim; the hint keeps the pixels
      // on the CPU so each read is not a GPU round trip.
      ctx = context(new OffscreenCanvas(this.width, slice.height), true);
      this.open.set(index, ctx);
    }
    return ctx;
  }

  private async closeAbove(y: number): Promise<void> {
    if (!this.plan) return;
    while (this.next < this.plan.length) {
      const slice = this.plan[this.next];
      if (slice.top + slice.height > y) return;
      // A slice no segment reached is still written, blank, so the numbering
      // and the report's y ranges stay exact.
      const ctx = this.sliceContext(this.next);
      this.encoded.push(await encodeSlice(ctx.canvas as OffscreenCanvas, this.format, slice));
      this.open.delete(this.next);
      this.next += 1;
    }
  }
}

/**
 * Slices of an image that already exists - the single-shot path, which
 * captures in one go. Empty when the image is short enough to read whole.
 */
export async function sliceEncodedImage(
  imageBase64: string,
  format: CaptureFormat,
): Promise<CaptureSlice[]> {
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const bitmap = await createImageBitmap(base64ToBlob(imageBase64, mime));
  try {
    const plan = planSlices(bitmap.width, bitmap.height);
    if (!plan) return [];
    const slices: CaptureSlice[] = [];
    for (const slice of plan) {
      const canvas = new OffscreenCanvas(bitmap.width, slice.height);
      context(canvas, true).drawImage(bitmap, 0, -slice.top);
      slices.push(await encodeSlice(canvas, format, slice));
    }
    return slices;
  } finally {
    bitmap.close();
  }
}

/** File name of slice `index` (0-based): slice-01.jpg. */
export function sliceFilename(index: number, format: CaptureFormat): string {
  return `slice-${String(index + 1).padStart(2, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}
