/*
 * Source-map resolution for report frames (NOBC-153).
 *
 * A built site reports errors as `chunk-8f3a.js:1:48213`, which tells an AI
 * assistant nothing. When the site publishes a source map, this turns the
 * frame back into `src/components/EventForm.tsx:84:12`. Everything here runs
 * in the service worker after the capture, on the frames the recorder already
 * captured - no debugger attach, no banner, nothing injected into the page.
 *
 * The format decoded is Source Map revision 3 (the `mappings` string of
 * base64 VLQ segments). Only the `sources` / `mappings` / `sourceRoot` fields
 * are read; indexed maps with `sections` are treated as absent.
 */

import type { ConsoleEntry, PageMeta, NetworkFailure } from './messages';

export interface Frame {
  url: string;
  /** 1-based, as stack traces print them. */
  line: number;
  /** 1-based, as stack traces print them. */
  column: number;
}

export interface MappedFrame {
  /** Cleaned original path, e.g. src/components/EventForm.tsx */
  file: string;
  line: number;
  column: number;
}

// ------------------------------------------------------------- frames --

/** `url:line:col`, as the recorder writes its call sites. */
const FRAME_TAIL = /^(.*?):(\d+):(\d+)$/;

/**
 * Frames inside free text - the stack lines formatArg() appends to an Error,
 * or a bare call site. Only http(s) URLs: nothing else can be fetched, so
 * nothing else can be mapped.
 */
const FRAME_IN_TEXT = /\bhttps?:\/\/[^\s()]+?:(\d+):(\d+)\b/g;

export function parseFrame(source: string): Frame | null {
  const match = FRAME_TAIL.exec(source);
  if (!match) return null;
  const url = match[1];
  if (!/^https?:\/\//.test(url)) return null;
  return { url, line: Number(match[2]), column: Number(match[3]) };
}

// --------------------------------------------------------- VLQ decode --

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64: Record<string, number> = {};
for (let i = 0; i < BASE64.length; i++) B64[BASE64[i]] = i;

/** One generated-line segment: [generatedColumn, sourceIndex, originalLine, originalColumn], all 0-based. */
type Segment = [number, number, number, number];

/**
 * Decodes a `mappings` string into one sorted segment list per generated line.
 * Segments without a source (one-field segments) are dropped - they map to
 * nothing. Decoding is lazy per line would be nicer for huge maps; a whole
 * decode is simpler and bounded by the map-size cap at fetch time.
 */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let genCol = 0;
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let i = 0;
  const n = mappings.length;
  const readVlq = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= n) throw new Error('truncated VLQ');
      const digit = B64[mappings[i++]];
      if (digit === undefined) throw new Error('bad VLQ char');
      result += (digit & 31) << shift;
      shift += 5;
      if ((digit & 32) === 0) break;
    }
    const negative = (result & 1) === 1;
    result >>>= 1;
    return negative ? -result : result;
  };
  while (i < n) {
    const ch = mappings[i];
    if (ch === ';') {
      lines.push(line);
      line = [];
      genCol = 0;
      i++;
      continue;
    }
    if (ch === ',') {
      i++;
      continue;
    }
    genCol += readVlq();
    let hasSource = false;
    if (i < n && mappings[i] !== ',' && mappings[i] !== ';') {
      srcIdx += readVlq();
      origLine += readVlq();
      origCol += readVlq();
      hasSource = true;
      // Optional name index - read and discard.
      if (i < n && mappings[i] !== ',' && mappings[i] !== ';') readVlq();
    }
    if (hasSource) line.push([genCol, srcIdx, origLine, origCol]);
  }
  lines.push(line);
  return lines;
}

// --------------------------------------------------------- the index --

export interface RawSourceMap {
  version?: number;
  sources?: string[];
  sourceRoot?: string;
  mappings?: string;
  sections?: unknown;
}

/**
 * Turns a map's source path into something a reader can open. Bundlers
 * prefix sources with their own scheme (`webpack://_N_E/./src/x.tsx`,
 * `webpack:///./src/x.tsx`) or with `../../` climbs out of the output folder;
 * both are noise in a report.
 */
