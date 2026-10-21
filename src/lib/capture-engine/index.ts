import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';
import { InnerScrollExpansionStrategy, detectInnerScroll } from './inner-scroll';
import { ScrollStitchStrategy, detectCanvasScroller } from './scroll-stitch';
import { sliceEncodedImage } from './slices';
import { stampCaptureResult } from './stamp';

export type {
  CaptureFormat,
  CaptureMode,
  CaptureProgress,
  CaptureRequest,
  CaptureResult,
  CaptureSlice,
  CaptureStrategy,
  PageDimensions,
  ScrollStitchInfo,
  StampInfo,
  StampRequest,
} from './types';
export { bandHeight, stampCaptureResult, stampLabel } from './stamp';
export { sliceFilename, SLICE_OVERLAP } from './slices';

/**
 * Per-capture strategy picker. Pages where the document barely scrolls but a
 * inner scrollers hold the content (Notion, Linear, Airtable, multi-column app
 * shells) get
 * the expansion strategy; everything else gets the plain CDP pipeline.
 */
export async function getCaptureStrategy(tabId: number): Promise<CaptureStrategy> {
  // A canvas app repaints only what is on screen, so it has to be scrolled.
  if (await detectCanvasScroller(tabId)) return new ScrollStitchStrategy('largest', 'canvas');
  return (await detectInnerScroll(tabId))
    ? new InnerScrollExpansionStrategy()
    : new CdpFullPageStrategy();
}

export async function captureFullPage(request: CaptureRequest): Promise<CaptureResult> {
  const strategy = request.scrollStitch
    ? new ScrollStitchStrategy('pointer', 'asked')
    : await getCaptureStrategy(request.tabId);
  let result = await strategy.capture(request);
  // Expansion gave up because unrolling would have hidden the page, which
  // leaves a capture of one screen. Scrolling the panel gets all of it.
  if (result.innerScrollAbandoned) {
    try {
      result = await new ScrollStitchStrategy('largest', 'abandoned').capture(request);
    } catch {
      /* keep the one-screen capture; its report already says why */
    }
  }
  // The segmented path slices as it goes. A single-shot capture is one image
  // already, so a tall one is cut afterwards - before the footer, so slices
  // are the page and nothing else.
  if (request.slices && !result.slices) {
    const slices = await sliceEncodedImage(result.imageBase64, result.format);
    if (slices.length > 0) result = { ...result, slices };
  }
  // The one place the footer can be applied on this path, and it is strictly
  // after the strategy has returned — meaning after every segment was taken
  // and after the debugger detached. With the setting off this is a single
  // falsy check and the pipeline is byte-for-byte what it was before.
  if (!request.stamp) return result;
  return stampCaptureResult(result, request.stamp);
}
