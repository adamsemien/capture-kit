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

// Sticky/fixed neutralization, applied to BOTH capture paths. A full-page
// capture should look like the page would if it were infinitely tall and
// never scrolled, so sticky and fixed chrome must paint once, where it sits
// on an unscrolled page. On the segmented path, leaving it alone repeats the
// header in every segment — the GoFullPage artifact this extension exists to
// kill. On the single-shot path it is worse and quieter: captureBeyondViewport
// resolves sticky/fixed once, at whatever scroll offset the reveal pass left
// behind, and bakes the header two thirds of the way down the image.
//
// sticky -> static: already in flow, so it paints at its natural position.
// fixed -> absolute: still out of flow, but where absolute lands depends on
// the containing block, and the two paths disagree about that (single-shot
// expands the viewport, segmented overrides it) — a bottom-pinned bar would
// land in two different places. So when an element's box can be established
// in its containing block's coordinates, its exact unscrolled box is pinned
// instead. When it cannot — anything transformed, scaled, or zero-sized — it
// gets a bare position:absolute with every offset left untouched. A displaced
// element is worse than an unfixed one: it reads as intentional.
//
// Re-runnable: it only touches elements it has not already marked, so the
// segmented path can run it again after the device-metrics override picks up
// chrome that only becomes fixed under a media query. Marker attributes, one
// injected stylesheet, and per-element original inline style + inner scroll
// offsets recorded for restore — never a blanket rule.
const UNSTICK_SCRIPT = `(() => {
  const STYLE_ID = '__capture_kit_unstick__';
  const ATTR = 'data-capture-kit-position';
  const PREV_STYLE = 'data-capture-kit-prev-style';
  const SCROLL_ATTR = 'data-capture-kit-scroll';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '[' + ATTR + '="sticky"]{position:static !important;}' +
      '[' + ATTR + '="fixed"]{position:absolute !important;}' +
      '[' + ATTR + '="pinned"]{position:absolute !important;right:auto !important;' +
      'bottom:auto !important;box-sizing:border-box !important;}';
    document.documentElement.appendChild(style);
  }

  // Inner scrollers (a docs sidebar with its own overflow) go back to the top
  // first, so their sticky children resolve where they belong and every rect
  // measured below is the unscrolled one. Originals recorded for restore.
  for (const el of document.querySelectorAll('*')) {
    if (el.hasAttribute(SCROLL_ATTR)) continue;
    const top = el.scrollTop;
    const left = el.scrollLeft;
    if (!top && !left) continue;
    el.setAttribute(SCROLL_ATTR, top + ',' + left);
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }

  // Distorts measured geometry: a rect read inside a scaled or rotated
  // subtree cannot be turned back into a layout coordinate.
  const distorts = (cs) =>
    cs.transform !== 'none' ||
    (cs.scale && cs.scale !== 'none') ||
    (cs.rotate && cs.rotate !== 'none') ||
    (cs.translate && cs.translate !== 'none') ||
    (parseFloat(cs.zoom) || 1) !== 1;

  // Becomes the containing block for an absolutely positioned descendant.
  const formsContainingBlock = (cs) =>
    cs.position !== 'static' ||
    cs.transform !== 'none' ||
    cs.perspective !== 'none' ||
    cs.filter !== 'none' ||
    (cs.backdropFilter && cs.backdropFilter !== 'none') ||
    (cs.contain && /paint|layout|strict|content/.test(cs.contain)) ||
    (cs.contentVisibility && cs.contentVisibility !== 'visible') ||
    (cs.containerType && cs.containerType !== 'normal') ||
    (cs.willChange && /transform|perspective|filter|contain/.test(cs.willChange));

  // Measure everything before moving anything — the first reposition
  // invalidates every rect read after it.
  const targets = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.hasAttribute(ATTR)) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position === 'sticky') {
      targets.push({ el: el, kind: 'sticky' });
      continue;
    }
    if (cs.position !== 'fixed') continue;

    const rect = el.getBoundingClientRect();
    let placeable = rect.width > 0 && rect.height > 0 && !distorts(cs);
    let block = null;
    for (let node = el.parentElement; placeable && node; node = node.parentElement) {
      let acs;
      try { acs = getComputedStyle(node); } catch { placeable = false; break; }
      if (distorts(acs)) { placeable = false; break; }
      if (!block && formsContainingBlock(acs)) block = node;
    }
    if (!placeable) {
      targets.push({ el: el, kind: 'fixed' });
      continue;
    }
    // Origin of the box the element will be absolutely positioned against:
    // the containing block's padding box, or the initial containing block,
    // whose origin sits at the document origin.
    let originTop = -window.scrollY;
    let originLeft = -window.scrollX;
    if (block) {
      const blockRect = block.getBoundingClientRect();
      const blockCs = getComputedStyle(block);
      originTop = blockRect.top + (parseFloat(blockCs.borderTopWidth) || 0);
      originLeft = blockRect.left + (parseFloat(blockCs.borderLeftWidth) || 0);
    }
    targets.push({
      el: el,
      kind: 'pinned',
      top: rect.top - originTop,
      left: rect.left - originLeft,
      width: rect.width,
      height: rect.height,
    });
  }

  for (const t of targets) {
    t.el.setAttribute(ATTR, t.kind);
    if (t.kind !== 'pinned') continue;
    t.el.setAttribute(PREV_STYLE, JSON.stringify(t.el.getAttribute('style')));
    t.el.style.setProperty('top', t.top + 'px', 'important');
    t.el.style.setProperty('left', t.left + 'px', 'important');
    t.el.style.setProperty('width', t.width + 'px', 'important');
    t.el.style.setProperty('height', t.height + 'px', 'important');
  }
  return targets.length;
})()`;

