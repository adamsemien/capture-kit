import type { CaptureRequest, CaptureResult, CaptureStrategy } from './types';
import { CdpFullPageStrategy } from './cdp-fullpage';

/**
 * Inner-scrollable-container capture (the Notion/Linear/Airtable shape): the
 * document itself is one viewport tall and the real content lives inside an
 * overflow:auto|scroll container, so a plain full-page capture shows a
 * cut-off window. This strategy expands the dominant inner scroller (and the
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
function innerScrollPage(action: PageAction): { shouldExpand: boolean } {
  const STYLE_ID = '__capture_kit_expand__';
  const ATTR = 'data-capture-kit-expand';
  const ATTR_H = 'data-capture-kit-expand-h';

  const restore = () => {
    document.getElementById(STYLE_ID)?.remove();
    for (const el of Array.from(document.querySelectorAll(`[${ATTR}], [${ATTR_H}]`))) {
      el.removeAttribute(ATTR);
      el.removeAttribute(ATTR_H);
    }
  };
  if (action === 'restore') {
    restore();
    return { shouldExpand: false };
  }

  // Tiny scrollboxes (code snippets, dropdowns) are never the page's content.
  const MIN_SIZE = 200;
  // Hidden-content threshold: less than this much overflow isn't worth expanding.
  const THRESHOLD = 32;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const docEl = document.scrollingElement || document.documentElement;
  // "Barely scrolls" = less than one extra viewport of document scroll. If
  // the document scrolls normally, the standard paths already handle it.
  const docBarelyScrolls = docEl.scrollHeight - viewportH < viewportH;

  let best: { el: Element; horizontal: boolean; score: number } | null = null;
  const scrollable = /^(auto|scroll|overlay)$/;
  for (const el of Array.from(document.querySelectorAll('*'))) {
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
    const vertical = vHidden > THRESHOLD && scrollable.test(style.overflowY);
    const horizontal = hHidden > THRESHOLD && scrollable.test(style.overflowX);
    if (!vertical && !horizontal) continue;
    const rect = el.getBoundingClientRect();
    const visW = Math.max(0, Math.min(rect.right, viewportW) - Math.max(rect.left, 0));
    const visH = Math.max(0, Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0));
    const visibleArea = visW * visH;
    // The scroller must dominate the viewport — a sidebar or chat widget
    // being scrollable is not the Notion shape.
    if (visibleArea < 0.4 * viewportW * viewportH) continue;
    const score = visibleArea + vHidden + hHidden;
    if (!best || score > best.score) best = { el, horizontal, score };
  }

  const shouldExpand = Boolean(best) && docBarelyScrolls;
  if (action === 'detect' || !shouldExpand || !best) return { shouldExpand };

  restore(); // idempotency if a previous capture died before restoring
  best.el.setAttribute(ATTR, 'scroller');
  if (best.horizontal) best.el.setAttribute(ATTR_H, '');
  // Every ancestor that clips (or could clip) the expanded content must
  // open up too — app shells chain height:100% + overflow:hidden from <html>
  // down to the scroller.
  let node: Element | null = best.el.parentElement;
  while (node) {
    node.setAttribute(ATTR, 'ancestor');
    if (best.horizontal) node.setAttribute(ATTR_H, '');
    node = node.parentElement;
  }
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent =
    `[${ATTR}]{height:auto !important;max-height:none !important;overflow:visible !important;}` +
    `[${ATTR_H}]{width:auto !important;max-width:none !important;}`;
  document.documentElement.appendChild(styleEl);
  return { shouldExpand: true };
}

async function runInnerScrollScript(
  tabId: number,
  action: PageAction,
): Promise<{ shouldExpand: boolean }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: innerScrollPage,
    args: [action],
  });
  return (results[0]?.result as { shouldExpand: boolean } | undefined) ?? { shouldExpand: false };
}

/** True when the page has the Notion shape: static document, dominant inner scroller. */
export async function detectInnerScroll(tabId: number): Promise<boolean> {
  try {
    return (await runInnerScrollScript(tabId, 'detect')).shouldExpand;
  } catch {
    // Pages that refuse script injection get the standard strategy.
    return false;
  }
}

export async function applyInnerScrollExpansion(tabId: number): Promise<void> {
  await runInnerScrollScript(tabId, 'expand');
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
    await applyInnerScrollExpansion(request.tabId);
    try {
      const result = await this.inner.capture(request);
      return { ...result, mode: 'expanded-inner-scroll' };
    } finally {
      await restoreInnerScrollExpansion(request.tabId);
    }
  }
}
