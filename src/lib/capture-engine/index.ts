import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';
import { InnerScrollExpansionStrategy, detectInnerScroll } from './inner-scroll';

export type {
  CaptureFormat,
  CaptureMode,
  CaptureRequest,
  CaptureResult,
  CaptureStrategy,
  PageDimensions,
} from './types';

/**
 * Per-capture strategy picker. Pages where the document barely scrolls but a
 * dominant inner scroller holds the content (Notion, Linear, Airtable) get
 * the expansion strategy; everything else gets the plain CDP pipeline.
 */
export async function getCaptureStrategy(tabId: number): Promise<CaptureStrategy> {
  return (await detectInnerScroll(tabId))
    ? new InnerScrollExpansionStrategy()
    : new CdpFullPageStrategy();
}

export async function captureFullPage(request: CaptureRequest): Promise<CaptureResult> {
  const strategy = await getCaptureStrategy(request.tabId);
  return strategy.capture(request);
}
