/**
 * Hides secrets on the page itself while a screenshot is taken (NOBC-363).
 *
 * The report text was already scrubbed by redact.ts; the image was not, so a
 * dashboard showing an API key put the key in every capture. Matching text is
 * swapped for dots for the length of the capture and put back straight after.
 * Password fields already draw dots, so they are left alone; card-number and
 * one-time-code fields are hidden whole.
 */
import { SECRET_PATTERNS } from './redact';

type PatternSource = [source: string, flags: string];

/** Runs in the page (isolated world). Self-contained: no imports reach it. */
function maskInPage(sources: PatternSource[]): number {
  type Saved = { kind: 'text'; node: Text; before: string; after: string } | { kind: 'value'; el: HTMLInputElement | HTMLTextAreaElement; before: string; after: string };
  const host = window as unknown as { __ckMasked?: Saved[] };
  if (host.__ckMasked) return 0;
  const saved: Saved[] = [];
  host.__ckMasked = saved;
  const patterns = sources.map(([s, f]) => new RegExp(s, f.includes('g') ? f : `${f}g`));
  const jwt = /\beyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
  const isJwt = (value: string): boolean => {
    if (value.split('.').length >= 3) return true;
    try {
      const head = value.split('.')[0] ?? '';
      const aligned = head.slice(0, 40 - (Math.min(head.length, 40) % 4));
      return /"(?:alg|typ|kid)"/.test(atob(aligned.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return false;
    }
  };
  const mask = (text: string): string => {
    let out = text;
    for (const re of patterns) {
      re.lastIndex = 0;
      out = out.replace(re, (m) => '•'.repeat(Math.min(m.length, 24)));
    }
    jwt.lastIndex = 0;
    out = out.replace(jwt, (m) => (isJwt(m) ? '•'.repeat(24) : m));
    return out;
  };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && skip.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const before = n.nodeValue ?? '';
    if (before.length < 16) continue;
    const after = mask(before);
    if (after !== before) {
      n.nodeValue = after;
      saved.push({ kind: 'text', node: n, before, after });
    }
  }
  const wholeField = /\b(?:cc-number|cc-csc|one-time-code)\b/;
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) {
    if (el instanceof HTMLInputElement && ['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(el.type)) continue;
    const before = el.value;
    if (!before) continue;
    const after = wholeField.test(el.autocomplete ?? '') ? '•'.repeat(Math.min(before.length, 24)) : mask(before);
    if (after !== before) {
      el.value = after;
      saved.push({ kind: 'value', el, before, after });
    }
  }
  return saved.length;
}

/** Runs in the page. Puts back only what the page has not changed since. */
function unmaskInPage(): void {
  const host = window as unknown as { __ckMasked?: Array<{ kind: string; node?: Text; el?: HTMLInputElement | HTMLTextAreaElement; before: string; after: string }> };
  const saved = host.__ckMasked;
  delete host.__ckMasked;
  if (!saved) return;
  for (const item of saved) {
    if (item.kind === 'text' && item.node && item.node.nodeValue === item.after) item.node.nodeValue = item.before;
    if (item.kind === 'value' && item.el && item.el.value === item.after) item.el.value = item.before;
  }
}

/** Patterns as plain strings, so they can cross into the page. */
export function patternSources(): PatternSource[] {
  return SECRET_PATTERNS.map((re) => [re.source, re.flags] as PatternSource);
}

/**
 * Hides secrets on the page, runs the capture, then puts them back. A page
 * that refuses the script (chrome:// pages, the Web Store) is captured as it
 * is - those pages cannot be captured anyway.
 */
export async function withSecretsMasked<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  let masked = false;
  try {
    const [first] = await chrome.scripting.executeScript({ target: { tabId }, func: maskInPage, args: [patternSources()] });
    masked = typeof first?.result === 'number';
  } catch {
    masked = false;
  }
  try {
    return await work();
  } finally {
    if (masked) {
      await chrome.scripting.executeScript({ target: { tabId }, func: unmaskInPage }).catch(() => undefined);
    }
  }
}

export const __test = { maskInPage, unmaskInPage };
