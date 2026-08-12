import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { SegmentCanvas, clampDimensions, planScrollOffsets } from './segments';

const CDP_VERSION = '1.3';

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
}

interface ScreenshotResult {
  data: string;
}

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string };
}

interface ScrollPosition {
  x: number;
  y: number;
}

async function sendCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand(target, method, params)) as unknown as T;
}

async function evaluateInPage<T>(target: chrome.debugger.Debuggee, expression: string): Promise<T> {
  const response = await sendCommand<EvaluateResult<T>>(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error('In-page helper script failed during capture.');
  }
  return response.result?.value as T;
}

async function readContentSize(
  target: chrome.debugger.Debuggee,
): Promise<{ width: number; height: number }> {
  const metrics = await sendCommand<LayoutMetrics>(target, 'Page.getLayoutMetrics');
  const raw = metrics.cssContentSize ?? metrics.contentSize;
  if (!raw || !raw.width || !raw.height) {
    throw new Error('Page reported no measurable content size.');
  }
  return { width: Math.ceil(raw.width), height: Math.ceil(raw.height) };
}

function scrollAndSettleScript(x: number, y: number): string {
  return `(async () => {
    window.scrollTo({ left: ${x}, top: ${y}, behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { x: window.scrollX, y: window.scrollY };
  })()`;
}

// Sticky/fixed neutralization for the scroll-based segmented path. Without
// this, every segment repeats the page's sticky headers — exactly the
// GoFullPage artifact this extension exists to kill. Fixed elements are
// re-anchored as absolute (stay out of flow, paint once near the top of the
// page); sticky elements become static (already in flow, paint at their
// natural position). Marker attributes + one injected stylesheet, both
// removed after capture.
const UNSTICK_SCRIPT = `(() => {
  if (document.getElementById('__capture_kit_unstick__')) return;
  const style = document.createElement('style');
  style.id = '__capture_kit_unstick__';
  style.textContent =
    '[data-capture-kit-position="fixed"]{position:absolute !important;}' +
    '[data-capture-kit-position="sticky"]{position:static !important;}';
  document.documentElement.appendChild(style);
  for (const el of document.querySelectorAll('*')) {
    try {
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') {
        el.setAttribute('data-capture-kit-position', position);
      }
    } catch {}
  }
})()`;

const RESTICK_SCRIPT = `(() => {
  const style = document.getElementById('__capture_kit_unstick__');
  if (style) style.remove();
  for (const el of document.querySelectorAll('[data-capture-kit-position]')) {
    el.removeAttribute('data-capture-kit-position');
  }
})()`;

/**
 * True one-shot full-page capture over the Chrome DevTools Protocol — no
 * scroll-and-stitch for pages within the segment cap. Oversized pages use a
 * virtual-viewport scroll strategy (see captureSegmented).
 */
export class CdpFullPageStrategy implements CaptureStrategy {
  readonly name = 'cdp-fullpage';

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const target: chrome.debugger.Debuggee = { tabId: request.tabId };
    await chrome.debugger.attach(target, CDP_VERSION);
    try {
      const contentSize = await readContentSize(target);
      const fitsInOneShot =
        contentSize.width <= request.segmentSize && contentSize.height <= request.segmentSize;
      return fitsInOneShot
        ? await this.captureSingleShot(target, contentSize)
        : await this.captureSegmented(target, contentSize, request);
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

  // An origin clip combined with captureBeyondViewport is reliable, and
  // clip.scale: 1 pins the output to CSS pixels regardless of
  // devicePixelRatio. Non-origin clips are NOT reliable with
  // captureBeyondViewport (documented Chromium bugs: the clip gets ignored
  // and the visible viewport is captured instead) — which is why the
  // segmented path below never uses clip at all.
  private async captureSingleShot(
    target: chrome.debugger.Debuggee,
    contentSize: { width: number; height: number },
  ): Promise<CaptureResult> {
    const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
    });
    return {
      pngBase64: shot.data,
      fullSize: contentSize,
      contentSize,
      truncated: false,
      segments: 1,
    };
  }

  // Boring reliable segmented path: override the viewport to segment size at
  // deviceScaleFactor 1, scroll to each offset, capture the plain visible
  // viewport (no clip, no captureBeyondViewport), and place each shot at the
  // scroll offset the page actually reached (edge segments clamp, producing
  // harmless identical-content overlap). Metrics, scroll position, and
  // sticky neutralization are all restored in the finally block.
  private async captureSegmented(
    target: chrome.debugger.Debuggee,
    naturalSize: { width: number; height: number },
    request: CaptureRequest,
  ): Promise<CaptureResult> {
    const originalScroll = await evaluateInPage<ScrollPosition>(
      target,
      '({ x: window.scrollX, y: window.scrollY })',
    );

    await sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: Math.min(naturalSize.width, request.segmentSize),
      height: Math.min(naturalSize.height, request.segmentSize),
      deviceScaleFactor: 1,
      mobile: false,
    });
    let unstuck = false;
    try {
      await evaluateInPage<void>(target, UNSTICK_SCRIPT);
      unstuck = true;

      // The virtual viewport can change layout (vh units, media queries), so
      // re-measure before planning the grid.
      const overriddenSize = await readContentSize(target);
      const { width, height, truncated } = clampDimensions(
        overriddenSize.width,
        overriddenSize.height,
      );
      const viewportWidth = Math.min(width, request.segmentSize);
      const viewportHeight = Math.min(height, request.segmentSize);
      const xOffsets = planScrollOffsets(width, viewportWidth);
      const yOffsets = planScrollOffsets(height, viewportHeight);

      const canvas = new SegmentCanvas(width, height);
      let segments = 0;
      for (const y of yOffsets) {
        for (const x of xOffsets) {
          const reached = await evaluateInPage<ScrollPosition>(
            target,
            scrollAndSettleScript(x, y),
          );
          const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
            format: 'png',
          });
          // Sequential on purpose: bounded memory, one decoded segment at a time.
          await canvas.add(Math.round(reached.x), Math.round(reached.y), shot.data);
          segments += 1;
        }
      }

      return {
        pngBase64: await canvas.toPngBase64(),
        fullSize: { width, height },
        contentSize: naturalSize,
        truncated,
        segments,
      };
    } finally {
      if (unstuck) {
        try {
          await evaluateInPage<void>(target, RESTICK_SCRIPT);
        } catch {
          /* page navigated away mid-capture */
        }
      }
      try {
        await sendCommand(target, 'Emulation.clearDeviceMetricsOverride');
      } catch {
        /* best-effort restore */
      }
      try {
        await evaluateInPage<void>(
          target,
          `window.scrollTo(${originalScroll.x}, ${originalScroll.y})`,
        );
      } catch {
        /* best-effort restore */
      }
    }
  }
}
