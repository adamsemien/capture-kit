// Isolated-world recorder: holds the ring buffers in this script's memory,
// answers extension messages, and provides the clipboard write path for
// keyboard-shortcut captures (the page, not the popup, has focus then).

import type {
  AgentCaptureDetail,
  BufferSnapshot,
  BufferStats,
  ConsoleEntry,
  NetworkFailure,
  TabMessage,
} from '../lib/messages';
import {
  AGENT_CAPTURE_EVENT,
  AGENT_COMPLETE_EVENT,
  CONSOLE_BUFFER_CAP,
  NETWORK_BUFFER_CAP,
  RECORDER_EVENT,
} from '../lib/messages';

(() => {
  // Guard against double-injection: the worker re-injects this file into
  // pages that predate an install/reload. The isolated-world window is
  // invisible to the page, so this flag leaks nothing.
  const flagHost = window as unknown as Record<string, unknown>;
  if (flagHost.__captureKitRecorder__) return;
  flagHost.__captureKitRecorder__ = true;

  const consoleBuffer: ConsoleEntry[] = [];
  const networkBuffer: NetworkFailure[] = [];
  // Set by the MAIN-world recorder's hello beacon. Stays false on pages where
  // this script was injected after load (no MAIN-world coverage since load).
  let mainWorldActive = false;

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
      if (!detail) return;
      if (detail.kind === 'hello') {
        mainWorldActive = true;
        return;
      }
      if (typeof detail.entry !== 'object' || detail.entry === null) return;
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

  // The agent trigger. A keyboard command is browser chrome and no page script
  // can press it; this event is the page-reachable equivalent, so an assistant
  // driving the tab captures with zero keystrokes:
  //
  //   document.dispatchEvent(new CustomEvent('capture-kit:capture'))
  //   document.addEventListener('capture-kit:capture-complete', e => ...)
  //
  // The worker decides whether the trigger is allowed (Settings) and answers
  // on the same document either way, so a caller always gets one completion.
  document.addEventListener(AGENT_CAPTURE_EVENT, () => {
    try {
      void chrome.runtime.sendMessage({ type: 'AGENT_CAPTURE' });
    } catch {
      dispatchComplete({ ok: false, error: 'extension unavailable' });
    }
  });

  function dispatchComplete(detail: AgentCaptureDetail): void {
    // Rebuilt from primitives on purpose: this object crosses into the page's
    // world, where anything not structured-cloneable would throw.
    const safe: AgentCaptureDetail = { ok: detail.ok === true };
    if (typeof detail.basename === 'string') safe.basename = detail.basename;
    if (detail.output === 'chosen' || detail.output === 'downloads') safe.output = detail.output;
    if (typeof detail.error === 'string') safe.error = detail.error;
    document.dispatchEvent(new CustomEvent(AGENT_COMPLETE_EVENT, { detail: safe }));
  }

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

  // "Copy to clipboard after capture" with no result tab: this page is the
  // focused document right after a shortcut or toolbar-icon capture, so the
  // write lands here. Image and report as one ClipboardItem - one item per
  // write is what Chrome accepts, several types inside it is supported.
  async function copyImage(pngBase64: string, text?: string): Promise<boolean> {
    try {
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const items: Record<string, Blob> = { 'image/png': new Blob([bytes], { type: 'image/png' }) };
      if (text) items['text/plain'] = new Blob([text], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    } catch {
      return false;
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
        mainWorldActive,
      };
      sendResponse(snapshot);
      return false;
    }
    if (message?.type === 'GET_STATS') {
      const stats: BufferStats = {
        consoleCount: consoleBuffer.length,
        networkCount: networkBuffer.length,
        mainWorldActive,
      };
      sendResponse(stats);
      return false;
    }
    if (message?.type === 'AGENT_CAPTURE_COMPLETE') {
      dispatchComplete(message.detail);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'COPY_IMAGE') {
      void copyImage(message.pngBase64, message.text).then((ok) => sendResponse({ ok }));
      return true; // async response
    }
    if (message?.type === 'COPY_TEXT') {
      void copyText(message.text).then((ok) => sendResponse({ ok }));
      return true; // async response
    }
    return false;
  });
})();
