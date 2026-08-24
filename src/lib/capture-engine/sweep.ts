import type { CaptureResult, StampRequest } from './types';
import { CDP_VERSION, captureAttached, evaluateInPage, sendCommand } from './cdp-fullpage';
import { stampCaptureResult } from './stamp';

/**
 * Responsive sweep: capture the current page at fixed widths under an
 * Emulation viewport override. One debugger attachment spans all widths —
 * overrides reset on detach, and a second attach on the same tab throws.
 * A failed width is recorded and the sweep continues with the rest.
 */

export const SWEEP_WIDTHS = [375, 768, 1440] as const;

export interface SweepCapture {
  width: number;
  result: CaptureResult;
}

export interface SweepFailure {
  width: number;
  reason: string;
}

export interface SweepOutcome {
  captures: SweepCapture[];
  failures: SweepFailure[];
}

// Double-rAF for layout, then a short timeout for media-query-driven image
// swaps (srcset/picture sources loading at the new width).
const SETTLE_SCRIPT = `(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 350));
  return true;
})()`;

export async function captureSweep(
  tabId: number,
  segmentSize: number,
  /** Present only when "Stamp URL on image" is on; every width gets the footer. */
  stamp?: StampRequest,
): Promise<SweepOutcome> {
  const target: chrome.debugger.Debuggee = { tabId };
  await chrome.debugger.attach(target, CDP_VERSION);
  const captures: SweepCapture[] = [];
  const failures: SweepFailure[] = [];
  try {
    for (const width of SWEEP_WIDTHS) {
      try {
        // height: 0 = keep the tab's real viewport height; the capture core
        // re-measures full layout height itself.
        await sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
          width,
          height: 0,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluateInPage<boolean>(target, SETTLE_SCRIPT);
        const result = await captureAttached(target, { tabId, segmentSize, format: 'jpeg' });
        // Same seam as captureFullPage, one function, applied per width. The
        // sweep cannot route through captureFullPage: one debugger attachment
        // has to span all three widths, and captureFullPage attaches its own.
        captures.push({ width, result: stamp ? await stampCaptureResult(result, stamp) : result });
      } catch (error) {
        failures.push({
          width,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    try {
      await sendCommand(target, 'Emulation.clearDeviceMetricsOverride');
    } catch {
      /* best-effort restore */
    }
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* already detached */
    }
  }
  return { captures, failures };
}