const RESTICK_SCRIPT = `(() => {
  const style = document.getElementById('__capture_kit_unstick__');
  if (style) style.remove();
  // Inline style first: the recorded value is the whole original style
  // attribute, so this drops the pinned offsets exactly, including their
  // absence on elements that had no style attribute at all.
  for (const el of document.querySelectorAll('[data-capture-kit-prev-style]')) {
    let prev = null;
    try { prev = JSON.parse(el.getAttribute('data-capture-kit-prev-style')); } catch {}
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
    el.removeAttribute('data-capture-kit-prev-style');
  }
  for (const el of document.querySelectorAll('[data-capture-kit-position]')) {
    el.removeAttribute('data-capture-kit-position');
  }
  // Scroll offsets last, once the layout they belong to is back.
  for (const el of document.querySelectorAll('[data-capture-kit-scroll]')) {
    const parts = (el.getAttribute('data-capture-kit-scroll') || '0,0').split(',');
    el.removeAttribute('data-capture-kit-scroll');
    el.scrollTop = parseFloat(parts[0]) || 0;
    el.scrollLeft = parseFloat(parts[1]) || 0;
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
  let unstuck = false;
  let revealForced = 0;
  try {
    await evaluateInPage<void>(target, FREEZE_SCRIPT);
    frozen = true;
    await revealScrollPass(target);
    // Force-reveal runs BEFORE unsticking on purpose: it skips elements that
    // are still computed position:fixed so hidden fixed UI (menus, modals)
    // is never forced visible. Unsticking first rewrites those to absolute
    // and that guard stops matching.
    revealForced = await evaluateInPage<number>(target, FORCE_REVEAL_SCRIPT);

    // Settle at the top before neutralizing, so sticky elements resolve to
    // their unstuck position and fixed chrome is measured where an unscrolled
    // visitor would see it.
    await evaluateInPage<ScrollPosition>(target, scrollAndSettleScript(0, 0, SEGMENT_SETTLE_MS));
    await evaluateInPage<number>(target, UNSTICK_SCRIPT);
    unstuck = true;

    // Measure AFTER reveal handling and neutralization — forcing
    // transform:none on translated reveal elements, and re-anchoring fixed
    // elements into the document, can both change the layout height.
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
    if (unstuck) {
      try {
        await evaluateInPage<void>(target, RESTICK_SCRIPT);
      } catch {
        /* page navigated away mid-capture */
      }
    }
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
    // No footer yet — the stamp seam runs after the debugger detaches and
    // rewrites this if the setting is on.
    imageSize: contentSize,
    truncated: false,
    segments: 1,
    revealForced: 0,
  };
}

// Boring reliable segmented path: override the viewport to segment size at
// deviceScaleFactor 1, scroll to each offset, capture the plain visible
// viewport (no clip, no captureBeyondViewport), and place each shot at the
// scroll offset the page actually reached (edge segments clamp, producing
// harmless identical-content overlap). Metrics and scroll position are
// restored in the finally block; sticky neutralization is owned by
// captureAttached, which restores it for both paths.
async function captureSegmented(
  target: chrome.debugger.Debuggee,
  naturalSize: { width: number; height: number },
  request: CaptureRequest,
): Promise<CaptureResult> {
  const originalScroll = await evaluateInPage<ScrollPosition>(
    target,
    '({ x: window.scrollX, y: window.scrollY })',
  );

  // The virtual viewport actually in force. Held in variables because the grid
  // below MUST be planned against these numbers and not against a second
  // min() of the re-measured size — see the comment at viewportWidth.
  const overrideWidth = Math.min(naturalSize.width, request.segmentSize);
  const overrideHeight = Math.min(naturalSize.height, request.segmentSize);

  await sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
    width: overrideWidth,
    height: overrideHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    // Neutralization already ran in captureAttached, but the virtual viewport
    // can make chrome fixed or sticky that was neither at the real viewport
    // width (a media-query mobile nav), so run it again against the
    // overridden layout. It skips everything it already marked, and the
    // single restore stays in captureAttached's finally.
    await evaluateInPage<ScrollPosition>(target, scrollAndSettleScript(0, 0, SEGMENT_SETTLE_MS));
    await evaluateInPage<number>(target, UNSTICK_SCRIPT);

    // The virtual viewport can change layout (vh units, media queries), so
    // re-measure before planning the grid.
    const overriddenSize = await readContentSize(target);
    const { width, height, truncated } = clampDimensions(
      overriddenSize.width,
      overriddenSize.height,
    );
    // Plan against the viewport that EXISTS, not a fresh min() of the size we
    // just re-measured. Those two disagree whenever the page's content grows
    // under the override — a page with horizontal overflow that tracks the
    // viewport (`width: calc(100% + Npx)`, a table with a fixed-width gutter)
    // reports a wider scrollWidth every time the viewport widens. When
    // segmentSize exceeds the page width, the override is naturalSize.width
    // while the re-measured width is larger, and the old
    // `Math.min(width, segmentSize)` believed the viewport covered the whole
    // canvas: one column was planned, one viewport-wide shot was taken, and
    // everything to the right of it stayed at the canvas's initial
    // transparent-black — a solid black stripe once encoded to JPEG.
    // Measured 2026-08-23: a 1608px page under a 2048px segment size produced
    // a 2016px canvas with only 1608px painted.
    const viewportWidth = overrideWidth;
    const viewportHeight = overrideHeight;
    const xOffsets = planScrollOffsets(width, viewportWidth);
    const yOffsets = planScrollOffsets(height, viewportHeight);

    const canvas = new SegmentCanvas(width, height);
    // The grid is known before the loop runs, so progress can be reported as
    // "3/7" rather than a spinner. A segmented capture of a long page is the
    // case where the user has no other sign anything is happening.
    const totalSegments = xOffsets.length * yOffsets.length;
    let segments = 0;
    request.onProgress?.(0, totalSegments);
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
        request.onProgress?.(segments, totalSegments);
      }
    }

    // Segments are always captured as PNG (lossless intermediates); the
    // joined canvas encodes once into the requested output format.
    return {
      imageBase64: await canvas.toBase64(request.format),
      format: request.format,
      mode: 'standard',
      fullSize: { width, height },
      // The layout the IMAGE depicts, which on this path is the one measured
      // under the virtual viewport — not the one measured at the tab's real
      // viewport. Reporting naturalSize here described a layout the file is
      // not of, and made the truncation line compare a clamped overridden
      // size against an unrelated natural one.
      contentSize: overriddenSize,
      // Kept so the report can say the page re-laid out rather than leaving a
      // reader to wonder why "Full page" does not match their browser.
      naturalSize,
      imageSize: { width, height },
      truncated,
      segments,
      revealForced: 0,
    };
  } finally {
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
