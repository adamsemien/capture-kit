/**
 * Local-vs-deployed classification for the report's context block.
 *
 * The question this answers is the one an AI assistant reading a report always
 * has to ask and never can: is this a dev server on the author's machine, or
 * is it production? Guessing wrong in either direction wastes a debugging
 * session — "it works on my machine" and "we shipped this broken" are opposite
 * conclusions drawn from the same screenshot.
 *
 * The rule is a hostname test, nothing cleverer. No heuristics on the path, no
 * port sniffing (production runs on 8080 often enough), no TLS check (a local
 * dev server with a self-signed cert is still local).
 */

export type Environment = 'local' | 'deployed';

export interface EnvironmentMarker {
  kind: Environment;
  /** What the report prints, e.g. "local (localhost)" or "deployed". */
  label: string;
}

/** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — the RFC 1918 private ranges. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Hostname as URL.hostname gives it: lowercase, and IPv6 wrapped in brackets.
 * The bracket strip is what makes `http://[::1]:3000` classify as local.
 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  // Any 127.x.x.x is loopback, not just .0.0.1.
  if (/^127\./.test(host) && isIpv4Shaped(host)) return true;
  if (host.endsWith('.local')) return true;
  if (isPrivateIpv4(host)) return true;
  return false;
}

function isIpv4Shaped(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * A URL that will not parse is reported as deployed with the raw string. The
 * asymmetry is deliberate: calling an unknown page "local" invites a reader to
 * dismiss a real production failure, while calling it "deployed" only invites
 * a second look.
 */
export function classifyEnvironment(url: string): EnvironmentMarker {
  if (!url) return { kind: 'deployed', label: 'deployed (no URL)' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'deployed', label: `deployed (unrecognized URL: ${url})` };
  }
  if (parsed.protocol === 'file:') return { kind: 'local', label: 'local (file://)' };
  if (isLocalHostname(parsed.hostname)) {
    return { kind: 'local', label: `local (${parsed.host})` };
  }
  return { kind: 'deployed', label: `deployed (${parsed.host})` };
}
