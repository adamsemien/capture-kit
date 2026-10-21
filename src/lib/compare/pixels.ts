/*
 * Before/after, the picture half: where two captures of the same page differ.
 *
 * Both images are reduced to the same small width first (see compare/index),
 * then compared in square cells. A cell counts as changed when enough of its
 * pixels moved by more than a threshold, which ignores JPEG noise and
 * anti-aliasing but catches a moved button, a new banner or a missing row.
 * Changed cells are merged into boxes so the report can say "3 areas changed"
 * and where, rather than listing a grid. Pure functions over RGBA arrays.
 */

export const CELL = 12;
/** Average channel difference (0-255) for a pixel to count as different. */
export const PIXEL_THRESHOLD = 28;
/** Share of a cell's pixels that must differ for the cell to count. */
export const CELL_SHARE = 0.08;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Changed cells for two RGBA images of the same width, compared over the
 * rows both have. Returns a row-major boolean grid.
 */
export function changedCells(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
): { cols: number; rows: number; grid: Uint8Array } {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const grid = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const x1 = Math.min(width, x0 + CELL);
      const y1 = Math.min(height, y0 + CELL);
      let diff = 0;
      const total = (x1 - x0) * (y1 - y0);
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const d =
            Math.abs(before[i] - after[i]) +
            Math.abs(before[i + 1] - after[i + 1]) +
            Math.abs(before[i + 2] - after[i + 2]);
          if (d > PIXEL_THRESHOLD * 3) diff += 1;
        }
      }
      if (total > 0 && diff / total >= CELL_SHARE) grid[cy * cols + cx] = 1;
    }
  }
  return { cols, rows, grid };
}

/**
 * Merge changed cells into boxes: 8-connected regions, then any boxes that
 * touch or sit within one cell of each other are joined, so a changed
 * paragraph reads as one area instead of a scatter of glyphs. Boxes are in
 * the compared image's pixels, largest first.
 */
export function mergeCells(cols: number, rows: number, grid: Uint8Array): Box[] {
  const seen = new Uint8Array(grid.length);
  const boxes: Box[] = [];
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % cols;
      const y = (i - x) / cols;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (grid[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  // Join boxes within one cell of each other until nothing changes.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (
          a.x <= b.x + b.width + 1 &&
          b.x <= a.x + a.width + 1 &&
          a.y <= b.y + b.height + 1 &&
          b.y <= a.y + a.height + 1
        ) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          boxes[i] = {
            x,
            y,
            width: Math.max(a.x + a.width, b.x + b.width) - x,
            height: Math.max(a.y + a.height, b.y + b.height) - y,
          };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes
    .map((b) => ({ x: b.x * CELL, y: b.y * CELL, width: b.width * CELL, height: b.height * CELL }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Share of compared cells that changed, 0-1. */
export function changedShare(grid: Uint8Array): number {
  if (grid.length === 0) return 0;
  let n = 0;
  for (const v of grid) n += v;
  return n / grid.length;
}
