import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { SegmentCanvas, clampDimensions, planSegments, type SegmentRect } from './segments';

const CDP_VERSION = '1.3';

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
}

interface ScreenshotResult {
  data: string;
}

async function sendCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand(target, method, params)) as unknown as T;
}

async function captureClip(target: chrome.debugger.Debuggee, rect: SegmentRect): Promise<string> {
  const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    // scale: 1 locks output to CSS pixels so segment offsets stay exact
    // regardless of device pixel ratio.
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  return shot.data;
}

/**
 * True one-shot full-page capture over the Chrome DevTools Protocol — no
 * scroll-and-stitch. Oversized pages are captured as clipped segments and
 * joined by coarse rectangle placement.
 */
export class CdpFullPageStrategy implements CaptureStrategy {
  readonly name = 'cdp-fullpage';

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const target: chrome.debugger.Debuggee = { tabId: request.tabId };
    await chrome.debugger.attach(target, CDP_VERSION);
    try {
      const metrics = await sendCommand<LayoutMetrics>(target, 'Page.getLayoutMetrics');
      const raw = metrics.cssContentSize ?? metrics.contentSize;
      if (!raw || !raw.width || !raw.height) {
        throw new Error('Page reported no measurable content size.');
      }
      const contentSize = { width: Math.ceil(raw.width), height: Math.ceil(raw.height) };
      const { width, height, truncated } = clampDimensions(contentSize.width, contentSize.height);
      const rects = planSegments(width, height, request.segmentSize);

      if (rects.length === 1) {
        const data = await captureClip(target, rects[0]);
        return {
          pngBase64: data,
          fullSize: { width, height },
          contentSize,
          truncated,
          segments: 1,
        };
      }

      const canvas = new SegmentCanvas(width, height);
      for (const rect of rects) {
        // Sequential on purpose: bounded memory, one decoded segment at a time.
        const data = await captureClip(target, rect);
        await canvas.add(rect, data);
      }
      return {
        pngBase64: await canvas.toPngBase64(),
        fullSize: { width, height },
        contentSize,
        truncated,
        segments: rects.length,
      };
    } finally {
      // Detach immediately, capture success or not. May already be detached
      // if the tab closed mid-capture.
      try {
        await chrome.debugger.detach(target);
      } catch {
        /* already detached */
      }
    }
  }
}
