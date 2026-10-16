/*
 * Clip recording, the pure half (NOBC-158).
 *
 * A recorded clip is sampled into a ring of frames. An AI assistant cannot
 * watch the video, so what it gets is the frames where the picture actually
 * changed, laid out on one sheet with timestamps, plus the console and
 * network events that happened during the clip at the same offsets. Nothing
 * here touches a canvas or the browser: inputs are small grey thumbnails and
 * timestamps, outputs are decisions and text, so all of it is unit-tested.
 */

import type { ConsoleEntry, NetworkFailure } from '../messages';

/** One sampled frame, as the recorder keeps it: when, and a tiny grey copy for comparison. */
export interface SampledFrame {
  /** Milliseconds since the recording started. */
  at: number;
  /** Row-major 8-bit luma, THUMB_W x THUMB_H. */
  luma: Uint8Array;
}

/** Thumbnail size used for the change score. Small on purpose - this is "did it change", not "what changed". */
export const THUMB_W = 96;
export const THUMB_H = 60;

/** A pixel whose luma moved by more than this counts as changed; below it is noise. */
const PIXEL_CHANGE_FLOOR = 20;

/**
 * How much of the picture changed between two thumbnails, as a percentage of
 * pixels that moved past the noise floor. A percentage, not a mean: a small
 * element crossing a big page is exactly the change worth keeping, and a
 * mean over the whole frame buries it.
 */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > PIXEL_CHANGE_FLOOR) changed++;
  return (changed * 100) / n;
}

export interface SelectOptions {
  /** Frames kept at most, first and last included. */
  maxFrames?: number;
  /** Percent of pixels; a frame under this against the last kept one is "the same picture". */
  minChange?: number;
}

const DEFAULT_MAX_FRAMES = 12;
/** Percent of pixels. 0.3% of a 96x60 thumbnail is about 17 pixels - a 160 px box on a 2560 px page is ~40. */
const DEFAULT_MIN_CHANGE = 0.3;

/**
 * Which sampled frames go on the sheet. The first and last always do - they
 * are the before and after. In between, a frame is a candidate when it differs
 * from the previously kept frame by more than the floor, so a page that sits
 * still yields two frames and a page that animates yields the moments it
 * moved. Past the cap, the candidates with the biggest change win, and the
 * result is returned in time order. Indices into the input.
 */
export function selectFrames(frames: SampledFrame[], options: SelectOptions = {}): number[] {
  const maxFrames = Math.max(2, options.maxFrames ?? DEFAULT_MAX_FRAMES);
  const minChange = options.minChange ?? DEFAULT_MIN_CHANGE;
  if (frames.length === 0) return [];
  if (frames.length === 1) return [0];
  const last = frames.length - 1;
  // Candidates with their change score against the previously kept frame.
  const candidates: { index: number; score: number }[] = [];
  let keptLuma = frames[0].luma;
  for (let i = 1; i < last; i++) {
    const score = frameDifference(frames[i].luma, keptLuma);
    if (score >= minChange) {
      candidates.push({ index: i, score });
      keptLuma = frames[i].luma;
    }
  }
  const room = maxFrames - 2;
  const chosen = candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, room))
    .map((c) => c.index)
    .sort((a, b) => a - b);
  return [0, ...chosen, last];
}

// ----------------------------------------------------------- the sheet --

export interface SheetLayout {
  columns: number;
  rows: number;
  /** Size of one frame tile on the sheet. */
  tileWidth: number;
  tileHeight: number;
  /** Space under each tile for its timestamp label. */
  labelHeight: number;
  gap: number;
  width: number;
  height: number;
  /** Top-left of each tile, in order. */
  tiles: { x: number; y: number }[];
}

export interface SheetOptions {
  /** Width of the whole sheet; tiles scale to fit the columns. */
  sheetWidth?: number;
  columns?: number;
  labelHeight?: number;
  gap?: number;
}

/**
 * A grid that fits `count` frames of the given aspect ratio: three across by
 * default (a 1440x900 capture gives tiles a reader can still make out), as
 * many rows as it takes. Pure arithmetic so the offscreen page just draws.
 */
export function sheetLayout(
  count: number,
  frameWidth: number,
  frameHeight: number,
  options: SheetOptions = {},
): SheetLayout {
  const columns = Math.max(1, Math.min(count, options.columns ?? 3));
  const gap = options.gap ?? 16;
  const labelHeight = options.labelHeight ?? 28;
  const sheetWidth = options.sheetWidth ?? 1800;
  const tileWidth = Math.floor((sheetWidth - gap * (columns + 1)) / columns);
  const aspect = frameWidth > 0 && frameHeight > 0 ? frameHeight / frameWidth : 9 / 16;
  const tileHeight = Math.max(1, Math.round(tileWidth * aspect));
  const rows = Math.max(1, Math.ceil(count / columns));
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    tiles.push({
      x: gap + col * (tileWidth + gap),
      y: gap + row * (tileHeight + labelHeight + gap),
    });
  }
  return {
    columns,
    rows,
    tileWidth,
    tileHeight,
    labelHeight,
    gap,
    width: sheetWidth,
    height: gap + rows * (tileHeight + labelHeight + gap),
    tiles,
  };
}

// --------------------------------------------------------- the timeline --

