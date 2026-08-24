import type { CaptureFormat, CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { JPEG_QUALITY, SINGLE_SHOT_SURFACE_LIMIT } from './types';
import { SegmentCanvas, clampDimensions, planScrollOffsets } from './segments';
import { readEncodedImageSize } from './image-size';

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
// A fixed element the user cannot see must not be re-anchored. `fixed` is
// viewport-relative and contributes nothing to the document's scrollable
// overflow, so a closed drawer parked off-canvas measures as if it were not
// there. Rewriting it to `absolute` puts it INTO the document: the page widens
// by the off-canvas extent and the drawer paints into the capture, fully open,
// on a page where it is shut. Measured on a fixture reproducing
// app.thenobadcompany.com/operator/studio's geometry (left:916px +
// translateX(422.4px), width 384, overflow:clip on body and html): the
// document went 1300 -> 1722 at this step, and the written image carried 9406
// drawer-coloured pixels in a 381x785 box at x 1340..1720.
//
// Vetoed elements are marked and hidden rather than left alone: leaving one
// `fixed` would paint it once per segment, which is the artifact this whole
// script exists to kill.
//
// The two passes veto on different evidence, because only one of them can
// trust its own geometry:
//
//   pass 1 (captureAttached) runs at the real viewport, so "does this box
//     overlap what the user is looking at" is a real question. Geometric.
//   pass 2 (captureSegmented, after setDeviceMetricsOverride) runs under a
//     virtual viewport up to segmentSize tall, where almost everything
//     overlaps and the geometric test silently stops rejecting. It vetoes on
//     closed markers only — evidence the page states outright, which no
//     viewport can distort.
//
// The pass-1 verdict is sticky: pass 2 skips anything already carrying either
// marker, so a marker-less drawer vetoed geometrically at the real viewport is
// not re-examined under the inflated one and re-anchored.
const UNSTICK_SCRIPT = `(() => {
  const STYLE_ID = '__capture_kit_unstick__';
  const ATTR = 'data-capture-kit-position';
  const OFFSCREEN_ATTR = 'data-capture-kit-offscreen';
  const PREV_STYLE = 'data-capture-kit-prev-style';
  const SCROLL_ATTR = 'data-capture-kit-scroll';
  // Set by captureSegmented for the second pass, where geometry is unusable.
  const markersOnly = window.__captureKitUnstickMarkersOnly === true;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '[' + ATTR + '="sticky"]{position:static !important;}' +
      '[' + ATTR + '="fixed"]{position:absolute !important;}' +
      '[' + ATTR + '="pinned"]{position:absolute !important;right:auto !important;' +
      'bottom:auto !important;box-sizing:border-box !important;}' +
      '[' + OFFSCREEN_ATTR + ']{visibility:hidden !important;}';
    document.documentElement.appendChild(style);
  }

  // The page saying, in its own words, that this is shut. Checked on the
  // element and its ancestors: a closed drawer marks its root, not each of
  // the hundreds of descendants inside it.
  const closedMarker = (node) =>
    node.getAttribute('aria-hidden') === 'true' ||
    node.hasAttribute('hidden') ||
    node.hasAttribute('inert') ||
    (node.tagName === 'DIALOG' && !node.hasAttribute('open'));
  const collapsedIds = new Set();
  for (const control of document.querySelectorAll('[aria-controls][aria-expanded="false"]')) {
    for (const id of (control.getAttribute('aria-controls') || '').split(/\\s+/)) {
      if (id) collapsedIds.add(id);
    }
  }
  const declaredClosed = (el) => {
    for (let node = el; node; node = node.parentElement) {
      if (closedMarker(node)) return true;
      if (node.id && collapsedIds.has(node.id)) return true;
    }
    return false;
  };

  // Positive overlap area, not a shared edge: a drawer whose box starts at
  // exactly clientWidth touches the viewport and paints nothing.
  const onScreen = (rect) => {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    return (
      Math.min(rect.right, vw) - Math.max(rect.left, 0) > 0 &&
      Math.min(rect.bottom, vh) - Math.max(rect.top, 0) > 0
    );
  };

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
  const vetoed = [];
  for (const el of document.querySelectorAll('*')) {
    // Both markers, not just ATTR: an element vetoed on pass 1 carries only
    // OFFSCREEN_ATTR, and re-examining it on pass 2 under the inflated
    // viewport would re-anchor it and bring the leak straight back.
    if (el.hasAttribute(ATTR) || el.hasAttribute(OFFSCREEN_ATTR)) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position === 'sticky') {
      targets.push({ el: el, kind: 'sticky' });
      continue;
    }
    if (cs.position !== 'fixed') continue;

    const rect = el.getBoundingClientRect();

    // The veto. Pass 1 trusts geometry; pass 2 trusts only what the page
    // declares. Legitimate chrome — a header, a toolbar, a bottom bar — is
    // on screen at the unscrolled viewport and carries no closed marker, so
    // neither arm touches it.
    if (markersOnly ? declaredClosed(el) : !onScreen(rect)) {
      vetoed.push(el);
      continue;
    }
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

  // Marker only — the hiding is the stylesheet rule, so restore is removing
  // the attribute and the stylesheet, with no inline style to put back.
  for (const el of vetoed) el.setAttribute(OFFSCREEN_ATTR, '');

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
  // Vetoed off-canvas fixed elements. Visibility came from the stylesheet
  // removed above, so clearing the marker is the whole restore.
  for (const el of document.querySelectorAll('[data-capture-kit-offscreen]')) {
    el.removeAttribute('data-capture-kit-offscreen');
  }
  delete window.__captureKitUnstickMarkersOnly;
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
  // Browser page zoom is normalized to 100% for the duration of the capture.
  //
  // Emulation.setDeviceMetricsOverride takes its width in DIPs and page zoom
  // multiplies on top, so under zoom Z a virtual viewport of W gives a CSS
  // layout viewport of W/Z. The segmented path then measures the page in CSS
  // pixels, sizes the canvas from that, and places screenshots that only cover
  // W of those pixels — leaving (W/Z − W) unpainted, which encodes as solid
  // black in JPEG. Measured 2026-08-23: at zoom 0.25 a 2048px virtual viewport
  // produced an 8192px canvas with only 2048px painted, exactly the 1/Z ratio;
  // at zoom 0.8, 1500 painted of 1875. Reproduced identically at DPR 1 and 2,
  // so devicePixelRatio is not the variable — zoom is.
  //
  // Normalizing rather than compensating: it makes the capture 1:1 with CSS
  // pixels on every path, which is also what makes the reported numbers mean
  // anything. The tab's zoom is restored in the finally below.
  const zoomTabId = request.tabId;
  let restoreZoom: number | null = null;
  let browserZoom = 1;
  try {
    const zoom = await chrome.tabs.getZoom(zoomTabId);
    if (Number.isFinite(zoom) && zoom > 0) browserZoom = zoom;
    if (Math.abs(browserZoom - 1) > 0.001) {
      restoreZoom = browserZoom;
      await chrome.tabs.setZoom(zoomTabId, 1);
      // Zoom is a layout change; let it settle before anything is measured.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch {
    // Zoom is unavailable for some tabs; capturing at whatever zoom is set is
    // still better than failing the capture.
  }
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
    // Armed BEFORE the evaluate, not after it resolves. If the in-page script
    // throws partway it has already written markers, and the veto means one of
    // those markers hides an element the user can see — a page only a reload
    // recovers. RESTICK is idempotent, so arming early costs nothing when the
    // script succeeds.
    unstuck = true;
    await evaluateInPage<number>(target, UNSTICK_SCRIPT);

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
    return { ...result, revealForced, browserZoom };
  } finally {
    if (restoreZoom !== null) {
      try {
        await chrome.tabs.setZoom(zoomTabId, restoreZoom);
      } catch {
        /* the tab may be gone; the user's zoom is a preference, not the capture */
      }
    }
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
    // Measured, not assumed. clip.scale: 1 does NOT pin this path's output to
    // CSS pixels: on a DPR-2 display the file comes back at 2× the clip. The
    // stamp seam rewrites this again if the footer is added.
    imageSize: readEncodedImageSize(shot.data, format) ?? contentSize,
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
    // Pass 2. The device-metrics override makes the viewport as much as
    // segmentSize tall, so "off screen" stops discriminating — nearly every
    // box overlaps it. This pass vetoes on closed markers only. Elements
    // pass 1 already judged carry a marker and are skipped outright.
    await evaluateInPage<void>(target, 'window.__captureKitUnstickMarkersOnly = true');
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
    const imageBase64 = await canvas.toBase64(request.format);
    return {
      imageBase64,
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
      imageSize: readEncodedImageSize(imageBase64, request.format) ?? { width, height },
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
