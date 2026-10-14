import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';
import { InnerScrollExpansionStrategy, detectInnerScroll } from './inner-scroll';
import { stampCaptureResult } from './stamp';

export type {
  CaptureFormat,
  CaptureMode,
  CaptureProgress,
  CaptureRequest,
  CaptureResult,
  CaptureStrategy,
  PageDimensions,
  StampInfo,
  StampRequest,
} from './types';
export { bandHeight, stampCaptureResult, stampLabel } from './stamp';

/**
 * Per-capture strategy picker. Pages where the document barely scrolls but a
 * inner scrollers hold the content (Notion, Linear, Airtable, multi-column app
 * shells) get
 * the expansion strategy; everything else gets the plain CDP pipeline.
 */
export async function getCaptureStrategy(tabId: number): Promise<CaptureStrategy> {
  return (await detectInnerScroll(tabId))
    ? new InnerScrollExpansionStrategy()
    : new CdpFullPageStrategy();
}

export async function captureFullPage(request: CaptureRequest): Promise<CaptureResult> {
  const strategy = await getCaptureStrategy(request.tabId);
  const result = await strategy.capture(request);
  // The one place the footer can be applied on this path, and it is strictly
  // after the strategy has returned — meaning after every segment was taken
  // and after the debugger detached. With the setting off this is a single
  // falsy check and the pipeline is byte-for-byte what it was before.
  if (!request.stamp) return result;
  return stampCaptureResult(result, request.stamp);
}
