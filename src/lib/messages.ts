// Typed message protocol shared by every extension context. All cross-context
// payloads (MAIN world → isolated world, content script ↔ worker ↔ popup) are
// defined here so the compiler catches protocol drift.

export const RECORDER_EVENT = '__capture_kit__';
export const CONSOLE_BUFFER_CAP = 500;
export const NETWORK_BUFFER_CAP = 200;
export const CONSOLE_LOGS_IN_BUNDLE = 20;

export type ConsoleLevel = 'error' | 'warn' | 'log';

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
  /** "url:line:col" when a call site could be resolved. */
  source?: string;
  timestamp: number;
}

export interface NetworkFailure {
  method: string;
  url: string;
  /** HTTP status ≥ 400, or 0 when the request never got a response. */
  status: number;
  durationMs: number;
  timestamp: number;
}

export interface PageMeta {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  userAgent: string;
}

export interface BufferSnapshot {
  console: ConsoleEntry[];
  network: NetworkFailure[];
  meta: PageMeta;
  /** True when the MAIN-world recorder ran on this page since load. */
  mainWorldActive: boolean;
}

export interface BufferStats {
  consoleCount: number;
  networkCount: number;
  /** True when the MAIN-world recorder ran on this page since load. */
  mainWorldActive: boolean;
}

/** MAIN world → isolated world, serialized to JSON so it crosses as a primitive. */
export type RecorderEventDetail =
  | { kind: 'hello' }
  | { kind: 'console'; entry: ConsoleEntry }
  | { kind: 'network'; entry: NetworkFailure };

/** Page-level trigger for agents driving the browser. */
export const AGENT_CAPTURE_EVENT = 'capture-kit:capture';
export const AGENT_COMPLETE_EVENT = 'capture-kit:capture-complete';
/** Same gate, same completion event: a page asks for a clip instead of a still. */
export const AGENT_RECORD_EVENT = 'capture-kit:record';

/**
 * Detail of the completion event. JSON-safe primitives only: it crosses into
 * the page's world, where a structured clone of anything richer would fail.
 */
export interface AgentCaptureDetail {
  ok: boolean;
  /** Timestamped basename shared by the image and the report. */
  basename?: string;
  /** Which output path the files took. */
  output?: 'chosen' | 'downloads';
  error?: string;
}

/**
 * What set a capture going. Printed in the report's context block, because
 * "how was this taken" changes how its contents should be read: an icon
 * one-click and a keyboard shortcut catch the page as-is, while an in-page
 * agent trigger implies a script was driving it.
 *
 * This replaced a bare `viaCommand: boolean` whose only consumer was the badge
 * flash; `trigger !== 'popup'` reproduces that exactly.
 */
export type CaptureTrigger =
  | 'popup'
  | 'shortcut'
  | 'icon'
  | 'agent'
  | 'session'
  | 'sweep'
  | 'clip'
  | 'clip-shortcut'
  | 'agent-clip';

export const CAPTURE_TRIGGER_LABEL: Record<CaptureTrigger, string> = {
  popup: 'popup Capture + Report button',
  shortcut: 'keyboard shortcut (Ctrl/Cmd+Shift+9)',
  icon: 'toolbar icon (one-click capture mode)',
  agent: 'in-page agent trigger (capture-kit:capture)',
  session: 'session capture (multiple tabs)',
  sweep: 'responsive sweep',
  clip: 'Record clip (popup button or icon menu)',
  'clip-shortcut': 'keyboard shortcut (Ctrl/Cmd+Shift+8)',
  'agent-clip': 'in-page agent trigger (capture-kit:record)',
};

/** Popup / result page / content script → service worker. */
export type RuntimeMessage =
  | { type: 'CAPTURE_BUNDLE' }
  | { type: 'AGENT_CAPTURE' }
  | { type: 'AGENT_RECORD' }
  | { type: 'RECORD_CLIP' }
  | { type: 'CAPTURE_PAGE'; png?: boolean }
  | { type: 'CAPTURE_SWEEP' }
  | { type: 'GET_RESULT_IMAGE'; captureId: string; index: number }
  | { type: 'SESSION_LIST_TABS' }
  | { type: 'SESSION_START'; tabIds: number[]; reload: boolean }
  | { type: 'SESSION_CANCEL' };

/** One row in the session picker. */
export interface SessionTab {
  id: number;
  title: string;
  url: string;
  favIconUrl: string | null;
  active: boolean;
  windowId: number;
  /** Non-null when the tab cannot be captured; the row is shown, greyed. */
  blockedReason: string | null;
}

/** Live progress for the picker page, via chrome.storage.session. */
export interface SessionProgress {
  state: 'running' | 'done' | 'cancelled' | 'error';
  current: number;
  total: number;
  /** Title of the tab being captured right now. */
  title: string;
  startedAt: number;
}

export interface SessionSummary {
  folder: string;
  pointerFolder: string;
  pages: number;
  withIssues: number;
  failures: { title: string; reason: string }[];
  timings: { title: string; ms: number }[];
  totalMs: number;
  cancelled: boolean;
  /** Download id of the session index.md, for Show in Finder. */
  indexDownloadId: number | null;
}

