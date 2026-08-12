// MAIN-world recorder: wraps the page's real console, fetch, and XHR, and
// listens for uncaught errors / unhandled rejections, forwarding entries to
// the isolated-world buffer via CustomEvent.
//
// Hard requirements: silent and safe. No console output of its own, no page
// behavior changes, and every hook is installed inside its own try/catch so a
// page with frozen or proxied globals degrades to window error events only.

import type { ConsoleEntry, ConsoleLevel, NetworkFailure, RecorderEventDetail } from '../lib/messages';
import { RECORDER_EVENT } from '../lib/messages';

(() => {
  const MAX_MESSAGE_LENGTH = 2000;

  function emit(detail: RecorderEventDetail): void {
    try {
      // Serialized to JSON so the payload crosses the MAIN → isolated world
      // boundary as a primitive string.
      document.dispatchEvent(new CustomEvent(RECORDER_EVENT, { detail: JSON.stringify(detail) }));
    } catch {
      // Recording must never interfere with the page.
    }
  }

  function emitConsole(level: ConsoleLevel, message: string, source?: string): void {
    const entry: ConsoleEntry = {
      level,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      timestamp: Date.now(),
    };
    if (source) entry.source = source;
    emit({ kind: 'console', entry });
  }

  function emitNetwork(entry: NetworkFailure): void {
    emit({ kind: 'network', entry });
  }

  function formatArg(arg: unknown): string {
    try {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) {
        const stackTail = arg.stack ? '\n' + arg.stack.split('\n').slice(1, 3).join('\n') : '';
        return `${arg.name}: ${arg.message}${stackTail}`;
      }
      if (typeof arg === 'function') return `[function ${arg.name || 'anonymous'}]`;
      return JSON.stringify(arg) ?? String(arg);
    } catch {
      try {
        return String(arg);
      } catch {
        return '[unserializable]';
      }
    }
  }

  function formatArgs(args: unknown[]): string {
    return args.map(formatArg).join(' ');
  }

  // Best-effort source location of a console call: the first stack frame that
  // isn't inside this recorder.
  function callSite(): string | undefined {
    try {
      const stack = new Error().stack;
      if (!stack) return undefined;
      for (const line of stack.split('\n').slice(1)) {
        const match = line.match(/(\S+?):(\d+):(\d+)\)?\s*$/);
        if (!match) continue;
        if (match[1].includes('chrome-extension://') || match[1].includes('recorder-main')) continue;
        return `${match[1].replace(/^\(/, '').replace(/^at /, '')}:${match[2]}:${match[3]}`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // --- Window error events: installed first, the guaranteed-safe baseline ---

  try {
    window.addEventListener('error', (event) => {
      try {
        const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
        emitConsole('error', `Uncaught ${event.message || formatArg(event.error)}`, source);
      } catch {
        /* silent */
      }
    });
  } catch {
    /* silent */
  }

  try {
    window.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event.reason;
        const message =
          reason instanceof Error ? `${reason.name}: ${reason.message}` : formatArg(reason);
        emitConsole('error', `Unhandled promise rejection: ${message}`);
      } catch {
        /* silent */
      }
    });
  } catch {
    /* silent */
  }

  // --- Console wrapping (transparent passthrough) ---

  function wrapConsoleMethod(level: ConsoleLevel): void {
    try {
      const original = console[level] as (...args: unknown[]) => void;
      if (typeof original !== 'function') return;
      const wrapped = function (this: unknown, ...args: unknown[]): void {
        try {
          emitConsole(level, formatArgs(args), callSite());
        } catch {
          /* silent */
        }
        original.apply(this, args);
      };
      (console as unknown as Record<string, unknown>)[level] = wrapped;
    } catch {
      /* frozen or proxied console — window error events still work */
    }
  }

  wrapConsoleMethod('error');
  wrapConsoleMethod('warn');
  wrapConsoleMethod('log');

  // --- fetch wrapping ---

  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      const wrappedFetch = function (
        this: unknown,
        ...args: Parameters<typeof fetch>
      ): Promise<Response> {
        const startedAt = Date.now();
        let method = 'GET';
        let url = '';
        try {
          const input = args[0];
          if (typeof input === 'string') url = input;
          else if (input instanceof URL) url = input.href;
          else if (input instanceof Request) {
            url = input.url;
            method = input.method || 'GET';
          }
          if (args[1]?.method) method = String(args[1].method);
          method = method.toUpperCase();
        } catch {
          /* silent */
        }
        // Return the derived promise so rejection semantics are preserved: if
        // the page never handles the rejection, unhandledrejection still fires
        // exactly once (from this promise), and our own handler on the
        // original promise never suppresses it.
        return originalFetch.apply(this, args).then(
          (response) => {
            try {
              if (response.status >= 400) {
                emitNetwork({
                  method,
                  url,
                  status: response.status,
                  durationMs: Date.now() - startedAt,
                  timestamp: Date.now(),
                });
              }
            } catch {
              /* silent */
            }
            return response;
          },
          (error) => {
            try {
              emitNetwork({
                method,
                url,
                status: 0,
                durationMs: Date.now() - startedAt,
                timestamp: Date.now(),
              });
            } catch {
              /* silent */
            }
            throw error;
          },
        );
      };
      window.fetch = wrappedFetch as typeof window.fetch;
    }
  } catch {
    /* silent */
  }

  // --- XHR wrapping ---

  try {
    const xhrProto = window.XMLHttpRequest?.prototype;
    if (xhrProto) {
      const originalOpen = xhrProto.open as (...args: unknown[]) => void;
      const originalSend = xhrProto.send as (...args: unknown[]) => void;
      const requestInfo = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

      xhrProto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
          requestInfo.set(this, {
            method: String(args[0] ?? 'GET').toUpperCase(),
            url: String(args[1] ?? ''),
          });
        } catch {
          /* silent */
        }
        originalOpen.apply(this, args);
      } as typeof xhrProto.open;

      xhrProto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
          const startedAt = Date.now();
          let aborted = false;
          this.addEventListener('abort', () => {
            aborted = true;
          });
          this.addEventListener('loadend', () => {
            try {
              if (aborted) return;
              const status = this.status;
              if (status === 0 || status >= 400) {
                const info = requestInfo.get(this);
                emitNetwork({
                  method: info?.method ?? 'GET',
                  url: info?.url ?? '',
                  status,
                  durationMs: Date.now() - startedAt,
                  timestamp: Date.now(),
                });
              }
            } catch {
              /* silent */
            }
          });
        } catch {
          /* silent */
        }
        originalSend.apply(this, args);
      } as typeof xhrProto.send;
    }
  } catch {
    /* silent */
  }
})();
