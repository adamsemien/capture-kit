/*
 * Before/after (NOBC-82): compare a capture with the last capture of the same
 * page and say what changed - in the picture, in the console, in the network.
 *
 * The point is the loop an engineer or an agent runs while fixing something:
 * capture, change code, capture again, and get told "this area moved, this
 * error is gone, this request still fails" instead of eyeballing two images.
 *
 * Runs in the service worker after the capture has finished. Any failure here
 * skips the comparison; it never fails the capture.
 */

import type { ConsoleEntry, NetworkFailure } from '../messages';
import { base64ToBlob, blobToBase64 } from '../base64';
import { CELL, changedCells, changedShare, mergeCells, type Box } from './pixels';
import { diffSigned, errorSignature, failureSignature, pageKey, type SetDiff } from './signatures';
import { getPage, putPage, type PageRecord } from './store';

/** Width of the stored copy and of the comparison, in image px. */
/** Page-width difference still compared: a classic scrollbar is 15-17 px. */
export const SCROLLBAR_SLACK = 24;
export const COMPARE_WIDTH = 480;
/** Rows of the stored copy kept, in its own px - about 13 screens of a laptop page. */
export const THUMB_MAX_HEIGHT = 8000;
/** Boxes listed in the report; the image shows all of them. */
export const MAX_BOXES_LISTED = 8;

export type PictureComparison =
  | {
      compared: true;
      /** Share of the compared area that changed, 0-1. */
      share: number;
      /** Changed areas in CSS px of the page, largest first. */
      boxes: Box[];
      heightBefore: number;
      heightAfter: number;
      /**
       * How far down the page was compared, CSS px, when that is not all of
       * it: the small copy stops at THUMB_MAX_HEIGHT rows, so the bottom of a
       * very tall page is not compared and the report says so (Codex review
       * on #29).
       */
      comparedTo?: number;
      /** Set once the outlined copy has been written. */
      diffImageFilename?: string;
    }
  | { compared: false; reason: string };

export interface ChangeSummary {
  previous: { capturedAt: number; imageFilename: string };
  picture: PictureComparison;
  errors: SetDiff;
  failures: SetDiff;
}

export interface CompareInput {
  url: string;
  capturedAt: Date;
  imageBase64: string;
  imageMime: string;
  /** Page size the image depicts, CSS px (excludes any URL footer). */
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  consoleEntries: ConsoleEntry[];
  networkFailures: NetworkFailure[];
}

export interface Comparison {
  /** Null on the first capture of a page. */
  summary: ChangeSummary | null;
  /** PNG, base64: the new capture's small copy with changed areas outlined. Null when nothing changed. */
  diffImageBase64: string | null;
  /** Store this capture as the one the next capture of the page is compared with. */
  save(imageFilename: string): Promise<void>;
}

interface Thumb {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

async function makeThumb(input: CompareInput): Promise<Thumb> {
  const bitmap = await createImageBitmap(base64ToBlob(input.imageBase64, input.imageMime));
  try {
    const iw = bitmap.width;
    // Image rows that are page, not the URL footer: the footer changes every
    // capture (it carries the time) and must never count as a change.
    const pageRows = Math.min(bitmap.height, Math.round(input.pageHeight * (iw / Math.max(1, input.pageWidth))));
    const width = Math.min(COMPARE_WIDTH, iw);
    const s = width / iw;
    const height = Math.max(1, Math.min(THUMB_MAX_HEIGHT, Math.round(pageRows * s)));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, iw, height / s, 0, 0, width, height);
    return { canvas, width, height };
  } finally {
    bitmap.close();
  }
}

function pixelsOf(canvas: OffscreenCanvas, width: number, height: number): Uint8ClampedArray {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  return ctx.getImageData(0, 0, width, height).data;
}

