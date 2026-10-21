/*
 * Scroll-and-stitch capture (NOBC-82, the CleanShot method).
 *
 * The standard path asks Chrome to render the page taller than the screen and
 * photographs it in one go. That is sharp and never repeats a header, but it
 * only works for content Chrome will lay out without anyone looking at it.
 * Some pages only draw what is on screen:
 *
 *   - canvas apps (Google Docs and Sheets, design tools) repaint the canvas
 *     for the scroll position and nothing else;
 *   - panels that scroll on their own inside an app shell, whose content the
 *     expansion path has to give up on when unrolling would hide the page;
 *   - anything an engineer wants photographed exactly as it scrolls past.
 *
 * This path does what a person with a screenshot tool does: scroll the page,
 * or the panel under the pointer, one screen at a time, photograph only that
 * screen, and stitch the screens in order. Offsets come from the scroll
 * position the page actually reached, so no image matching is needed.
 * Fixed and sticky chrome is neutralized first with the same UNSTICK pass the
 * other paths use, so a header appears once, at the top.
 *
 * It runs when asked for (the scroll-capture shortcut and popup button), and
 * automatically in two cases where the standard path is known to be wrong:
 * an app whose main scrolling panel is mostly canvas, and an inner-scroll
 * expansion that had to be abandoned.
 */

import { readEncodedImageSize } from './image-size';
import {
  CDP_VERSION,
  FREEZE_SCRIPT,
  RESTICK_SCRIPT,
  UNFREEZE_SCRIPT,
  UNSTICK_SCRIPT,
  evaluateInPage,
  sendCommand,
} from './cdp-fullpage';
import { MAX_CAPTURE_HEIGHT, PageCanvas } from './slices';
import type { CaptureRequest, CaptureResult, CaptureStrategy, ScrollStitchInfo } from './types';

/** Wait after each scroll for scroll handlers, canvas repaints and lazy images. */
export const SCROLL_SETTLE_MS = 250;
/** A runaway feed stops here; the report says it was cut. */
export const MAX_SCROLL_FRAMES = 60;
/** Rows each frame repeats from the previous one, so rounding never leaves a seam. */
export const FRAME_OVERLAP = 2;

const TARGET_ATTR = 'data-capture-kit-scroll-target';

/** Why this path ran. Printed in the report. */
export type ScrollStitchReason = 'asked' | 'canvas' | 'abandoned';
/** How the thing to scroll was chosen. */
export type ScrollTargetPreference = 'pointer' | 'largest';

/**
 * Scroll positions to photograph, top to bottom. Pure, so it is unit-tested.
 * `maxScroll` is the furthest the target can scroll; every frame shows
 * `frameHeight` rows. The last stop is always `maxScroll`, so the bottom of
 * the content is never missed, and stops never exceed `maxFrames`.
 */
export function planScrollStops(
  maxScroll: number,
  frameHeight: number,
  maxFrames = MAX_SCROLL_FRAMES,
): { stops: number[]; truncated: boolean } {
  const end = Math.max(0, Math.floor(maxScroll));
  const step = Math.max(1, Math.floor(frameHeight) - FRAME_OVERLAP);
  const stops: number[] = [];
  for (let y = 0; y < end && stops.length < maxFrames; y += step) stops.push(y);
  if (stops.length < maxFrames) {
    if (stops[stops.length - 1] !== end) stops.push(end);
    return { stops, truncated: false };
  }
  return { stops, truncated: true };
}

interface TargetInfo {
  kind: 'page' | 'panel';
  how: 'pointer' | 'largest' | 'page';
  /** Short description of the element, e.g. "div#editor.kix-appview". */
  label: string;
  scrollHeight: number;
  /** Visible part of the target, in viewport CSS px. */
  frame: { x: number; y: number; width: number; height: number };
  scrollTop: number;
  maxScroll: number;
}

/**
 * Picks what to scroll and marks it. With 'pointer', the nearest scrolling
 * ancestor of the element under the mouse wins - the panel you are pointing
 * at. Otherwise, or when nothing under the mouse scrolls: the page if it
 * scrolls, else the largest visible scrolling panel. Runs before anything on
 * the page is changed, so :hover still reflects where the pointer is.
 */
