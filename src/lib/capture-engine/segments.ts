// Chrome's canvas limits: ~32,767px per dimension and ~2^28 px² of area.
// Beyond these, canvas creation or drawing fails silently with blank output.
// slices.ts scales the whole-page image to fit inside them (NOBC-161).
export const CANVAS_MAX_DIMENSION = 32767;
export const CANVAS_MAX_AREA = 1 << 28; // 268,435,456 px²

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
