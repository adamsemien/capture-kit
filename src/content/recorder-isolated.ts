// Isolated-world recorder: holds the ring buffers in this script's memory,
// answers extension messages, and provides the clipboard write path for
// keyboard-shortcut captures (the page, not the popup, has focus then).

import type {
  BufferSnapshot,
  BufferStats,
  ConsoleEntry,
  NetworkFailure,
  TabMessage,
} from '../lib/messages';
import { CONSOLE_BUFFER_CAP, NETWORK_BUFFER_CAP, RECORDER_EVENT } from '../lib/messages';

(() => {
  // Guard against double-injection: the worker re-injects this file into
  // pages that predate an install/reload. The isolated-world window is
  // invisible to the page, so this flag leaks nothing.
  const flagHost = window as unknown as Record<string, unknown>;
  if (flagHost.__captureKitRecorder__) return;
  flagHost.__captureKitRecorder__ = true;

  const consoleBuffer: ConsoleEntry[] = [];
  const networkBuffer: NetworkFailure[] = [];

  function pushCapped<T>(buffer: T[], cap: number, entry: T): void {
    buffer.push(entry);
    if (buffer.length > cap) buffer.shift();
  }

  function asString(value: unknown, max = 4000): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function asNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  // Entries arrive as JSON strings so they cross the MAIN → isolated world
  // boundary as primitives. The page could dispatch spoofed events into its
  // own capture buffer, so every field is coerced, never trusted.
  document.addEventListener(RECORDER_EVENT, (event) => {
    try {
      const raw = (event as CustomEvent).detail;
      if (typeof raw !== 'string') return;
      const detail = JSON.parse(raw) as { kind?: unknown; entry?: unknown };
      if (!detail || typeof detail.entry !== 'object' || detail.entry === null) return;
      const entry = detail.entry as Record<string, unknown>;

      if (detail.kind === 'console') {
        const level = entry.level;
        if (level !== 'error' && level !== 'warn' && level !== 'log') return;
        const item: ConsoleEntry = {
          level,
          message: asString(entry.message),
          timestamp: asNumber(entry.timestamp),
        };
        const source = asString(entry.source, 500);
        if (source) item.source = source;
        pushCapped(consoleBuffer, CONSOLE_BUFFER_CAP, item);
      } else if (detail.kind === 'network') {
        pushCapped(networkBuffer, NETWORK_BUFFER_CAP, {
          method: asString(entry.method, 20) || 'GET',
          url: asString(entry.url, 2000),
          status: asNumber(entry.status),
          durationMs: asNumber(entry.durationMs),
          timestamp: asNumber(entry.timestamp),
        });
      }
    } catch {
      // Silent by contract.
    }
  });

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  chrome.runtime.onMessage.addListener((message: TabMessage, _sender, sendResponse) => {
    if (message?.type === 'GET_SNAPSHOT') {
      const snapshot: BufferSnapshot = {
        console: [...consoleBuffer],
        network: [...networkBuffer],
        meta: {
          url: location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          userAgent: navigator.userAgent,
        },
      };
      sendResponse(snapshot);
      return false;
    }
    if (message?.type === 'GET_STATS') {
      const stats: BufferStats = {
        consoleCount: consoleBuffer.length,
        networkCount: networkBuffer.length,
      };
      sendResponse(stats);
      return false;
    }
    if (message?.type === 'COPY_TEXT') {
      void copyText(message.text).then((ok) => sendResponse({ ok }));
      return true; // async response
    }
    return false;
  });
})();