export function cleanSourcePath(source: string, sourceRoot?: string): string {
  let path = source;
  if (sourceRoot && !/^[a-z]+:/i.test(path)) path = sourceRoot.replace(/\/?$/, '/') + path;
  path = path.replace(/^webpack:\/\/[^/]*\//, '').replace(/^(?:[a-z]+:)?\/\/\/?/i, '');
  path = path.replace(/^(?:\.\.\/|\.\/)+/, '');
  return path;
}

export class SourceMapIndex {
  private readonly lines: Segment[][];
  private readonly sources: string[];
  private readonly sourceRoot: string | undefined;

  constructor(map: RawSourceMap) {
    this.lines = decodeMappings(map.mappings ?? '');
    this.sources = map.sources ?? [];
    this.sourceRoot = map.sourceRoot;
  }

  /** Both inputs 1-based (stack-trace convention); the result is too. */
  lookup(line: number, column: number): MappedFrame | null {
    const segments = this.lines[line - 1];
    if (!segments || segments.length === 0) return null;
    const target = column - 1;
    // Greatest segment whose generated column is <= target.
    let lo = 0;
    let hi = segments.length - 1;
    if (segments[0][0] > target) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid][0] <= target) lo = mid;
      else hi = mid - 1;
    }
    const [, srcIdx, origLine, origCol] = segments[lo];
    const source = this.sources[srcIdx];
    if (source === undefined) return null;
    return { file: cleanSourcePath(source, this.sourceRoot), line: origLine + 1, column: origCol + 1 };
  }
}

/** Parses map JSON; null for anything this module does not understand. */
export function parseSourceMap(text: string): SourceMapIndex | null {
  try {
    const raw = JSON.parse(text) as RawSourceMap;
    if (!raw || typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) return null;
    if (raw.sections !== undefined) return null;
    return new SourceMapIndex(raw);
  } catch {
    return null;
  }
}

// ------------------------------------------------------ finding a map --

