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
}

export interface BufferStats {
  consoleCount: number;
  networkCount: number;
}

/** MAIN world → isolated world, serialized to JSON so it crosses as a primitive. */
export type RecorderEventDetail =
  | { kind: 'console'; entry: ConsoleEntry }
  | { kind: 'network'; entry: NetworkFailure };

/** Popup → service worker. */
export type RuntimeMessage = { type: 'CAPTURE_BUNDLE' } | { type: 'CAPTURE_PAGE' };

/** Service worker / popup → isolated content script. */
export type TabMessage =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'GET_STATS' }
  | { type: 'COPY_TEXT'; text: string };

export type CaptureResponse =
  | { ok: true; imageFilename: string; markdown?: string }
  | { ok: false; reason: string };

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
