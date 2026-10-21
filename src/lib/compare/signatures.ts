/*
 * Before/after, the text half (NOBC-82): which console errors and failed
 * requests are new since the last capture of the same page, which are gone,
 * and which are still there.
 *
 * Two captures of the same bug rarely print byte-identical messages - ids,
 * counters, timestamps and cache-busting query strings change every reload -
 * so each entry is reduced to a signature that keeps what a person would call
 * "the same error" and drops what changes run to run. Pure functions, so the
 * matching is unit-tested.
 */

import type { ConsoleEntry, NetworkFailure } from '../messages';

/** What a comparison remembers about one entry: how to match it, how to show it. */
export interface Signed {
  sig: string;
  text: string;
}

const MAX_TEXT = 160;

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}

/** Drop query strings and fragments from any URL inside the text. */
function stripUrlNoise(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#'")]+)[?#][^\s'")]*/g, '$1');
}

/**
 * The parts of a message that change run to run: long numbers, hex ids,
 * UUIDs, ISO timestamps. Short numbers stay - "404" and "line 12" are the
 * error, not noise.
 */
function stripRunNoise(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d{5,}\b/g, '<n>');
}

/** "file.js:12:34" with the column dropped - a rebuild moves columns, not lines that matter. */
function sourceKey(source: string | undefined): string {
  if (!source) return '';
  const noQuery = stripUrlNoise(source);
  return noQuery.replace(/:(\d+):\d+$/, ':$1');
}

export function errorSignature(entry: ConsoleEntry): Signed {
  const message = stripRunNoise(stripUrlNoise(entry.message));
  return {
    sig: `${message}@${sourceKey(entry.source)}`,
    text: clip(entry.source ? `${entry.message} (${entry.source})` : entry.message),
  };
}

export function failureSignature(failure: NetworkFailure): Signed {
  let path = failure.url;
  try {
    const u = new URL(failure.url);
    path = `${u.origin}${u.pathname}`;
  } catch {
    path = stripUrlNoise(failure.url);
  }
  const status = failure.status === 0 ? 'no response' : String(failure.status);
  return {
    sig: `${failure.method.toUpperCase()} ${stripRunNoise(path)} ${status}`,
    text: clip(`${failure.method.toUpperCase()} ${path} → ${status}`),
  };
}

export interface SetDiff {
  added: Signed[];
  removed: Signed[];
  /** Signatures present both times. */
  kept: number;
}

/** One entry per signature, first text wins - a repeated error is one error here. */
function unique(list: readonly Signed[]): Map<string, Signed> {
  const out = new Map<string, Signed>();
  for (const item of list) if (!out.has(item.sig)) out.set(item.sig, item);
  return out;
}

export function diffSigned(before: readonly Signed[], after: readonly Signed[]): SetDiff {
  const a = unique(before);
  const b = unique(after);
  const added = [...b.values()].filter((x) => !a.has(x.sig));
  const removed = [...a.values()].filter((x) => !b.has(x.sig));
  const kept = [...b.keys()].filter((k) => a.has(k)).length;
  return { added, removed, kept };
}

/**
 * Which earlier capture counts as "this page": scheme, host, port, path and
 * query, without the fragment. Tracking parameters are dropped so a link from
 * a newsletter compares with a plain visit.
 */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const name of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_eid$|_hs)/i.test(name)) u.searchParams.delete(name);
    }
    return u.toString();
  } catch {
    return url.split('#')[0];
  }
}
