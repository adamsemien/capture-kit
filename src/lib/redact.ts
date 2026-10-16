/*!
 * Secret scrubbing for Capture Kit reports.
 *
 * The secret shapes, the JWT check and the Bearer/JSON-key patterns are
 * adapted from BrowserTools MCP (src/util/redact.ts, commit 99acee8),
 * MIT License, Copyright (c) 2025 AgentDesk LLC. The full license text is in
 * THIRD_PARTY_NOTICES.md, which ships inside the extension.
 *
 * Changes from the original: every replacement is counted so the report can
 * say how many values it hid; URL query values and inline header lines are
 * scrubbed by name; a private key cut off before its END line is still caught;
 * a few name rules are narrowed so ordinary log text survives ("author" is not
 * "auth", and an id must contain a digit to count as a token).
 */

import type { ConsoleEntry, NetworkFailure, PageMeta } from './messages';

export const REDACTED = '[REDACTED]';

/**
 * High-confidence secret shapes, anchored to vendor prefixes so ordinary log
 * text is left alone. A false positive destroys the debugging information the
 * report exists to carry, so every rule here errs towards missing a value
 * rather than mangling a sentence.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks - first, because they span lines. The second form
  // catches a block the recorder's message-length cap cut off before its END.
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*$/g,
  // Vendor session and client ids, e.g. Clerk's sess_... - bearer-equivalent.
  // The run must hold a digit: "session_initializedSuccessfully" is a log
  // message, not a credential.
  /\b(?:sess|session|client|tok|token|auth|cred|secret|apikey)_(?=[A-Za-z]*[0-9])[A-Za-z0-9]{16,}\b/gi,
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  // GitHub tokens, classic and fine-grained.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // OpenAI / Anthropic style keys.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // Stripe and similar prefixed live/test keys.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
];

/**
 * JSON Web Token candidates: base64url starting with an encoded '{"'. That
 * alone is not enough - any base64-encoded JSON starts the same way (Clerk
 * encodes image parameters like this) - so isJwt() checks each one.
 */
const JWT_CANDIDATE = /\beyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2}/g;

/** Fields a JWT header carries and ordinary encoded JSON does not. */
const JWT_HEADER_FIELDS = /"(?:alg|typ|kid)"/;

function decodeBase64Prefix(value: string): string {
  // A whole number of base64 groups, since the tail may be cut off.
  const usable = value.slice(0, 40);
  const aligned = usable.slice(0, usable.length - (usable.length % 4));
  if (aligned.length === 0) return '';
  try {
    return atob(aligned.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return '';
  }
}

/**
 * Three dot-separated segments is JWT-shaped whatever it holds. With fewer -
 * what truncation leaves behind - the header is decoded and checked.
 */
export function isJwt(candidate: string): boolean {
  if (candidate.split('.').length >= 3) return true;
  return JWT_HEADER_FIELDS.test(decodeBase64Prefix(candidate.split('.')[0] ?? ''));
}

/** `Authorization: Bearer <token>` style values inline in text. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/**
 * JSON `"password": "..."` pairs, matched by key name because the value has
 * no shape of its own. Narrower than the original's bare "auth", which also
 * hid `"author": "..."`.
 */
const SECRETISH_JSON_KEY =
  /("(?:[^"]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|authorization|auth[_-]?token|cookie)[^"]*)"\s*:\s*)"(?:[^"\\]|\\.)+"/gi;

/**
 * Query-string and fragment values whose NAME says credential:
 * ?access_token=..., &api_key=..., #id_token=..., X-Amz-Signature=...
 * Short generic names (key, sig, sid) only match exactly.
 */
const SECRETISH_QUERY =
  /([?&#;](?:[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential|signature)[A-Za-z0-9_.-]*|key|sig|auth|pwd|jwt|sid|session|sessionid|code_verifier)=)[^&#\s"'<>]+/gi;

/** `X-Api-Key: ...` style header lines pasted into a log. */
const SECRET_HEADER_LINE =
  /\b(x-api-key|api-key|x-auth-token|x-access-token|x-session-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key|x-functions-key|x-secret)(\s*:\s*)[^\s"',;]{8,}/gi;

/**
 * `Cookie: a=1; b=2` - the whole value, one replacement. It must hold an
 * "=" so a sentence like "Failed to set cookie: SameSite" survives.
 */
const COOKIE_HEADER_LINE = /\b((?:set-)?cookie\s*:\s*)[^\n]*=[^\n]*/gi;

function occurrences(text: string): number {
  let count = 0;
  for (let at = text.indexOf(REDACTED); at !== -1; at = text.indexOf(REDACTED, at + 1)) count++;
  return count;
}

export interface Redacted {
  text: string;
  /** Values replaced in this string. */
  count: number;
}

/**
 * Replaces secret-shaped substrings in one string and says how many.
 *
 * The count is the number of [REDACTED] markers this call added, so a value
 * two rules agree on counts once, and a string that already said [REDACTED]
 * is not counted again.
 */
export function redactText(input: string): Redacted {
  if (!input) return { text: input, count: 0 };
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(JWT_CANDIDATE, (match) => (isJwt(match) ? REDACTED : match));
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(SECRETISH_JSON_KEY, (_m, key: string) => `${key}"${REDACTED}"`);
  out = out.replace(SECRETISH_QUERY, (_m, name: string) => `${name}${REDACTED}`);
  out = out.replace(SECRET_HEADER_LINE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(COOKIE_HEADER_LINE, (_m, name: string) => `${name}${REDACTED}`);
  return { text: out, count: Math.max(0, occurrences(out) - occurrences(input)) };
}

export interface PageRecord {
  meta: PageMeta;
  console: ConsoleEntry[];
  network: NetworkFailure[];
}

export interface RedactedPage extends PageRecord {
  /** Values replaced across the URL, title, console and network entries. */
  redacted: number;
}

/**
 * THE seam. Everything a report, sweep, session index, clipboard block or
 * result tab prints about a page comes from one PageRecord, and the service
 * worker passes it through here before anything is built or written. The
 * screenshot is not touched: a key visible on the page is still in the image,
 * and the report says so.
 */
export function redactPage(page: PageRecord): RedactedPage {
  let redacted = 0;
  const scrub = (value: string): string => {
    const r = redactText(value);
    redacted += r.count;
    return r.text;
  };
  const meta: PageMeta = { ...page.meta, url: scrub(page.meta.url), title: scrub(page.meta.title) };
  const console = page.console.map((entry) => {
    const next: ConsoleEntry = { ...entry, message: scrub(entry.message) };
    if (entry.source !== undefined) next.source = scrub(entry.source);
    return next;
  });
  const network = page.network.map((entry) => ({ ...entry, url: scrub(entry.url) }));
  return { meta, console, network, redacted };
}

/**
 * The report line. Always printed - "none found" is a finding too, and the
 * reader needs the screenshot caveat either way.
 */
export function redactedLabel(count: number): string {
  const found =
    count > 0
      ? `${count} ${count === 1 ? 'value' : 'values'} that looked like passwords, tokens or keys, shown as ${REDACTED}`
      : 'none found';
  return `${found}. Only this text is scrubbed - anything visible on the page itself is still in the screenshot.`;
}