function targetScript(prefer: ScrollTargetPreference): string {
  return `(() => {
  const ATTR = '${TARGET_ATTR}';
  for (const el of document.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR);
  const vw = window.innerWidth, vh = window.innerHeight;
  const doc = document.scrollingElement || document.documentElement;
  const scrollsY = (el) => {
    if (el.clientHeight < 80 || el.clientWidth < 80) return false;
    if (el.scrollHeight - el.clientHeight <= 4) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch { return false; }
    return /^(auto|scroll|overlay)$/.test(cs.overflowY);
  };
  const visibleArea = (r) =>
    Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
    Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const docScrolls = doc.scrollHeight - doc.clientHeight > 4;
  let target = null;
  let how = 'page';
  if (${JSON.stringify(prefer)} === 'pointer') {
    const hovered = document.querySelectorAll(':hover');
    for (let node = hovered.length ? hovered[hovered.length - 1] : null;
         node && node !== document.body && node !== document.documentElement;
         node = node.parentElement) {
      if (scrollsY(node)) { target = node; how = 'pointer'; break; }
    }
  }
  if (!target && (${JSON.stringify(prefer)} === 'largest' || !docScrolls)) {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el === document.body || el === document.documentElement || !scrollsY(el)) continue;
      const a = visibleArea(el.getBoundingClientRect());
      if (a > bestArea) { best = el; bestArea = a; }
    }
    if (best && bestArea >= 0.15 * vw * vh && (!docScrolls || ${JSON.stringify(prefer)} === 'largest')) {
      target = best; how = 'largest';
    }
  }
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    return s.slice(0, 60);
  };
  if (!target) {
    const height = doc.clientHeight || vh;
    return {
      kind: 'page', how: 'page', label: 'the page',
      scrollHeight: doc.scrollHeight,
      frame: { x: 0, y: 0, width: doc.clientWidth || vw, height },
      scrollTop: window.scrollY,
      maxScroll: Math.max(0, doc.scrollHeight - height),
    };
  }
  target.setAttribute(ATTR, '');
  return { kind: 'panel', how, label: describe(target) };
})()`;
}

/**
 * The marked panel's visible box and scroll range, measured after UNSTICK so
 * neutralized chrome cannot shift it afterwards. The frame is the panel's
 * padding box (no border, no scrollbar) clipped to the viewport.
 */
const MEASURE_PANEL_SCRIPT = `(() => {
  const el = document.querySelector('[${TARGET_ATTR}]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft, top = r.top + el.clientTop;
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const x1 = Math.min(window.innerWidth, left + el.clientWidth);
  const y1 = Math.min(window.innerHeight, top + el.clientHeight);
  return {
    scrollHeight: el.scrollHeight,
    frame: { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) },
    scrollTop: el.scrollTop,
    maxScroll: Math.max(0, el.scrollHeight - el.clientHeight),
  };
})()`;

