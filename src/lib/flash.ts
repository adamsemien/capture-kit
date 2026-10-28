/*
 * The "photo taken" cue (NOBC-82, capture feedback).
 *
 * A capture fired from the shortcut or the one-click icon gave no sign on the
 * page that it had finished: the badge is up in the toolbar, out of the eye
 * line, and with "Show me what I captured" off nothing else happens at all.
 *
 * One green glow around the edge of the window, the way a camera app confirms
 * a shot. It is shown only after the capture has finished and every change
 * Capture Kit made to the page is undone, so it can never be in the image.
 *
 * Why an edge and not a full-page flash: the first version washed the whole
 * page in 28% white, which is invisible on the white pages most people
 * capture. A coloured ring shows on light and dark pages alike, and leaves
 * the content itself untouched.
 *
 * Kept gentle on purpose: a single pulse, never repeated, gone in under a
 * second - far below the three-flashes-a-second line that matters for
 * photosensitivity. Someone who has asked their system for reduced motion
 * gets the same ring without the quick rise: it appears and fades out.
 *
 * `showCaptureFlash` is handed to chrome.scripting.executeScript, which sends
 * the function's source text into the page, so it must not reference anything
 * outside its own body.
 */

import type { CaptureTrigger } from './messages';

/** Marker on the overlay, so tests (and a curious reader of the DOM) can find it. */
export const FLASH_ATTR = 'data-capture-kit-flash';

/**
 * Captures a person fired and is watching for: the shortcut, the toolbar icon
 * and the popup. Page and agent triggers, sessions, sweeps and clips do not
 * flash - an agent's next screenshot should not catch an overlay, and a
 * session would flash at every tab.
 */
const FLASH_TRIGGERS: ReadonlySet<CaptureTrigger> = new Set<CaptureTrigger>(['shortcut', 'scroll-shortcut', 'icon', 'popup']);

export function flashesFor(trigger: CaptureTrigger, enabled: boolean): boolean {
  return enabled && FLASH_TRIGGERS.has(trigger);
}

export function showCaptureFlash(): void {
  const ATTR = 'data-capture-kit-flash';
  const root = document.documentElement;
  if (!root || root.querySelector(`[${ATTR}]`)) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const el = document.createElement('div');
  el.setAttribute(ATTR, reduce ? 'border' : 'glow');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483647',
    'margin:0',
    'padding:0',
    'border:0',
    // A solid ring (readable on white) plus a soft inner glow (readable on dark).
    'box-shadow:inset 0 0 0 4px rgba(22,163,74,1),inset 0 0 36px 8px rgba(34,197,94,0.5)',
    'background:transparent',
    'opacity:0',
  ].join(';');
  root.appendChild(el);
  const frames = reduce
    ? [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }]
    : [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }];
  const remove = () => el.remove();
  try {
    const animation = el.animate(frames, { duration: reduce ? 800 : 700, easing: 'ease-out' });
    animation.onfinish = remove;
    animation.oncancel = remove;
  } catch {
    remove();
    return;
  }
  // Belt and braces: a page that freezes animations must not keep the overlay.
  setTimeout(remove, 1500);
}
