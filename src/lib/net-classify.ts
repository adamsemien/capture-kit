import type { ConsoleEntry, NetworkFailure } from './messages';

/**
 * First-party/third-party classification and duplicate collapsing for
 * console errors and network failures.
 *
 * Why this exists: a real page with an ad blocker emits a dozen identical
 * blocked-beacon failures. Printed raw they bury the one failure a developer
 * can act on, and counted as "errors" they make a working page look broken.
 * Third-party noise is separated and collapsed — but never dropped, and the
 * hosts that were reclassified are listed in the page report, because a
 * silent reclassification is indistinguishable from a bug in this code.
 */

/**
 * Two-part public suffixes common enough to matter. This is deliberately a
 * short list, not a public-suffix list (that would be a dependency and a
 * megabyte). An unlisted exotic suffix mis-classifies toward third-party,
 * which de-emphasizes a failure but never hides it — and the hosts line in
 * the page report makes that visible.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'co.za',
  'com.sg', 'co.in', 'co.kr', 'com.tr', 'com.cn',
]);

/** example.co.uk from api.example.co.uk; falls back to the host itself. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join('.')
    : lastTwo;
}

function hostOf(url: string, base: string): string | null {
  try {
    return new URL(url, base || undefined).hostname;
  } catch {
    return null;
  }
}

/** A relative URL is the page's own by definition; an unparseable one is treated as the page's. */
export function isFirstParty(url: string, pageUrl: string): boolean {
  const pageHost = hostOf(pageUrl, '');
  if (!pageHost) return true;
  const host = hostOf(url, pageUrl);
  if (!host) return true;
  if (host === pageHost) return true;
  return registrableDomain(host) === registrableDomain(pageHost);
}

export interface CollapsedFailure {
  method: string;
  status: number;
  /** Representative URL: volatile params stripped, the rest kept. */
  url: string;
  count: number;
  minMs: number;
  maxMs: number;
  /** True when members' surviving query strings differ from each other. */
  variants: boolean;
}

/**
 * Params that change on every call and identify nothing. Everything else —
 * page numbers, ids, real query values — is preserved, so distinct requests
 * stay distinct in the representative URL.
 */
const VOLATILE_PARAMS = new Set([
  '_', 't', 'ts', 'time', 'timestamp', 'cb', 'rand', 'random', 'nonce', '_ga', 'gclid',
]);

function splitUrl(raw: string, base: string): { key: string; query: string; display: string } {
  try {
    const url = new URL(raw, base || undefined);
    url.hash = '';
    for (const param of [...url.searchParams.keys()]) {
      if (VOLATILE_PARAMS.has(param.toLowerCase())) url.searchParams.delete(param);
    }
    const surviving = [...url.searchParams.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('&');
    // Grouping ignores the query entirely: an ad blocker's beacons and a
    // paginated endpoint's retries are both "the same request failing again".
    // The count and the variants marker keep that honest.
    return {
      key: `${url.origin}${url.pathname}`,
      query: surviving,
      display: `${url.origin}${url.pathname}${url.search}`,
    };
  } catch {
    return { key: raw, query: '', display: raw };
  }
}

/** Identical method + status + path collapse to one row with a count and duration range. */
export function collapseFailures(failures: NetworkFailure[], pageUrl: string): CollapsedFailure[] {
  const groups = new Map<string, { members: NetworkFailure[]; queries: Set<string>; display: string }>();
  for (const failure of failures) {
    const { key, query, display } = splitUrl(failure.url, pageUrl);
    const groupKey = `${failure.method} ${failure.status} ${key}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.members.push(failure);
      existing.queries.add(query);
    } else {
      groups.set(groupKey, { members: [failure], queries: new Set([query]), display });
    }
  }

  return [...groups.values()].map(({ members, queries, display }) => {
    const durations = members.map((m) => m.durationMs);
    return {
      method: members[0].method,
      status: members[0].status,
      url: display,
      count: members.length,
      minMs: Math.round(Math.min(...durations)),
      maxMs: Math.round(Math.max(...durations)),
      variants: queries.size > 1,
    };
  });
}

/** `- POST host/log?a=b — failed — 13×, 1–17ms` */
export function formatFailureLine(failure: CollapsedFailure): string {
  const status = failure.status === 0 ? 'failed' : String(failure.status);
  const duration =
    failure.minMs === failure.maxMs ? `${failure.minMs}ms` : `${failure.minMs}–${failure.maxMs}ms`;
  const repetition = failure.count > 1 ? `${failure.count}×, ` : '';
  const variants = failure.variants ? ` (${failure.count} variants)` : '';
  return `- ${failure.method} ${failure.url} — ${status} — ${repetition}${duration}${variants}`;
}

export interface PartySplit<T> {
  firstParty: T[];
  thirdParty: T[];
  /** Hosts classified third-party, for the inspectability line. */
  thirdPartyHosts: string[];
}

function splitByParty<T>(items: T[], urlOf: (item: T) => string | undefined, pageUrl: string): PartySplit<T> {
  const firstParty: T[] = [];
  const thirdParty: T[] = [];
  const hosts = new Set<string>();
  for (const item of items) {
    const url = urlOf(item);
    // No resolvable source → first-party. An unattributable failure is more
    // dangerous de-emphasized than shown; the same reasoning as the
    // recorder-status line.
    if (!url || isFirstParty(url, pageUrl)) {
      firstParty.push(item);
      continue;
    }
    thirdParty.push(item);
    const host = hostOf(url, pageUrl);
    if (host) hosts.add(host);
  }
  return { firstParty, thirdParty, thirdPartyHosts: [...hosts].sort() };
}

export function splitFailures(failures: NetworkFailure[], pageUrl: string): PartySplit<NetworkFailure> {
  return splitByParty(failures, (f) => f.url, pageUrl);
}

/**
 * Console errors carry a `file:line:col` source from the stack or the error
 * event. Entries with no source stay first-party by the rule above.
 */
export function splitConsoleErrors(errors: ConsoleEntry[], pageUrl: string): PartySplit<ConsoleEntry> {
  return splitByParty(
    errors,
    (e) => (e.source ? e.source.replace(/:\d+:\d+$/, '') : undefined),
    pageUrl,
  );
}

/** Union of hosts reclassified on a page, for the report's inspectability line. */
export function mergeHosts(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}