const SOURCE_MAPPING_COMMENT = /\/[/*][#@]\s*sourceMappingURL=([^\s*]+)/g;

/**
 * Where a script's map lives: the `SourceMap` (or legacy `X-SourceMap`)
 * response header wins, else the last `sourceMappingURL` comment in the
 * script. Null when the site publishes neither - which is most live sites.
 */
export function findSourceMapUrl(
  scriptUrl: string,
  headers: { get(name: string): string | null },
  scriptText: string,
): string | null {
  const header = headers.get('SourceMap') ?? headers.get('X-SourceMap');
  const ref = header ?? lastComment(scriptText);
  if (!ref) return null;
  if (/^data:/i.test(ref)) return ref;
  try {
    return new URL(ref, scriptUrl).toString();
  } catch {
    return null;
  }
}

function lastComment(text: string): string | null {
  // The comment sits at the end; only the tail is scanned so a 5 MB bundle
  // costs nothing extra.
  const tail = text.length > 4096 ? text.slice(-4096) : text;
  let last: string | null = null;
  for (const m of tail.matchAll(SOURCE_MAPPING_COMMENT)) last = m[1];
  return last;
}

/** Decodes a `data:application/json;base64,...` map URL to its JSON text. */
export function dataUrlText(url: string): string | null {
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const header = url.slice(0, comma);
  const body = url.slice(comma + 1);
  try {
    if (/;base64/i.test(header)) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- the pass --

export interface PageRecord {
  meta: PageMeta;
  console: ConsoleEntry[];
  network: NetworkFailure[];
}

export interface MappedPage extends PageRecord {
  /** Frames found in console entries, mapped or not. */
  frames: number;
  /** Frames rewritten to their original file and line. */
  mappedFrames: number;
}

/** What one script resolved to - cached per capture so a frame costs one fetch. */
type MapResult = SourceMapIndex | null;

export interface MapperOptions {
  fetch: (url: string) => Promise<{ ok: boolean; text(): Promise<string>; headers: { get(name: string): string | null } } | null>;
  /** Distinct scripts resolved per capture; frames past this are left raw. */
  maxScripts?: number;
  /** Largest map text accepted, in characters. */
  maxMapChars?: number;
}

const DEFAULT_MAX_SCRIPTS = 12;
const DEFAULT_MAX_MAP_CHARS = 25_000_000;

/**
 * Resolves one script's map through the cache. Any failure - no map, a map
 * too big to decode, a network error - resolves to null, and the frame is
 * printed raw with a note. Mapping must never fail a capture.
 */
export class FrameMapper {
  private readonly cache = new Map<string, Promise<MapResult>>();
  private readonly options: Required<MapperOptions>;

  constructor(options: MapperOptions) {
    this.options = {
      fetch: options.fetch,
      maxScripts: options.maxScripts ?? DEFAULT_MAX_SCRIPTS,
      maxMapChars: options.maxMapChars ?? DEFAULT_MAX_MAP_CHARS,
    };
  }

  async map(frame: Frame): Promise<MappedFrame | null> {
    const index = await this.indexFor(frame.url);
    return index ? index.lookup(frame.line, frame.column) : null;
  }

  private indexFor(url: string): Promise<MapResult> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    if (this.cache.size >= this.options.maxScripts) return Promise.resolve(null);
    const promise = this.resolve(url).catch(() => null);
    this.cache.set(url, promise);
    return promise;
  }

  private async resolve(scriptUrl: string): Promise<MapResult> {
    const response = await this.options.fetch(scriptUrl);
    if (!response || !response.ok) return null;
    const text = await response.text();
    const mapUrl = findSourceMapUrl(scriptUrl, response.headers, text);
    if (!mapUrl) return null;
    let mapText: string | null;
    if (/^data:/i.test(mapUrl)) {
      mapText = dataUrlText(mapUrl);
    } else {
      const mapResponse = await this.options.fetch(mapUrl);
      if (!mapResponse || !mapResponse.ok) return null;
      mapText = await mapResponse.text();
    }
    if (!mapText || mapText.length > this.options.maxMapChars) return null;
    return parseSourceMap(mapText);
  }
}

/** How a frame prints once the pass has looked at it. */
export function formatFrame(raw: string, mapped: MappedFrame | null): string {
  if (!mapped) return `${raw} (no source map)`;
  return `${mapped.file}:${mapped.line}:${mapped.column} (mapped from ${shortScript(raw)})`;
}

/** `chunk-8f3a.js:1:48213` rather than the whole URL, which the mapped line no longer needs. */
function shortScript(raw: string): string {
  const frame = parseFrame(raw);
  if (!frame) return raw;
  const name = frame.url.split('?')[0].split('/').pop() || frame.url;
  return `${name}:${frame.line}:${frame.column}`;
}

/**
 * The pass. Every console entry's call site and every http(s) frame inside its
 * message is mapped where a map exists and tagged either way. Network entries
 * carry no frames. The input is not modified.
 */
export async function mapPageSources(page: PageRecord, mapper: FrameMapper): Promise<MappedPage> {
  let frames = 0;
  let mappedFrames = 0;
  const mapOne = async (raw: string): Promise<string> => {
    const frame = parseFrame(raw);
    if (!frame) return raw;
    frames += 1;
    const mapped = await mapper.map(frame);
    if (mapped) mappedFrames += 1;
    return formatFrame(raw, mapped);
  };
  const mapText = async (text: string): Promise<string> => {
    const hits = [...text.matchAll(FRAME_IN_TEXT)];
    if (hits.length === 0) return text;
    let out = '';
    let at = 0;
    for (const hit of hits) {
      const start = hit.index ?? 0;
      out += text.slice(at, start) + (await mapOne(hit[0]));
      at = start + hit[0].length;
    }
    return out + text.slice(at);
  };
  const entries: ConsoleEntry[] = [];
  for (const entry of page.console) {
    const next: ConsoleEntry = { ...entry, message: await mapText(entry.message) };
    if (entry.source !== undefined) next.source = await mapOne(entry.source);
    entries.push(next);
  }
  return { meta: page.meta, console: entries, network: page.network, frames, mappedFrames };
}

/** The report line. Printed only when the page had frames to look at. */
export function sourceMapLabel(frames: number, mappedFrames: number): string | null {
  if (frames === 0) return null;
  if (mappedFrames === 0) return `none of ${frames} ${frames === 1 ? 'frame' : 'frames'} had a source map - locations are as the browser reported them.`;
  return `${mappedFrames} of ${frames} ${frames === 1 ? 'frame' : 'frames'} mapped to the original file and line; the rest are as the browser reported them.`;
}
