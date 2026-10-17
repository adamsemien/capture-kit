/*
 * Which pages may fire a capture themselves (NOBC-162).
 *
 * The in-page trigger used to be one boolean with no origin check: on meant
 * any site you visited could fire a capture, bring its tab to the front and
 * write a file. This replaces it with the three choices Chrome itself offers
 * for site access - Off, Allowed sites, Any page - so the common case
 * (an assistant driving localhost) can be on without opening every site.
 *
 * Pure functions only, so the matching is unit-tested.
 */

export type PageTriggerMode = 'off' | 'allowed' | 'any';

export const PAGE_TRIGGER_MODES: readonly PageTriggerMode[] = ['off', 'allowed', 'any'];

/** Pre-filled so switching to "Allowed sites" works for local dev straight away. */
export const DEFAULT_TRIGGER_SITES: readonly string[] = ['localhost', '127.0.0.1'];

export function normalizeTriggerMode(value: unknown): PageTriggerMode {
  return value === 'allowed' || value === 'any' ? value : 'off';
}

export interface SitePattern {
  /** Lower-case host; a leading "*." means the host and every subdomain. */
  host: string;
  wildcard: boolean;
  /** Empty when any port matches. */
  port: string;
}

/**
 * One line of the allowed-sites box, as a person would type it:
 * "localhost:3000", "https://app.example.com/path", "*.example.com",
 * "example.com". Scheme and path are ignored - access is per host (and port,
 * when one is given). Null for a line that names no host.
 */
export function parseSitePattern(line: string): SitePattern | null {
  let text = line.trim().toLowerCase();
  if (!text || text.startsWith('#')) return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split(/[/?#]/, 1)[0];
  let wildcard = false;
  if (text.startsWith('*.')) {
    wildcard = true;
    text = text.slice(2);
  }
  let port = '';
  // IPv6 literals are bracketed; everything else splits on the last colon.
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  let host: string;
  if (v6) {
    host = `[${v6[1]}]`;
    port = v6[2] ?? '';
  } else {
    const colon = text.lastIndexOf(':');
    if (colon !== -1) {
      port = text.slice(colon + 1);
      text = text.slice(0, colon);
      if (!/^\d+$/.test(port)) return null;
    }
    host = text;
  }
  if (!host || !/^[a-z0-9.\-[\]:_]+$/.test(host)) return null;
  return { host, wildcard, port };
}

/** The textarea's lines, cleaned and de-duplicated, in the order typed. */
export function normalizeSiteList(value: unknown): string[] {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const out: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') continue;
    const line = raw.trim();
    if (!line || !parseSitePattern(line)) continue;
    if (!out.some((existing) => existing.toLowerCase() === line.toLowerCase())) out.push(line);
  }
  return out;
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}

export function siteMatches(pattern: SitePattern, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const hostOk = pattern.wildcard
    ? host === pattern.host || host.endsWith(`.${pattern.host}`)
    : host === pattern.host;
  if (!hostOk) return false;
  if (!pattern.port) return true;
  return (url.port || defaultPort(url.protocol)) === pattern.port;
}

export type TriggerDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether a page at `pageUrl` may fire a capture. The reason strings are what
 * the page receives on capture-kit:capture-complete, so an agent can tell
 * "refused, and here is the setting" from "broken".
 */
export function decidePageTrigger(
  mode: PageTriggerMode,
  sites: readonly string[],
  pageUrl: string | undefined,
): TriggerDecision {
  if (mode === 'off') return { allowed: false, reason: 'in-page trigger is turned off in Settings' };
  if (mode === 'any') return { allowed: true };
  let url: URL;
  try {
    url = new URL(pageUrl ?? '');
  } catch {
    return { allowed: false, reason: 'in-page trigger could not read this page\'s address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `in-page trigger only matches http and https sites in "Allowed sites" mode, not ${url.protocol}// pages`,
    };
  }
  for (const line of sites) {
    const pattern = parseSitePattern(line);
    if (pattern && siteMatches(pattern, url)) return { allowed: true };
  }
  return {
    allowed: false,
    reason: `in-page trigger is not allowed on ${url.host} - add it under Settings → Automation → Allowed sites`,
  };
}