/** `+1.20s` - offsets inside the clip, two decimals, always signed so they read as relative. */
export function offsetLabel(ms: number): string {
  return `+${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

export interface ClipEvent {
  offsetMs: number;
  kind: 'console' | 'network';
  level?: ConsoleEntry['level'];
  text: string;
}

/**
 * The recorder's console and network entries that fall inside the clip,
 * expressed as offsets from its start. Entries carry wall-clock timestamps,
 * so the clip's own start time is the only thing needed to line them up.
 */
export function eventsDuringClip(
  console: ConsoleEntry[],
  network: NetworkFailure[],
  startedAt: number,
  durationMs: number,
): ClipEvent[] {
  const end = startedAt + durationMs;
  const events: ClipEvent[] = [];
  for (const entry of console) {
    if (entry.timestamp < startedAt || entry.timestamp > end) continue;
    const text = entry.source ? `${entry.message}\n    at ${entry.source}` : entry.message;
    events.push({ offsetMs: entry.timestamp - startedAt, kind: 'console', level: entry.level, text });
  }
  for (const entry of network) {
    if (entry.timestamp < startedAt || entry.timestamp > end) continue;
    const status = entry.status === 0 ? 'no response' : `HTTP ${entry.status}`;
    events.push({
      offsetMs: entry.timestamp - startedAt,
      kind: 'network',
      text: `${entry.method} ${entry.url} - ${status} (${entry.durationMs} ms)`,
    });
  }
  return events.sort((a, b) => a.offsetMs - b.offsetMs);
}

// ----------------------------------------------------------- the report --

export interface ClipReportInput {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  userAgent: string;
  startedAt: Date;
  durationMs: number;
  /** How it was triggered - printed like the capture report's line. */
  triggerLabel: string;
  recorderActive: boolean;
  /** Offsets of the frames on the sheet, in order. */
  frameOffsetsMs: number[];
  /** How many frames were sampled before selection. */
  sampledFrames: number;
  sheetFilename: string;
  videoFilename: string;
  events: ClipEvent[];
  /** Values scrubbed from the record (NOBC-152). */
  redacted?: string;
  /** The source-map line (NOBC-153), when there were frames to map. */
  sourceMaps?: string;
}

function fence(text: string): string {
  return '~~~\n' + text.replace(/~~~/g, '~ ~ ~') + '\n~~~';
}

/**
 * The clip report. Written for an assistant that will be handed the sheet
 * image and this text: it says what each tile is, then what happened and
 * when, and it points at the video for the human.
 */
export function buildClipMarkdown(input: ClipReportInput): string {
  const seconds = (input.durationMs / 1000).toFixed(1);
  const parts: string[] = [];
  parts.push(`# Clip — ${input.title || '(untitled)'}`);
  parts.push(
    [
      `- **URL:** ${input.url}`,
      `- **Title:** ${input.title || '(untitled)'}`,
      `- **Recorded at:** ${input.startedAt.toISOString()}`,
      `- **Length:** ${seconds} s`,
      `- **Triggered by:** ${input.triggerLabel}`,
      `- **Viewport:** ${input.viewport.width} × ${input.viewport.height}`,
      `- **Frames:** ${input.sheetFilename} — ${input.frameOffsetsMs.length} of ${input.sampledFrames} sampled frames, the ones where the picture changed`,
      `- **Video:** ${input.videoFilename} — for a person; assistants read the frames and the timeline below`,
      `- **Recorder:** ${
        input.recorderActive
          ? 'active since page load — console and network data below are complete'
          : 'NOT ACTIVE for this page — console and network data are unavailable, not empty'
      }`,
      `- **User agent:** ${input.userAgent}`,
      ...(input.redacted ? [`- **Redacted:** ${input.redacted}`] : []),
      ...(input.sourceMaps ? [`- **Source maps:** ${input.sourceMaps}`] : []),
    ].join('\n'),
  );
  parts.push('## Frames on the sheet');
  parts.push(
    'Read left to right, top to bottom. Each tile is labelled with its offset into the clip.\n\n' +
      input.frameOffsetsMs.map((ms, i) => `${i + 1}. ${offsetLabel(ms)}`).join('\n'),
  );
  parts.push('## What happened during the clip');
  if (!input.recorderActive) {
    parts.push('> Recorder not active for this page — reload the tab, reproduce, and record again.');
  } else if (input.events.length === 0) {
    parts.push('No console output or failed requests during the clip.');
  } else {
    parts.push(
      input.events
        .map((event) => {
          const tag = event.kind === 'console' ? event.level ?? 'log' : 'network';
          return fence(`${offsetLabel(event.offsetMs)} [${tag}] ${event.text}`);
        })
        .join('\n\n'),
    );
  }
  return parts.join('\n\n') + '\n';
}

/** Clip lengths the setting allows. */
export const CLIP_SECONDS_MIN = 2;
export const CLIP_SECONDS_MAX = 10;
export const CLIP_SECONDS_DEFAULT = 5;

export function clampClipSeconds(value: number): number {
  if (!Number.isFinite(value)) return CLIP_SECONDS_DEFAULT;
  return Math.min(CLIP_SECONDS_MAX, Math.max(CLIP_SECONDS_MIN, Math.round(value)));
}
