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
 * from the previous candidate by more than the floor, so a page that sits
 * still yields two frames and a page that animates yields the moments it
 * moved. Past the cap, candidates are thinned so the survivors spread across
 * the clip: the one sitting closest to its neighbours goes first. Picking the
 * biggest changes instead bunched every frame into the fastest moments of a
 * continuous animation and left the slow stretches empty. Indices into the
 * input, in time order.
 *
 * Defined as the FramePicker run over the whole list, so what the recorder
 * keeps while recording and what lands on the sheet are the same thing.
 */
export function selectFrames(frames: SampledFrame[], options: SelectOptions = {}): number[] {
  const picker = new FramePicker(options);
  for (const frame of frames) picker.push(frame);
  return picker.held();
}

/**
 * Frame selection, run as the frames arrive, so the recorder only has to hold
 * full-size pixels for frames that can still end up on the sheet.
 *
 * Encoding a frame while recording costs about a second in the hidden
 * offscreen document, which starved the sampler down to one frame a second.
 * Instead every frame keeps only its thumbnail, and the picker says which
 * full-size frames can be let go. It holds the first frame, the newest frame
 * (it may turn out to be the last), and at most `maxFrames - 2` candidates in
 * between - never more than `maxFrames` in all.
 */
export class FramePicker {
  readonly frames: SampledFrame[] = [];
  private readonly room: number;
  private readonly minChange: number;
  private keptLuma: Uint8Array | null = null;
  private pending = -1;
  /** Candidates still in the running, in time order. */
  private candidates: { index: number; score: number }[] = [];

  constructor(options: SelectOptions = {}) {
    this.room = Math.max(2, options.maxFrames ?? DEFAULT_MAX_FRAMES) - 2;
    this.minChange = options.minChange ?? DEFAULT_MIN_CHANGE;
  }

  /** Add the next frame. Returns the indices whose full-size pixels are no longer needed. */
  push(frame: SampledFrame): number[] {
    const index = this.frames.length;
    this.frames.push(frame);
    if (index === 0) {
      this.keptLuma = frame.luma;
      this.pending = 0;
      return [];
    }
    const released: number[] = [];
    const previous = this.pending;
    this.pending = index;
    // The first frame is always kept; any other previous frame is now a
    // middle frame and is judged against the last candidate.
    if (previous <= 0) return released;
    const score = frameDifference(this.frames[previous].luma, this.keptLuma!);
    if (score < this.minChange) {
      released.push(previous);
      return released;
    }
    this.keptLuma = this.frames[previous].luma;
    this.candidates.push({ index: previous, score });
    while (this.candidates.length > this.room) released.push(this.thinOne());
    return released;
  }

  /**
   * Drop the candidate whose removal leaves the smallest hole: the one with
   * its neighbours closest together in time. Ties go to the smaller change,
   * then to the later frame. Returns its index.
   */
  private thinOne(): number {
    const c = this.candidates;
    const at = (i: number) => this.frames[i].at;
    let worst = 0;
    let worstGap = Infinity;
    for (let i = 0; i < c.length; i++) {
      const before = i === 0 ? at(0) : at(c[i - 1].index);
      const after = i === c.length - 1 ? at(this.pending) : at(c[i + 1].index);
      const gap = after - before;
      const w = c[worst];
      if (
        gap < worstGap ||
        (gap === worstGap && (c[i].score < w.score || (c[i].score === w.score && c[i].index > w.index)))
      ) {
        worst = i;
        worstGap = gap;
      }
    }
    return c.splice(worst, 1)[0].index;
  }

  /** Indices whose full-size pixels must still be kept, in time order. */
  held(): number[] {
    const held = new Set<number>();
    if (this.frames.length > 0) held.add(0);
    for (const c of this.candidates) held.add(c.index);
    if (this.pending >= 0) held.add(this.pending);
    return [...held].sort((a, b) => a - b);
  }
}

// ------------------------------------------------------ crop to change --

/** A rectangle in full-size frame pixels. */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropOptions {
  /** Thumbnail cells of margin kept around the change. */
  padCells?: number;
  /** Smallest crop, in frame pixels, so a tiny change keeps some context. */
  minWidth?: number;
  minHeight?: number;
  /** Past this share of the frame, cropping saves nothing: the whole frame is used. */
  maxShare?: number;
}

const DEFAULT_PAD_CELLS = 1;
const DEFAULT_MIN_CROP_W = 480;
const DEFAULT_MIN_CROP_H = 270;
const DEFAULT_MAX_CROP_SHARE = 0.6;

/**
 * The part of the picture that changed during the clip, so the sheet can show
 * it at full sharpness instead of the whole page at a fifth of its size
 * (NOBC-159). Built from the thumbnails every sampled frame already has: a
 * thumbnail cell counts when its brightness moved past the noise floor
 * between two consecutive frames. Null means "use the whole frame" - nothing
 * changed, or so much did that a crop would not help.
 */