/**
 * Tab the picker should pre-check. Opening the picker makes IT the active
 * tab, so "the tab you were looking at" has to be handed over explicitly.
 */
export const SESSION_SEED_TAB_KEY = 'sessionSeedTabId';
export const SESSION_PROGRESS_KEY = 'sessionProgress';
export const SESSION_SUMMARY_KEY = 'sessionSummary';

/**
 * Live single-capture progress, in chrome.storage.session so the popup can
 * follow a capture it did not start (one-click mode fires with no popup open,
 * and the user may open the popup mid-capture to see what is happening).
 */
export const CAPTURE_PROGRESS_KEY = 'captureProgress';

export interface CaptureProgressState {
  state: 'running' | 'idle';
  /** Segments completed and expected; 0/0 before the grid is known. */
  done: number;
  total: number;
  startedAt: number;
}

/** Service worker / popup → isolated content script. */
export type TabMessage =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'GET_STATS' }
  | { type: 'COPY_TEXT'; text: string }
  /** Image (always PNG) plus optional report text, written by the focused page. */
  | { type: 'COPY_IMAGE'; pngBase64: string; text?: string }
  | { type: 'AGENT_CAPTURE_COMPLETE'; detail: AgentCaptureDetail };

/** Worker → offscreen document: record this tab stream. */
export interface ClipRecordRequest {
  target: 'offscreen';
  type: 'CLIP_RECORD';
  streamId: string;
  seconds: number;
  fps: number;
  maxFrames: number;
  /** The tab's size, so the stream is shaped like the tab and not the screen. */
  width: number;
  height: number;
}

/** Offscreen document → worker. Base64 so it crosses the message boundary. */
export type ClipRecordResponse =
  | {
      ok: true;
      video: string;
      videoMime: string;
      sheet: string;
      sheetWidth: number;
      sheetHeight: number;
      frameWidth: number;
      frameHeight: number;
      /** The area the sheet was cropped to, in frame pixels, when it was cropped (NOBC-159). */
      crop?: { x: number; y: number; width: number; height: number };
      /** Offsets of the frames on the sheet, in order. */
      frameOffsetsMs: number[];
      /** The same frames at full size, JPEG base64, in order - for a person looking closely. */
      frames: string[];
      sampledFrames: number;
      durationMs: number;
    }
  | { ok: false; reason: string };

export type ClipResponse =
  | { ok: true; sheetFilename: string; videoFilename: string; markdownFilename: string; framesFolder: string; frames: number; copied: boolean }
  | { ok: false; reason: string };

export type CaptureResponse =
  | { ok: true; imageFilename: string; markdown?: string; copied?: boolean }
  | { ok: false; reason: string };

export type SweepResponse =
  | { ok: true; saved: number[]; failed: { width: number; reason: string }[] }
  | { ok: false; reason: string };

/**
 * Where a capture's files actually landed. Stated on every capture, because
 * "which folder was that" is exactly the question the 2026-08-17 symlink
 * failure left a user unable to answer.
 */
export interface OutputInfo {
  via: 'chosen' | 'downloads';
  /** Chosen folder's name, or "Downloads/capture-kit" for the fallback. */
  label: string;
  /**
   * True when a folder is chosen but its permission lapsed — a Chrome restart
   * does this every time, and one click in the result tab fixes it.
   */
  lapsed: boolean;
}

/** One image of a capture result — metadata only; pixels stay in SW memory. */
export interface ResultImage {
  /** Basename inside the output folder, e.g. foo_2026-08-13_18-05.png */
  filename: string;
  /** Sweep width label, e.g. "375 px". Absent for single captures. */
  label?: string;
  width: number;
  height: number;
  bytes: number;
  /** Null on the File System Access path — those files have no download record. */
  downloadId: number | null;
}

/** A download whose saved name differs from the one we asked Chrome for. */
export interface FilenameConflict {
  requested: string;
  saved: string;
}

/** Stored in chrome.storage.session as `result:<captureId>` for the result tab. */
export interface CaptureResultMeta {
  kind: 'page' | 'bundle' | 'sweep';
  captureModeLabel: string;
  images: ResultImage[];
  output: OutputInfo;
  /** Non-empty when another extension claimed onDeterminingFilename. */
  filenameConflicts: FilenameConflict[];
  /** Bundle markdown (plain — the result page composes the clipboard variant). */
  markdown?: string;
  /**
   * "Copy to clipboard after capture" was on: the result tab writes the image
   * (and the report, for a bundle) as soon as it opens.
   */
  autoCopyImage?: boolean;
  /** With autoCopyImage: the automatic write carries the image alone, no report text. */
  clipboardImageOnly?: boolean;
  createdAt: number;
}

/** Service worker → result page image transfer. Null when the preview expired. */
export type ResultImagePayload = { mime: string; base64: string } | null;

/** Stored in chrome.storage.session — survives service-worker death. */
export interface LastBundle {
  markdown: string;
  imageFilename: string;
  at: number;
}

export interface LastError {
  reason: string;
  at: number;
}
