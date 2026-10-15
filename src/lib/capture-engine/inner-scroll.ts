import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';

/**
 * Inner-scrollable-container capture (the Notion/Linear/Airtable shape): the
 * document itself is one viewport tall and the real content lives inside an
 * overflow:auto|scroll container, so a plain full-page capture shows a
 * cut-off window. This strategy expands every inner scroller holding hidden
 * content - one column or several side by side - (and the
 * ancestors that clip it) to its natural size, then delegates to the
 * existing CDP pipeline, which re-measures and picks single-shot vs
 * segmented as usual. All style changes are restored in a finally.
 *
 * Known limits (documented in README): virtualized lists render only the
 * visible rows, so expanded regions capture placeholders/empty space;
 * canvas-rendered apps (Figma, Sheets) are out of scope entirely.
 */

type PageAction = 'detect' | 'expand' | 'restore';

// Runs IN THE PAGE via chrome.scripting.executeScript — must stay fully
// self-contained (no outer-scope references survive serialization).
function innerScrollPage(
  action: PageAction,
): { shouldExpand: boolean; count: number; framesHeld: number } {
  const STYLE_ID = '__capture_kit_expand__';
  const ATTR = 'data-capture-kit-expand';
  const ATTR_H = 'data-capture-kit-expand-h';
  const ATTR_FB = 'data-capture-kit-expand-fb';
  const ATTR_IF = 'data-capture-kit-expand-frame';
  const ATTR_IF_NOSTYLE = 'data-capture-kit-expand-frame-nostyle';
  const FRAME_VAR = '--capture-kit-frame-h';

  const restore = () => {
    document.getElementById(STYLE_ID)?.remove();
    for (const el of Array.from(
      document.querySelectorAll(`[${ATTR}], [${ATTR_H}], [${ATTR_FB}], [${ATTR_IF}]`),
    )) {
      el.removeAttribute(ATTR);
      el.removeAttribute(ATTR_H);
      el.removeAttribute(ATTR_FB);
      if (el.hasAttribute(ATTR_IF)) {
        el.removeAttribute(ATTR_IF);
        (el as HTMLElement).style.removeProperty(FRAME_VAR);
        if (el.hasAttribute(ATTR_IF_NOSTYLE)) {
          el.removeAttribute(ATTR_IF_NOSTYLE);
          if (!el.getAttribute('style')) el.removeAttribute('style');
        }
      }
    }
  };
  if (action === 'restore') {
    restore();
    return { shouldExpand: false, count: 0, framesHeld: 0 };
  }

  // Tiny scrollboxes (code snippets, dropdowns) are never the page's content.
  const MIN_SIZE = 200;
  // Hidden-content threshold: less than this much overflow isn't worth expanding.
  const THRESHOLD = 32;
  // A column of the page, not a widget: each scroller must show at least this
  // share of the viewport. The old rule was one scroller at 40% or nothing,
  // which a three-column app shell can never meet - on a 2000px screen the
  // NoBC OS event builder's settings pane is about 28% and its preview about
  // 36%, so neither was unrolled and the capture came back one screen tall.
  // 8% keeps a 300x250 chat widget (about 6% of a 1300x900 screen) out.
  const MIN_SHARE = 0.08;
  // Sideways expansion only for a scroller that dominates the screen. Widening
  // a carousel or a table inside one column of a multi-column app would push
  // every column beside it out of place.
  const DOMINANT_SHARE = 0.4;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const viewportArea = viewportW * viewportH;
  const docEl = document.scrollingElement || document.documentElement;
  // "Barely scrolls" = less than one extra viewport of document scroll. If
  // the document scrolls normally, the standard paths already handle it.
  const docBarelyScrolls = docEl.scrollHeight - viewportH < viewportH;

  // The page saying, in its own words, that this is shut - the same markers
  // UNSTICK and FORCE_REVEAL veto on. A closed drawer can scroll and can sit
  // partly on screen; unrolling it would paint it open.
  const collapsedIds = new Set<string>();
  for (const control of Array.from(
    document.querySelectorAll('[aria-controls][aria-expanded="false"]'),
  )) {
    for (const id of (control.getAttribute('aria-controls') || '').split(/\s+/)) {
      if (id) collapsedIds.add(id);
    }
  }
  const closedByPage = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (
        node.getAttribute('aria-hidden') === 'true' ||
        node.hasAttribute('hidden') ||
        node.hasAttribute('inert') ||
        (node.tagName === 'DIALOG' && !node.hasAttribute('open')) ||
        (node.id && collapsedIds.has(node.id))
      ) {
        return true;
      }
    }
    return false;
  };

  // Every scroller that holds hidden content, not one winner: a page split
  // into columns that each scroll on their own needs every column unrolled to
  // its own length.
  const picked: { el: Element; horizontal: boolean }[] = [];
  const scrollable = /^(auto|scroll|overlay)$/;
  // Form controls scroll their own value, not the page: a textarea set to
  // height:auto shrinks back to its rows attribute and reflows the form.
  const FORM_CONTROL = /^(TEXTAREA|SELECT|INPUT)$/;
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (FORM_CONTROL.test(el.tagName)) continue;
    if (el.clientHeight < MIN_SIZE || el.clientWidth < MIN_SIZE) continue;
    const vHidden = el.scrollHeight - el.clientHeight;
    const hHidden = el.scrollWidth - el.clientWidth;
    if (vHidden <= THRESHOLD && hHidden <= THRESHOLD) continue;
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el);
    } catch {
      continue;
    }
    const rect = el.getBoundingClientRect();
    const visW = Math.max(0, Math.min(rect.right, viewportW) - Math.max(rect.left, 0));
    const visH = Math.max(0, Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0));
    const visibleArea = visW * visH;
    if (visibleArea < MIN_SHARE * viewportArea) continue;
    const vertical = vHidden > THRESHOLD && scrollable.test(style.overflowY);
    const horizontal =
      hHidden > THRESHOLD &&
      scrollable.test(style.overflowX) &&
      visibleArea >= DOMINANT_SHARE * viewportArea;
    if (!vertical && !horizontal) continue;
    // Named apart from FORCE_REVEAL's declaredClosed: CHECK A11 finds that
    // script's veto line by its exact text and needs it to be unique.
    if (closedByPage(el)) continue;
    picked.push({ el, horizontal });
  }

  const shouldExpand = picked.length > 0 && docBarelyScrolls;
  if (action === 'detect' || !shouldExpand) {
    return { shouldExpand, count: picked.length, framesHeld: 0 };
  }

  restore(); // idempotency if a previous capture died before restoring

  // Embedded pages keep the height they have on screen. An iframe sized to
  // fill its pane grows with the pane once the columns beside it unroll, and
  // the page inside re-lays out against that taller frame - its viewport is
  // the frame. On the NoBC OS builder the live preview's poster slid to the
  // middle of a mostly black column. Measured now, before anything moves;
  // held through a stylesheet !important rule reading a custom property, the
  // same way the viewport-height hold works. Unrolling an iframe's own
  // content is separate work.
  const frames: { el: HTMLElement; height: number; column: boolean }[] = [];
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    let column = false;
    const parent = frame.parentElement;
    if (parent) {
      try {
        const pcs = getComputedStyle(parent);
        column = /flex/.test(pcs.display) && /column/.test(pcs.flexDirection);
      } catch {
        /* judge it a plain block */
      }
    }
    frames.push({ el: frame, height: rect.height, column });
  }
  for (const { el, height, column } of frames) {
    if (!el.hasAttribute('style')) el.setAttribute(ATTR_IF_NOSTYLE, '');
    el.style.setProperty(FRAME_VAR, height + 'px');
    // flex-grow only matters on a column's vertical axis; in a row it is the
    // width, which must not change.
    el.setAttribute(ATTR_IF, column ? 'column' : '');
  }

  for (const { el } of picked) el.setAttribute(ATTR, 'scroller');
  // Every ancestor that clips (or could clip) the expanded content must
  // open up too - app shells chain height:100% + overflow:hidden from <html>
  // down to each scroller. A scroller nested in another keeps its own role.
  for (const { el, horizontal } of picked) {
    if (horizontal) el.setAttribute(ATTR_H, '');
    let node: Element | null = el.parentElement;
    while (node) {
      if (!node.hasAttribute(ATTR)) node.setAttribute(ATTR, 'ancestor');
      if (horizontal) node.setAttribute(ATTR_H, '');
      node = node.parentElement;
    }
  }
  // An element sized by "share what is left, starting from zero" never takes
  // its size from its content: flex:1 1 0px inside a column flex container.
  // Releasing its height does nothing - the column still hands it zero and
  // stretches it to whatever space remains, one screen. The NoBC OS operator
  // shell nests the builder row exactly that way (measured on the live page
  // 2026-10-14: flex 1 1 0px, min-height 0, overflow hidden), so two
  // expanded scrollers left the capture one screen tall. Measured before any
  // write, then flex-basis:auto for those on a vertical axis only - a row
  // child's flex-basis is its WIDTH, and touching it would resize columns.
  const columnItems: Element[] = [];
  for (const el of Array.from(document.querySelectorAll(`[${ATTR}]`))) {
    const parent = el.parentElement;
    if (!parent) continue;
    let pcs: CSSStyleDeclaration;
    try {
      pcs = getComputedStyle(parent);
    } catch {
      continue;
    }
    if (!/flex/.test(pcs.display) || !/column/.test(pcs.flexDirection)) continue;
    columnItems.push(el);
  }
  for (const el of columnItems) el.setAttribute(ATTR_FB, '');
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  // The scroller has to release its own scroll, so it keeps overflow:visible.
  //
  // The ancestors do NOT. What they were clipping is the scroller's expanded
  // height, and they were only clipping it because they could not grow:
  // height:100% (or a fixed height) plus overflow:hidden. Give them
  // height:auto and they grow to contain the child, so their own
  // overflow:hidden clips nothing on the scroll axis - and it still clips an
  // off-canvas sibling on the cross axis, which is the drawer an app shell
  // hides by nothing but that clip.
  //
  // Scoping the un-clip to one axis instead is not available: when overflow-x
  // and overflow-y differ and one is visible, CSS computes the visible axis to
  // auto, and an auto axis clips into a scroll region rather than painting
  // outward. Measured on this build by scripts/probe-innerscroll.mjs -
  // overflow-x:hidden with overflow-y:visible computes overflow-y:auto.
  styleEl.textContent =
    `[${ATTR}="scroller"]{height:auto !important;max-height:none !important;` +
    `overflow:visible !important;}` +
    `[${ATTR}="ancestor"]{height:auto !important;max-height:none !important;}` +
    `[${ATTR_H}]{width:auto !important;max-width:none !important;}` +
    `[${ATTR_FB}]{flex-basis:auto !important;}` +
    `[${ATTR_IF}]{height:var(${FRAME_VAR}) !important;min-height:0 !important;` +
    `max-height:none !important;}` +
    `[${ATTR_IF}="column"]{flex-grow:0 !important;flex-basis:auto !important;}`;
  document.documentElement.appendChild(styleEl);
  return { shouldExpand: true, count: picked.length, framesHeld: frames.length };
}