export function changeBox(
  frames: SampledFrame[],
  frameWidth: number,
  frameHeight: number,
  options: CropOptions = {},
): CropBox | null {
  if (frames.length < 2 || frameWidth <= 0 || frameHeight <= 0) return null;
  let c0 = THUMB_W;
  let c1 = -1;
  let r0 = THUMB_H;
  let r1 = -1;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].luma;
    const b = frames[i].luma;
    for (let r = 0; r < THUMB_H; r++) {
      for (let c = 0; c < THUMB_W; c++) {
        const p = r * THUMB_W + c;
        if (Math.abs(a[p] - b[p]) <= PIXEL_CHANGE_FLOOR) continue;
        if (c < c0) c0 = c;
        if (c > c1) c1 = c;
        if (r < r0) r0 = r;
        if (r > r1) r1 = r;
      }
    }
  }
  if (c1 < 0) return null;
  const pad = options.padCells ?? DEFAULT_PAD_CELLS;
  c0 = Math.max(0, c0 - pad);
  r0 = Math.max(0, r0 - pad);
  c1 = Math.min(THUMB_W - 1, c1 + pad);
  r1 = Math.min(THUMB_H - 1, r1 + pad);
  const cellW = frameWidth / THUMB_W;
  const cellH = frameHeight / THUMB_H;
  let x = Math.floor(c0 * cellW);
  let y = Math.floor(r0 * cellH);
  let x2 = Math.min(frameWidth, Math.ceil((c1 + 1) * cellW));
  let y2 = Math.min(frameHeight, Math.ceil((r1 + 1) * cellH));
  // Grow a small box around its centre so the change keeps some context.
  const grow = (lo: number, hi: number, min: number, limit: number): [number, number] => {
    const want = Math.min(min, limit);
    if (hi - lo >= want) return [lo, hi];
    const centre = (lo + hi) / 2;
    let a = Math.round(centre - want / 2);
    a = Math.max(0, Math.min(limit - want, a));
    return [a, a + want];
  };
  [x, x2] = grow(x, x2, options.minWidth ?? DEFAULT_MIN_CROP_W, frameWidth);
  [y, y2] = grow(y, y2, options.minHeight ?? DEFAULT_MIN_CROP_H, frameHeight);
  const share = ((x2 - x) * (y2 - y)) / (frameWidth * frameHeight);
  if (share > (options.maxShare ?? DEFAULT_MAX_CROP_SHARE)) return null;
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Columns and sheet width for tiles of the given size. Tiles stay at their
 * real size when they fit - up to four across on a sheet no wider than the
 * cap - and only a crop too wide for two across is scaled down.
 */
export function sheetPlan(tileWidth: number, count: number, maxWidth = 2600, gap = 16): { columns: number; sheetWidth: number } {
  const fit = Math.floor((maxWidth - gap) / (tileWidth + gap));
  if (fit < 2) return { columns: 2, sheetWidth: Math.min(maxWidth, Math.max(1200, tileWidth)) };
  const columns = Math.max(1, Math.min(4, fit, count));
  return { columns, sheetWidth: columns * (tileWidth + gap) + gap };
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
  /** Folder holding the kept frames at full size, relative to the output folder. */
  framesFolder: string;
  events: ClipEvent[];
  /** Values scrubbed from the record (NOBC-152). */
  redacted?: string;
  /** The source-map line (NOBC-153), when there were frames to map. */
  sourceMaps?: string;
  /** The area the sheet was cropped to (NOBC-159), when it was cropped. */
  crop?: CropBox;
  /** Full frame size, for the crop line. */
  frameWidth?: number;
  frameHeight?: number;
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
      `- **Frames:** ${input.sheetFilename} — ${input.frameOffsetsMs.length} of ${input.sampledFrames} sampled frames, the ones where the picture changed; each at full size in ${input.framesFolder}/`,
      ...(input.crop
        ? [
            `- **Cropped to:** the area that changed — ${input.crop.width}×${input.crop.height} at (${input.crop.x}, ${input.crop.y}) of the ${input.frameWidth ?? '?'}×${input.frameHeight ?? '?'} tab, shown at full size; the whole tab is in each full-size frame`,
          ]
        : []),
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

/** `03_+1.25s.jpg` - the kept frame's place on the sheet and its offset, sortable in a file list. */
export function frameFilename(index: number, offsetMs: number): string {
  return `${String(index + 1).padStart(2, '0')}_${offsetLabel(offsetMs)}.jpg`;
}

/** Clip lengths the setting allows. */
export const CLIP_SECONDS_MIN = 2;
export const CLIP_SECONDS_MAX = 10;
export const CLIP_SECONDS_DEFAULT = 5;

/** Count-in before recording starts, so the hand that pressed the key can get to the thing. */
export const CLIP_DELAY_MIN = 0;
export const CLIP_DELAY_MAX = 5;
export const CLIP_DELAY_DEFAULT = 2;

export function clampClipDelay(value: number): number {
  if (!Number.isFinite(value)) return CLIP_DELAY_DEFAULT;
  return Math.min(CLIP_DELAY_MAX, Math.max(CLIP_DELAY_MIN, Math.round(value)));
}

export function clampClipSeconds(value: number): number {
  if (!Number.isFinite(value)) return CLIP_SECONDS_DEFAULT;
  return Math.min(CLIP_SECONDS_MAX, Math.max(CLIP_SECONDS_MIN, Math.round(value)));
}