/** The page's viewport and scroll range, measured after UNSTICK. */
const MEASURE_PAGE_SCRIPT = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const root = document.documentElement;
  const height = root.clientHeight || window.innerHeight;
  return {
    scrollHeight: doc.scrollHeight,
    frame: { x: 0, y: 0, width: root.clientWidth || window.innerWidth, height },
    scrollTop: window.scrollY,
    maxScroll: Math.max(0, doc.scrollHeight - height),
  };
})()`;

function scrollScript(kind: 'page' | 'panel', y: number, settleMs: number): string {
  const move =
    kind === 'page'
      ? `window.scrollTo({ left: window.scrollX, top: ${y}, behavior: 'instant' });`
      : `el.scrollTo({ left: el.scrollLeft, top: ${y}, behavior: 'instant' });`;
  return `(async () => {
    const el = document.querySelector('[${TARGET_ATTR}]');
    ${kind === 'panel' ? "if (!el) return null;" : ''}
    ${move}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, ${settleMs}));
    return ${kind === 'page' ? 'window.scrollY' : 'el.scrollTop'};
  })()`;
}

const STICKY_ATTR = 'data-capture-kit-sticky';

/**
 * Marks the top-sticky elements inside the target (or the whole page), once,
 * so the per-screen check reads a handful of elements instead of the DOM.
 */
function markStickyScript(kind: 'page' | 'panel'): string {
  return `(() => {
  const root = ${kind === 'panel' ? `document.querySelector('[${TARGET_ATTR}]')` : 'document'};
  if (!root) return 0;
  let n = 0;
  for (const el of root.querySelectorAll('*')) {
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position !== 'sticky' || !Number.isFinite(parseFloat(cs.top))) continue;
    el.setAttribute('${STICKY_ATTR}', '');
    n += 1;
  }
  return n;
})()`;
}

interface StepResult {
  reached: number;
  /** Rows at the top of the screen covered by a stuck header, in CSS px. */
  band: number;
  /**
   * The page's own scroll offset. Page.captureScreenshot's clip is in
   * document coordinates, not viewport ones, so it has to be added.
   */
  sx: number;
  sy: number;
}

/**
 * Scroll to `y`, let the page settle, and report where it actually is and how
 * tall the stuck-header strip at the top of the screen is. A sticky element
 * counts when it sits exactly at its sticky offset, is no taller than 40% of
 * the screen (a sticky canvas or sidebar is content, not a header), and spans
 * at least 30% of the screen's width.
 */
function stepScript(
  kind: 'page' | 'panel',
  y: number,
  frame: { x: number; y: number; width: number; height: number },
  settleMs: number,
  measureBand: boolean,
): string {
  return `(async () => {
    const el = ${kind === 'panel' ? `document.querySelector('[${TARGET_ATTR}]')` : 'null'};
    ${kind === 'panel' ? 'if (!el) return null;' : ''}
    ${
      kind === 'page'
        ? `window.scrollTo({ left: window.scrollX, top: ${y}, behavior: 'instant' });`
        : `el.scrollTo({ left: el.scrollLeft, top: ${y}, behavior: 'instant' });`
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, ${settleMs}));
    const reached = ${kind === 'page' ? 'window.scrollY' : 'el.scrollTop'};
    let band = 0;
    if (${measureBand}) {
      const portTop = el ? el.getBoundingClientRect().top + el.clientTop : 0;
      const fx = ${frame.x}, fy = ${frame.y}, fw = ${frame.width}, fh = ${frame.height};
      for (const n of document.querySelectorAll('[${STICKY_ATTR}]')) {
        const cs = getComputedStyle(n);
        if (cs.position !== 'sticky') continue;
        const top = parseFloat(cs.top);
        if (!Number.isFinite(top)) continue;
        const r = n.getBoundingClientRect();
        if (r.height <= 0 || r.height > fh * 0.4) continue;
        if (Math.min(r.right, fx + fw) - Math.max(r.left, fx) < fw * 0.3) continue;
        if (Math.abs(r.top - (portTop + top)) > 1.5) continue;
        band = Math.max(band, Math.min(fh, Math.ceil(r.bottom - fy)));
      }
    }
    return { reached, band: Math.max(0, band), sx: window.scrollX, sy: window.scrollY };
  })()`;
}

const CLEAR_TARGET_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('[${TARGET_ATTR}]')) el.removeAttribute('${TARGET_ATTR}');
  for (const el of document.querySelectorAll('[${STICKY_ATTR}]')) el.removeAttribute('${STICKY_ATTR}');
})()`;

interface ScreenshotResult {
  data: string;
}

