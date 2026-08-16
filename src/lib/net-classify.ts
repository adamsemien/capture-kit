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

/**
 * Path segments that mark a request as telemetry. Deliberately short and
 * matched as whole segments: these demote a request even when it shares the
 * page's domain, which is the only way to catch platform beacons served from
 * sibling subdomains (calendar.google.com → play.google.com/log).
 *
 * Known false-negative risk, accepted: an app whose OWN endpoint is named
 * like these — /api/log for server-side logging, /metrics for an app-facing
 * dashboard fetch, /e/{id} for an events route — will be demoted. It is still
 * printed, in a labelled section, and the hosts line names it as a
 * same-domain demotion.
 *
 * 'stats' was deliberately removed: /api/stats is an ordinary endpoint behind
 * ordinary dashboards, and demoting a real 500 there is exactly the error
 * this split exists to prevent. The stats. HOST prefix stays — a host named
 * for telemetry is far stronger evidence than a path segment.
 */
const TELEMETRY_SEGMENTS = new Set([
  'log', 'logs', 'collect', 'beacon', 'track', 'tracking', 'telemetry',
  'metrics', 'analytics', 'pixel', 'gen_204', 'e',
]);

/** Subdomain prefixes that exist to carry telemetry. */
const TELEMETRY_HOST_PREFIXES = [
  'analytics.', 'metrics.', 'telemetry.', 'logs.', 'log.', 'beacon.',
  'stats.', 'tracking.',
];

function hasTelemetryShape(url: string, base: string): boolean {
  try {
    const parsed = new URL(url, base || undefined);
    const host = parsed.hostname.toLowerCase();
    if (TELEMETRY_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return true;
    return parsed.pathname
      .toLowerCase()
      .split('/')
      .filter(Boolean)
      .some((segment) => TELEMETRY_SEGMENTS.has(segment));
  } catch {
    return false;
  }
}

export type PartyReason = 'same-domain' | 'cross-domain' | 'telemetry-shape';

export interface PartyVerdict {
  firstParty: boolean;
  reason: PartyReason;
  host: string | null;
}

/**
 * First-party requires BOTH signals to agree: same registrable domain AND no
 * telemetry shape. Domain alone matched calendar.google.com to
 * play.google.com/log — correct by the domain rule, wrong in substance, since
 * that is precisely the beacon the split exists to demote. Large platforms
 * serve telemetry from sibling subdomains, so this recurs by design.
 */
export function classifyUrl(url: string, pageUrl: string): PartyVerdict {
  const pageHost = hostOf(pageUrl, '');
  const host = hostOf(url, pageUrl);
  // A relative URL is the page's own; an unparseable one is treated as the
  // page's, since an unattributable failure must not be demoted out of sight.
  if (!pageHost || !host) return { firstParty: true, reason: 'same-domain', host };

  const sameDomain =
    host === pageHost || registrableDomain(host) === registrableDomain(pageHost);
  if (!sameDomain) return { firstParty: false, reason: 'cross-domain', host };
  if (hasTelemetryShape(url, pageUrl)) {
    return { firstParty: false, reason: 'telemetry-shape', host };
  }
  return { firstParty: true, reason: 'same-domain', host };
}

/** A relative URL is the page's own by definition; an unparseable one is treated as the page's. */
export function isFirstParty(url: string, pageUrl: string): boolean {
  return classifyUrl(url, pageUrl).firstParty;
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

/** A run of near-identical console errors, collapsed. */
export interface CollapsedConsoleError {
  /** First occurrence — the one whose message and source are printed. */
  entry: ConsoleEntry;
  count: number;
  firstAt: number;
  lastAt: number;
  /** True when members' raw messages differed and normalization merged them. */
  variants: boolean;
}

/**
 * Volatile substrings replaced before two messages are compared. The list is
 * deliberately narrow — every entry is a value that changes on every call and
 * identifies nothing. Over-collapsing hides distinct bugs, which is worse than
 * printing a repeat, so anything that could plausibly distinguish two errors
 * is left alone: HTTP statuses, short numeric codes, line and column numbers,
 * short ids, and every word of the message text.
 *
 * Digit runs are only normalized at 10+ characters (epoch seconds are 10,
 * milliseconds 13) and hex runs at 12+, which is why `Error 404` and
 * `Error 500` stay two errors while `Request 1755209630123 failed` and
 * `Request 1755209630130 failed` become one.
 */
const VOLATILE_TEXT: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  [/\b\d{10,}\b/g, '<num>'],
  [/(:\/\/[^\s/:]+):\d{2,5}\b/g, '$1:<port>'],
];

/** Grouping form of a message. Never displayed — the raw first message is. */
export function normalizeConsoleMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of VOLATILE_TEXT) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Collapses console errors the way collapseFailures collapses network
 * failures. THE rule, stated once: same level, same source location, and an
 * identical message after normalizing the volatile substrings above. Nothing
 * fuzzy — no edit distance, no prefix matching — because a page printing 15
 * identical errors and a page printing 15 different ones must not read the
 * same, in either direction.
 *
 * Entries with no source only group with other entries that also have none:
 * an unattributable error is the case least safe to merge.
 */
