import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';

export type {
  CaptureFormat,
  CaptureRequest,
  CaptureResult,
  CaptureStrategy,
  PageDimensions,
} from './types';

/**
 * Phase 1 ships exactly one strategy. Phase 2 (inner scrollable containers)
 * registers its strategy here and this picker chooses per capture.
 */
export function getCaptureStrategy(): CaptureStrategy {
  return new CdpFullPageStrategy();
}

export async function captureFullPage(request: CaptureRequest): Promise<CaptureResult> {
  return getCaptureStrategy().capture(request);
}
