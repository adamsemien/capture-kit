import type { CaptureFormat, CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { JPEG_QUALITY, SINGLE_SHOT_SURFACE_LIMIT } from './types';
import { SegmentCanvas, clampDimensions, planScrollOffsets } from './segments';

export const CDP_VERSION = '1.3';

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

export async function sendCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand(target, method, params)) as unknown as T;
}

export async function evaluateInPage<T>(
  target: chrome.debugger.Debuggee,
  expression: string,
): Promise<T> {
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

function scrollAndSettleScript(x: number, y: number, settleMs = 0): string {
  return `(async () => {
    window.scrollTo({ left: ${x}, top: ${y}, behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    ${settleMs > 0 ? `await new Promise((resolve) => setTimeout(resolve, ${settleMs}));` : ''}
    return { x: window.scrollX, y: window.scrollY };
  })()`;
}

// Extra per-segment settle so IntersectionObserver-driven reveal states
// commit before the segment is captured (reveal handlers run after the
// scroll, and with transitions frozen the final state applies in one frame —
// the delay covers the observer callback + style recalc).
const SEGMENT_SETTLE_MS = 120;
const REVEAL_SETTLE_MS = 90;
const MAX_REVEAL_STEPS = 30;

// Scroll-reveal neutralization. Pages that reveal sections on scroll
// (IntersectionObserver toggling opacity/transform) captured those sections
// black/empty. During capture: freeze all animations/transitions, run one
// scroll pass through the page so observers fire naturally, then force the
// stragglers that are still computed-hidden — specific elements only, never
// a blanket *{opacity:1}, which would reveal intentionally hidden UI.
const FREEZE_SCRIPT = `(() => {
  if (document.getElementById('__capture_kit_freeze__')) return;
  const style = document.createElement('style');
  style.id = '__capture_kit_freeze__';
  style.textContent = '*{animation:none !important;transition:none !important;}';
  document.documentElement.appendChild(style);
})()`;

const UNFREEZE_SCRIPT = `(() => {
  const style = document.getElementById('__capture_kit_freeze__');
  if (style) style.remove();
})()`;

const FORCE_REVEAL_SCRIPT = `(() => {
  const ATTR = 'data-capture-kit-force-reveal';
  const STYLE_ID = '__capture_kit_force_reveal__';
  let count = 0;
  for (const el of document.querySelectorAll('*')) {
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position === 'fixed') continue;
    if (cs.display === 'none') continue;
    const hidden = parseFloat(cs.opacity) === 0 || cs.visibility === 'hidden';
    if (!hidden) continue;
    el.setAttribute(ATTR, '');
    count += 1;
  }
  if (count > 0 && !document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '[' + ATTR + ']{opacity:1 !important;visibility:visible !important;transform:none !important;}';
    document.documentElement.appendChild(style);
  }
  return count;
})()`;

const UNFORCE_REVEAL_SCRIPT = `(() => {
  const style = document.getElementById('__capture_kit_force_reveal__');
  if (style) style.remove();
  for (const el of document.querySelectorAll('[data-capture-kit-force-reveal]')) {
    el.removeAttribute('data-capture-kit-force-reveal');
  }
})()`;

// One pass down the page in real-viewport steps so IntersectionObservers
// fire for every section (capped — the residual force catches anything a
// coarse pass skips on extremely tall pages).
async function revealScrollPass(target: chrome.debugger.Debuggee): Promise<void> {
  const viewport = await evaluateInPage<number>(target, 'window.innerHeight || 800');
  const size = await readContentSize(target);
  const maxY = Math.max(0, size.height - viewport);
  if (maxY === 0) return;
  const stepCount = Math.min(MAX_REVEAL_STEPS, Math.ceil(maxY / viewport) + 1);
  const stride = maxY / Math.max(1, stepCount - 1);
  for (let i = 0; i < stepCount; i++) {
    await evaluateInPage<ScrollPosition>(
      target,
      scrollAndSettleScript(0, Math.round(i * stride), REVEAL_SETTLE_MS),
    );
  }
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
 * Post-attach capture core: measure the page, then single-shot or segmented.
 * Exposed separately from the strategy so callers that hold their own
 * debugger attachment (the responsive sweep) can reuse the pipeline —
 * Emulation overrides reset on detach, and a second attach on the same tab
 * throws.
 */
export async function captureAttached(
  target: chrome.debugger.Debuggee,
  request: CaptureRequest,
): Promise<CaptureResult> {
  const originalScroll = await evaluateInPage<ScrollPosition>(
    target,
    '({ x: window.scrollX, y: window.scrollY })',
  );
  let frozen = false;
  let revealForced = 0;
  try {
    await evaluateInPage<void>(target, FREEZE_SCRIPT);
    frozen = true;
    await revealScrollPass(target);
    revealForced = await evaluateInPage<number>(target, FORCE_REVEAL_SCRIPT);

    // Measure AFTER reveal handling — forcing transform:none on translated
    // reveal elements can change the layout height.
    const contentSize = await readContentSize(target);
    // The one-shot surface is allocated at devicePixelRatio, so the safe
    // ceiling is SINGLE_SHOT_SURFACE_LIMIT device px per axis — on Retina
    // (DPR 2) a ~9k CSS-px page overflows it and comes back all black.
    // The segmented path is immune (deviceScaleFactor: 1 override).
    const dpr = await evaluateInPage<number>(target, 'window.devicePixelRatio || 1');
    const surfaceCap = Math.floor(SINGLE_SHOT_SURFACE_LIMIT / Math.max(1, dpr || 1));
    const singleShotCap = Math.min(request.segmentSize, surfaceCap);
    const fitsInOneShot =
      contentSize.width <= singleShotCap && contentSize.height <= singleShotCap;
    const result = fitsInOneShot
      ? await captureSingleShot(target, contentSize, request.format)
      : await captureSegmented(target, contentSize, request);
    return { ...result, revealForced };
  } finally {
    if (revealForced > 0) {
      try {
        await evaluateInPage<void>(target, UNFORCE_REVEAL_SCRIPT);
      } catch {
        /* page navigated away mid-capture */
      }
    }
    if (frozen) {
      try {
        await evaluateInPage<void>(target, UNFREEZE_SCRIPT);
      } catch {
        /* best-effort restore */
      }
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

// An origin clip combined with captureBeyondViewport is reliable, and
// clip.scale: 1 pins the output to CSS pixels regardless of
// devicePixelRatio. Non-origin clips are NOT reliable with
// captureBeyondViewport (documented Chromium bugs: the clip gets ignored
// and the visible viewport is captured instead) — which is why the
// segmented path below never uses clip at all.
async function captureSingleShot(
  target: chrome.debugger.Debuggee,
  contentSize: { width: number; height: number },
  format: CaptureFormat,
): Promise<CaptureResult> {
  const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
    ...(format === 'jpeg' ? { format: 'jpeg', quality: JPEG_QUALITY } : { format: 'png' }),
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
  });
  return {
    imageBase64: shot.data,
    format,
    mode: 'standard',
    fullSize: contentSize,
    contentSize,
    truncated: false,
    segments: 1,
    revealForced: 0,
  };
}

// Boring reliable segmented path: override the viewport to segment size at
// deviceScaleFactor 1, scroll to each offset, capture the plain visible
// viewport (no clip, no captureBeyondViewport), and place each shot at the
// scroll offset the page actually reached (edge segments clamp, producing
// harmless identical-content overlap). Metrics, scroll position, and
// sticky neutralization are all restored in the finally block.
async function captureSegmented(
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
          scrollAndSettleScript(x, y, SEGMENT_SETTLE_MS),
        );
        const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
          format: 'png',
        });
        // Sequential on purpose: bounded memory, one decoded segment at a time.
        await canvas.add(Math.round(reached.x), Math.round(reached.y), shot.data);
        segments += 1;
      }
    }

    // Segments are always captured as PNG (lossless intermediates); the
    // joined canvas encodes once into the requested output format.
    return {
      imageBase64: await canvas.toBase64(request.format),
      format: request.format,
      mode: 'standard',
      fullSize: { width, height },
      contentSize: naturalSize,
      truncated,
      segments,
      revealForced: 0,
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
      return await captureAttached(target, request);
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