interface InnerScrollOutcome {
  shouldExpand: boolean;
  /** Scrollers unrolled (expand) or that would be (detect). */
  count: number;
  /** Embedded frames held at their on-screen height (expand only). */
  framesHeld: number;
}

async function runInnerScrollScript(
  tabId: number,
  action: PageAction,
): Promise<InnerScrollOutcome> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: innerScrollPage,
    args: [action],
  });
  return (
    (results[0]?.result as InnerScrollOutcome | undefined) ?? {
      shouldExpand: false,
      count: 0,
      framesHeld: 0,
    }
  );
}

/** True when the document barely scrolls and at least one inner scroller holds the content. */
export async function detectInnerScroll(tabId: number): Promise<boolean> {
  try {
    return (await runInnerScrollScript(tabId, 'detect')).shouldExpand;
  } catch {
    // Pages that refuse script injection get the standard strategy.
    return false;
  }
}

/** Unrolls every qualifying scroller; returns how many, and how many frames it held. */
export async function applyInnerScrollExpansion(
  tabId: number,
): Promise<{ count: number; framesHeld: number }> {
  const { count, framesHeld } = await runInnerScrollScript(tabId, 'expand');
  return { count, framesHeld };
}

export async function restoreInnerScrollExpansion(tabId: number): Promise<void> {
  try {
    await runInnerScrollScript(tabId, 'restore');
  } catch {
    /* page navigated away mid-capture — nothing left to restore */
  }
}

export class InnerScrollExpansionStrategy implements CaptureStrategy {
  readonly name = 'inner-scroll';
  private readonly inner = new CdpFullPageStrategy();

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const { count: innerScrollers, framesHeld } = await applyInnerScrollExpansion(request.tabId);
    try {
      const result = await this.inner.capture(request);
      return { ...result, mode: 'expanded-inner-scroll', innerScrollers, framesHeld };
    } finally {
      await restoreInnerScrollExpansion(request.tabId);
    }
  }
}