async function captureByScrolling(
  target: chrome.debugger.Debuggee,
  request: CaptureRequest,
  prefer: ScrollTargetPreference,
  reason: ScrollStitchReason,
): Promise<CaptureResult> {
  // Same zoom normalization as the standard path: frames are measured in CSS
  // pixels, and a zoomed tab would make every offset wrong.
  let restoreZoom: number | null = null;
  let browserZoom = 1;
  try {
    const zoom = await chrome.tabs.getZoom(request.tabId);
    if (Number.isFinite(zoom) && zoom > 0) browserZoom = zoom;
    if (Math.abs(browserZoom - 1) > 0.001) {
      restoreZoom = browserZoom;
      await chrome.tabs.setZoom(request.tabId, 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch {
    /* zoom unavailable; capture at whatever zoom is set */
  }

  const originalScroll = await evaluateInPage<{ x: number; y: number }>(
    target,
    '({ x: window.scrollX, y: window.scrollY })',
  );
  let frozen = false;
  let unstuck = false;
  try {
    // The target is picked before anything moves, so :hover still names the
    // element under the pointer.
    const picked = await evaluateInPage<TargetInfo | { kind: 'panel'; how: TargetInfo['how']; label: string }>(
      target,
      targetScript(prefer),
    );
    await evaluateInPage<void>(target, FREEZE_SCRIPT);
    frozen = true;
    if (picked.kind === 'page') {
      await evaluateInPage<number>(target, scrollScript('page', 0, 120));
    }
    // Fixed chrome is pinned where an unscrolled visitor sees it, so it
    // appears once, at the top. Sticky elements are left in place - a sticky
    // canvas has to keep painting as the page scrolls - and a stuck header is
    // trimmed off each later screen instead (stuckBand). UNSTICK also returns
    // inner scrollers, this target included, to the top; RESTICK puts them
    // back.
    await evaluateInPage<void>(target, 'window.__captureKitUnstickFixedOnly = true');
    unstuck = true;
    await evaluateInPage<number>(target, UNSTICK_SCRIPT);

    let info: TargetInfo;
    if (picked.kind === 'page') {
      const m = await evaluateInPage<Omit<TargetInfo, 'kind' | 'how' | 'label'>>(target, MEASURE_PAGE_SCRIPT);
      info = { ...m, kind: 'page', how: 'page', label: 'the page' };
    } else {
      const m = await evaluateInPage<Omit<TargetInfo, 'kind' | 'how' | 'label'> | null>(target, MEASURE_PANEL_SCRIPT);
      if (!m) throw new Error('The panel to scroll disappeared before the capture started.');
      info = { ...m, kind: 'panel', how: picked.how, label: picked.label };
    }
    const frameW = Math.floor(info.frame.width);
    const frameH = Math.floor(info.frame.height);
    if (frameW < 1 || frameH < 1) throw new Error('The area to scroll is not on screen.');
    const frame = { x: info.frame.x, y: info.frame.y, width: frameW, height: frameH };
    await evaluateInPage<number>(target, markStickyScript(info.kind));

    // The cap applies to the stitched height, in CSS px.
    const maxScroll = Math.min(info.maxScroll, Math.max(0, MAX_CAPTURE_HEIGHT - frameH));
    const estimate = planScrollStops(maxScroll, frameH).stops.length;
    request.onProgress?.(0, estimate);

    let canvas: PageCanvas | null = null;
    let ratio = 1;
    /** Content rows captured so far, from the top: [0, covered). */
    let covered = 0;
    let next = 0;
    let done = 0;
    let framesCut = false;
    let lastY = -1;
    for (;;) {
      if (done >= MAX_SCROLL_FRAMES) {
        framesCut = true;
        break;
      }
      let step = await evaluateInPage<StepResult | null>(
        target,
        stepScript(info.kind, next, frame, SCROLL_SETTLE_MS, done > 0),
      );
      if (step === null) throw new Error('The panel being scrolled disappeared mid-capture.');
      // A header that got stuck at the top covers rows this screen was meant
      // to add. Step back so the rows under it come from this screen instead
      // of being skipped.
      if (done > 0 && Math.round(step.reached) + step.band > covered) {
        const back = Math.max(0, covered - FRAME_OVERLAP - step.band);
        const retry = await evaluateInPage<StepResult | null>(
          target,
          stepScript(info.kind, back, frame, SCROLL_SETTLE_MS, true),
        );
        if (retry === null) throw new Error('The panel being scrolled disappeared mid-capture.');
        step = retry;
      }
      const y = Math.round(step.reached);
      // The page would not scroll any further: it is shorter now than when
      // the capture started (content collapsed or unloaded as it scrolled).
      // Stop instead of photographing the same screen until the frame cap.
      if (done > 0 && y <= lastY) break;
      lastY = y;
      const band = done > 0 ? Math.min(step.band, frameH - 1) : 0;
      const shot = await sendCommand<ScreenshotResult>(target, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: frame.x + step.sx, y: frame.y + step.sy + band, width: frameW, height: frameH - band, scale: 1 },
      });
      if (!canvas) {
        // The first frame says how many image pixels a CSS pixel is - 2 on a
        // Retina screen - and the canvas is built at that density, so this
        // path keeps the display's sharpness.
        const size = readEncodedImageSize(shot.data, 'png');
        ratio = size ? size.width / frameW : 1;
        canvas = new PageCanvas(
          Math.round(frameW * ratio),
          Math.round((maxScroll + frameH) * ratio),
          request.format,
          // Sliced afterwards from the cropped image (capture-engine/index),
          // because the stitched length is only known at the end.
          false,
        );
      }
      await canvas.add(0, Math.round((y + band) * ratio), shot.data);
      covered = Math.max(covered, y + frameH);
      done += 1;
      request.onProgress?.(done, Math.max(estimate, done));
      if (y >= maxScroll) break;
      const following = Math.min(maxScroll, y + frameH - band - FRAME_OVERLAP);
      next = following > y ? following : y + 1;
    }
    const reachedBottom = covered;
    if (!canvas) throw new Error('Nothing was captured.');

    // Content added while scrolling (an infinite feed) is not chased: the
    // capture is the length the page had when it started, and says so.
    const after = await evaluateInPage<number | null>(
      target,
      info.kind === 'page'
        ? '(document.scrollingElement || document.documentElement).scrollHeight'
        : `(() => { const el = document.querySelector('[${TARGET_ATTR}]'); return el ? el.scrollHeight : null; })()`,
    );
    const grew = typeof after === 'number' && after > info.scrollHeight + 4;

    const { imageBase64 } = await canvas.finish(Math.round(covered * ratio));
    const scrollStitch: ScrollStitchInfo = {
      target: info.kind,
      how: info.how,
      label: info.label,
      reason,
      frames: done,
      grew,
    };
    const fullSize = { width: frameW, height: Math.min(reachedBottom, maxScroll + frameH) };
    return {
      imageBase64,
      format: request.format,
      mode: 'scroll-stitch',
      fullSize,
      contentSize: { width: frameW, height: info.scrollHeight },
      imageSize: readEncodedImageSize(imageBase64, request.format) ?? canvas.wholeSize,
      truncated: framesCut || maxScroll < info.maxScroll,
      segments: done,
      revealForced: 0,
      browserZoom,
      scrollStitch,
      ...(canvas.scale < 1 ? { scale: canvas.scale } : {}),
    };
  } finally {
    if (restoreZoom !== null) {
      try {
        await chrome.tabs.setZoom(request.tabId, restoreZoom);
      } catch {
        /* the tab may be gone */
      }
    }
    if (unstuck) {
      try {
        await evaluateInPage<void>(target, RESTICK_SCRIPT);
      } catch {
        /* page navigated away mid-capture */
      }
    }
    if (frozen) {
      try {
        await evaluateInPage<void>(target, UNFREEZE_SCRIPT);
      } catch {
        /* best-effort */
      }
    }
    try {
      await evaluateInPage<void>(target, CLEAR_TARGET_SCRIPT);
      await evaluateInPage<void>(
        target,
        `window.scrollTo({ left: ${originalScroll.x}, top: ${originalScroll.y}, behavior: 'instant' })`,
      );
    } catch {
      /* best-effort restore */
    }
  }
}

export class ScrollStitchStrategy implements CaptureStrategy {
  readonly name = 'scroll-stitch';

  constructor(
    private readonly prefer: ScrollTargetPreference,
    private readonly reason: ScrollStitchReason,
  ) {}

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const target: chrome.debugger.Debuggee = { tabId: request.tabId };
    await chrome.debugger.attach(target, CDP_VERSION);
    try {
      return await captureByScrolling(target, request, this.prefer, this.reason);
    } finally {
      try {
        await chrome.debugger.detach(target);
      } catch {
        /* already detached */
      }
    }
  }
}

