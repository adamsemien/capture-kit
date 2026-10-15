/**
 * The clipboard accepts image/png only, and the default capture format is
 * JPEG, so every image copy re-encodes. Shared by the result page and the
 * service worker - both have OffscreenCanvas and createImageBitmap.
 */

/** The size this product already calls a very large PNG (result tab warning). */
export const LARGE_PNG_BYTES = 10 * 1024 * 1024;

function drawToPng(bitmap: ImageBitmap, scale: number): Promise<Blob> {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a canvas to re-encode with.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Encode at native size first, then look at what came out. PNG size tracks
 * content rather than dimensions - flat UI compresses to almost nothing, a
 * photo does not - so a pixel cap guesses at the wrong variable. Downscaling
 * is also the expensive branch: on a real 1863x4568 capture, capping the long
 * edge saved 14% of the bytes and cost 75% more time. So it is only a
 * backstop against a pathological page. One retry, never a loop.
 */
export async function toClipboardPng(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const png = await drawToPng(bitmap, 1);
    if (png.size <= LARGE_PNG_BYTES) return png;
    return await drawToPng(bitmap, Math.sqrt(LARGE_PNG_BYTES / png.size));
  } finally {
    bitmap.close();
  }
}