async function comparePictures(
  prev: PageRecord,
  cur: Thumb,
  input: CompareInput,
): Promise<{ picture: PictureComparison; diff: string | null }> {
  // A page that grows past one screen gains a scrollbar and narrows by its
  // width; that is the same layout, not a different one, so a difference
  // that small is still compared.
  if (prev.viewportWidth !== input.viewportWidth || Math.abs(prev.pageWidth - input.pageWidth) > SCROLLBAR_SLACK) {
    return {
      picture: {
        compared: false,
        reason:
          prev.viewportWidth !== input.viewportWidth
            ? `the window was a different width (${prev.viewportWidth} px then, ${input.viewportWidth} px now)`
            : `the page was a different width (${prev.pageWidth} px then, ${input.pageWidth} px now)`,
      },
      diff: null,
    };
  }
  if (prev.thumbWidth !== cur.width) {
    return { picture: { compared: false, reason: 'the two images were taken at different sizes' }, diff: null };
  }
  const before = await createImageBitmap(prev.thumb);
  const rows = Math.min(prev.thumbHeight, cur.height);
  let a: Uint8ClampedArray;
  try {
    const c = new OffscreenCanvas(cur.width, rows);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(before, 0, 0);
    a = ctx.getImageData(0, 0, cur.width, rows).data;
  } finally {
    before.close();
  }
  const b = pixelsOf(cur.canvas, cur.width, rows);
  const { cols, rows: gridRows, grid } = changedCells(a, b, cur.width, rows);
  const thumbBoxes = mergeCells(cols, gridRows, grid);
  const k = input.pageWidth / cur.width;
  const boxes = thumbBoxes.map((box) => ({
    x: Math.round(box.x * k),
    y: Math.round(box.y * k),
    width: Math.round(Math.min(box.width, cur.width - box.x) * k),
    height: Math.round(Math.min(box.height, rows - box.y) * k),
  }));
  const comparedTo = Math.round(rows * k);
  const picture: PictureComparison = {
    compared: true,
    share: changedShare(grid),
    boxes,
    heightBefore: prev.pageHeight,
    heightAfter: input.pageHeight,
    // Short of the shorter page by more than a cell: only the top was compared.
    ...(comparedTo < Math.min(prev.pageHeight, input.pageHeight) - CELL * k ? { comparedTo } : {}),
  };
  if (thumbBoxes.length === 0) return { picture, diff: null };

  // The new capture's small copy, changed cells tinted and each area outlined.
  const out = new OffscreenCanvas(cur.width, cur.height);
  const ctx = out.getContext('2d');
  if (!ctx) return { picture, diff: null };
  ctx.drawImage(cur.canvas, 0, 0);
  ctx.fillStyle = 'rgba(233, 30, 99, 0.28)';
  for (let cy = 0; cy < gridRows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (grid[cy * cols + cx]) ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }
  ctx.strokeStyle = 'rgb(233, 30, 99)';
  ctx.lineWidth = 2;
  for (const box of thumbBoxes) ctx.strokeRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2);
  const png = await out.convertToBlob({ type: 'image/png' });
  return { picture, diff: await blobToBase64(png) };
}

export async function compareCapture(input: CompareInput): Promise<Comparison> {
  const key = pageKey(input.url);
  const errors = input.consoleEntries.filter((e) => e.level === 'error').map(errorSignature);
  const failures = input.networkFailures.map(failureSignature);
  const cur = await makeThumb(input);
  let prev: PageRecord | null = null;
  try {
    prev = await getPage(key);
  } catch {
    prev = null;
  }

  let summary: ChangeSummary | null = null;
  let diffImageBase64: string | null = null;
  if (prev) {
    const { picture, diff } = await comparePictures(prev, cur, input);
    diffImageBase64 = diff;
    summary = {
      previous: { capturedAt: prev.capturedAt, imageFilename: prev.imageFilename },
      picture,
      errors: diffSigned(prev.errors, errors),
      failures: diffSigned(prev.failures, failures),
    };
  }

  return {
    summary,
    diffImageBase64,
    async save(imageFilename: string) {
      const thumb = await cur.canvas.convertToBlob({ type: 'image/png' });
      await putPage({
        key,
        url: input.url,
        capturedAt: input.capturedAt.getTime(),
        imageFilename,
        viewportWidth: input.viewportWidth,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        thumb,
        thumbWidth: cur.width,
        thumbHeight: cur.height,
        errors,
        failures,
      });
    },
  };
}
