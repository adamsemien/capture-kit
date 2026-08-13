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

/** Popup / result page → service worker. */
export type RuntimeMessage =
  | { type: 'CAPTURE_BUNDLE' }
  | { type: 'CAPTURE_PAGE' }
  | { type: 'CAPTURE_SWEEP' }
  | { type: 'GET_RESULT_IMAGE'; captureId: string; index: number };

/** Service worker / popup → isolated content script. */
export type TabMessage =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'GET_STATS' }
  | { type: 'COPY_TEXT'; text: string };

export type CaptureResponse =
  | { ok: true; imageFilename: string; markdown?: string }
  | { ok: false; reason: string };

export type SweepResponse =
  | { ok: true; saved: number[]; failed: { width: number; reason: string }[] }
  | { ok: false; reason: string };

/** One image of a capture result — metadata only; pixels stay in SW memory. */
export interface ResultImage {
  /** Basename inside Downloads/capture-kit, e.g. foo_2026-08-13_18-05.png */
  filename: string;
  /** Sweep width label, e.g. "375 px". Absent for single captures. */
  label?: string;
  width: number;
  height: number;
  bytes: number;
  downloadId: number;
}

/** Stored in chrome.storage.session as `result:<captureId>` for the result tab. */
export interface CaptureResultMeta {
  kind: 'page' | 'bundle' | 'sweep';
  captureModeLabel: string;
  images: ResultImage[];
  /** Bundle markdown (plain — the result page composes the clipboard variant). */
  markdown?: string;
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