export function collapseConsoleErrors(entries: ConsoleEntry[]): CollapsedConsoleError[] {
  const groups = new Map<
    string,
    { entry: ConsoleEntry; raw: Set<string>; count: number; firstAt: number; lastAt: number }
  >();
  for (const entry of entries) {
    const key = [entry.level, entry.source ?? '', normalizeConsoleMessage(entry.message)].join(' ');
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        entry,
        raw: new Set([entry.message]),
        count: 1,
        firstAt: entry.timestamp,
        lastAt: entry.timestamp,
      });
      continue;
    }
    existing.count += 1;
    existing.raw.add(entry.message);
    existing.firstAt = Math.min(existing.firstAt, entry.timestamp);
    existing.lastAt = Math.max(existing.lastAt, entry.timestamp);
  }

  return [...groups.values()].map(({ entry, raw, count, firstAt, lastAt }) => ({
    entry,
    count,
    firstAt,
    lastAt,
    variants: raw.size > 1,
  }));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function timeOfDay(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * `15×, 21:33:50–21:34:07` — the repetition half of formatFailureLine, in
 * wall time instead of duration, since a console error has no duration.
 * Empty for a single occurrence, so an un-repeated error prints exactly as
 * it did before. `(variants)` marks a group whose raw messages differed,
 * mirroring the network line's marker.
 */
export function formatConsoleRepetition(group: CollapsedConsoleError): string {
  if (group.count < 2) return '';
  const first = timeOfDay(group.firstAt);
  const last = timeOfDay(group.lastAt);
  const span = first === last ? first : `${first}–${last}`;
  return `${group.count}×, ${span}${group.variants ? ' (variants)' : ''}`;
}

/** A host that was demoted, and why — the hosts line prints both. */
export interface DemotedHost {
  host: string;
  reason: Exclude<PartyReason, 'same-domain'>;
}

export interface PartySplit<T> {
  firstParty: T[];
  thirdParty: T[];
  /** Hosts classified third-party, with the reason, for the inspectability line. */
  thirdPartyHosts: DemotedHost[];
}

function splitByParty<T>(
  items: T[],
  urlOf: (item: T) => string | undefined,
  pageUrl: string,
  /** Console errors classify on domain alone — see splitConsoleErrors. */
  domainOnly = false,
): PartySplit<T> {
  const firstParty: T[] = [];
  const thirdParty: T[] = [];
  const hosts = new Map<string, DemotedHost>();
  for (const item of items) {
    const url = urlOf(item);
    // No resolvable source → first-party. An unattributable failure is more
    // dangerous de-emphasized than shown; the same reasoning as the
    // recorder-status line.
    if (!url) {
      firstParty.push(item);
      continue;
    }
    const verdict = classifyUrl(url, pageUrl);
    const demoted = domainOnly ? verdict.reason === 'cross-domain' : !verdict.firstParty;
    if (!demoted) {
      firstParty.push(item);
      continue;
    }
    thirdParty.push(item);
    if (verdict.host && !hosts.has(verdict.host)) {
      hosts.set(verdict.host, {
        host: verdict.host,
        reason: verdict.reason === 'telemetry-shape' ? 'telemetry-shape' : 'cross-domain',
      });
    }
  }
  return {
    firstParty,
    thirdParty,
    thirdPartyHosts: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)),
  };
}

/**
 * `doubleclick.net (other domain)`, or for the case most likely to be a
 * misjudgment: `play.google.com (telemetry path — same domain as the page)`.
 * A demoted host that shares the page's domain must say so, or it reads
 * identically to an obvious third party.
 */
export function formatDemotedHost(entry: DemotedHost): string {
  return entry.reason === 'telemetry-shape'
    ? `${entry.host} (telemetry path — same domain as the page)`
    : `${entry.host} (other domain)`;
}

export function splitFailures(failures: NetworkFailure[], pageUrl: string): PartySplit<NetworkFailure> {
  return splitByParty(failures, (f) => f.url, pageUrl);
}

/**
 * Console errors carry a `file:line:col` source from the stack or the error
 * event. Entries with no source stay first-party by the rule above.
 */
export function splitConsoleErrors(errors: ConsoleEntry[], pageUrl: string): PartySplit<ConsoleEntry> {
  // Domain rule only: an error's source is a script URL, and script-name
  // heuristics ("analytics.js") are far weaker evidence than endpoint paths.
  // A same-domain script keeps its errors in the main section.
  return splitByParty(
    errors,
    (e) => (e.source ? e.source.replace(/:\d+:\d+$/, '') : undefined),
    pageUrl,
    true,
  );
}

/** Union of demoted hosts on a page, for the report's inspectability line. */
export function mergeHosts(...lists: DemotedHost[][]): DemotedHost[] {
  const merged = new Map<string, DemotedHost>();
  for (const entry of lists.flat()) {
    // A host demoted for both reasons on one page keeps the same-domain
    // explanation, since that is the one worth questioning.
    const existing = merged.get(entry.host);
    if (!existing || entry.reason === 'telemetry-shape') merged.set(entry.host, entry);
  }
  return [...merged.values()].sort((a, b) => a.host.localeCompare(b.host));
}