/**
 * The automatic canvas case: an app shell (the page itself barely scrolls)
 * whose largest scrolling panel is mostly covered by canvas. A canvas app
 * repaints only what is on screen, so unrolling or rendering tall gives blank
 * canvas below the first screen; scrolling is the only way to get it drawn.
 * Marketing pages with a canvas hero are untouched - their page scrolls.
 */
export async function detectCanvasScroller(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const doc = document.scrollingElement || document.documentElement;
        if (doc.scrollHeight - doc.clientHeight > vh * 0.5) return false;
        const visible = (r: DOMRect) => ({
          x0: Math.max(0, r.left),
          y0: Math.max(0, r.top),
          x1: Math.min(vw, r.right),
          y1: Math.min(vh, r.bottom),
        });
        let best: Element | null = null;
        let bestArea = 0;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (el.clientHeight < 80 || el.clientWidth < 80) continue;
          if (el.scrollHeight < el.clientHeight * 1.5) continue;
          const cs = getComputedStyle(el);
          if (!/^(auto|scroll|overlay)$/.test(cs.overflowY)) continue;
          const v = visible(el.getBoundingClientRect());
          const a = Math.max(0, v.x1 - v.x0) * Math.max(0, v.y1 - v.y0);
          if (a > bestArea) {
            best = el;
            bestArea = a;
          }
        }
        if (!best || bestArea < 0.3 * vw * vh) return false;
        const b = visible(best.getBoundingClientRect());
        let canvasArea = 0;
        for (const c of Array.from(document.querySelectorAll('canvas'))) {
          const v = visible(c.getBoundingClientRect());
          const w = Math.min(v.x1, b.x1) - Math.max(v.x0, b.x0);
          const h = Math.min(v.y1, b.y1) - Math.max(v.y0, b.y0);
          if (w > 0 && h > 0) canvasArea += w * h;
        }
        return canvasArea >= 0.4 * bestArea;
      },
    });
    return result?.result === true;
  } catch {
    return false;
  }
}
