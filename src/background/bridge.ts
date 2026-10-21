/*
 * The extension's end of the agent bridge (NOBC-82). Capture Kit dials out to
 * the helper on this computer (ws://127.0.0.1:<port>) - an MV3 extension
 * cannot listen - proves itself with the pairing code, then:
 *
 *   - hands over every report you capture (pushCapture), and
 *   - answers the helper's requests: list the tabs agents may capture, and
 *     capture one (only when you allowed agent captures, only on allowed
 *     sites).
 *
 * Nothing is sent anywhere else, and nothing at all while the bridge is off.
 *
 * Staying connected: since Chrome 116 a WebSocket that exchanges a message
 * every 30 s keeps the service worker alive, so a keepalive goes out every
 * 20 s (developer.chrome.com/docs/extensions/how-to/web-platform/websockets).
 * When the helper is not running, a one-minute alarm retries, so starting the
 * helper later connects within a minute.
 */

import {
  BRIDGE_KEYS,
  BRIDGE_STATUS_KEY,
  getBridgeSettings,
  type BridgeStatus,
} from '../lib/bridge-settings';

const KEEPALIVE_MS = 20_000;
const RETRY_ALARM = 'capture-kit-bridge-retry';

export interface BridgeRecord {
  id: string;
  capturedAt: number;
  url: string;
  title: string;
  trigger: string;
  markdown: string;
  markdownFilename: string;
  image: { filename: string; mime: string; base64: string; width: number; height: number };
  slices: { path: string; base64: string; top: number; height: number }[];
  changes?: { filename: string; base64: string };
  errors: number;
  failures: number;
}

export interface BridgeHandlers {
  capture(params: { urlContains?: string; scroll?: boolean }): Promise<{ ok: boolean; id?: string; error?: string }>;
  tabs(): Promise<{ ok: boolean; tabs?: { title: string; url: string; active: boolean }[]; error?: string }>;
}

let socket: WebSocket | null = null;
let ready = false;
let keepalive: ReturnType<typeof setInterval> | undefined;
let connecting = false;
let handlers: BridgeHandlers | null = null;

async function setStatus(state: BridgeStatus['state'], detail?: string): Promise<void> {
  const status: BridgeStatus = { state, at: Date.now(), ...(detail ? { detail } : {}) };
  try {
    await chrome.storage.session.set({ [BRIDGE_STATUS_KEY]: status });
  } catch {
    /* the options page just shows less */
  }
}

function teardown(): void {
  clearInterval(keepalive);
  keepalive = undefined;
  ready = false;
  const s = socket;
  socket = null;
  if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
    try {
      s.close();
    } catch {
      /* already closing */
    }
  }
}

async function armRetry(on: boolean): Promise<void> {
  try {
    if (on) await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    else await chrome.alarms.clear(RETRY_ALARM);
  } catch {
    /* alarms unavailable: the next worker wake retries instead */
  }
}

async function answer(id: string, action: string, params: Record<string, unknown>): Promise<void> {
  let result: unknown;
  try {
    if (!handlers) result = { ok: false, error: 'Capture Kit is still starting.' };
    else if (action === 'capture') {
      result = await handlers.capture({
        urlContains: typeof params.urlContains === 'string' ? params.urlContains : undefined,
        scroll: params.scroll === true,
      });
    } else if (action === 'tabs') result = await handlers.tabs();
    else result = { ok: false, error: `unknown request: ${action}` };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (socket && ready) socket.send(JSON.stringify({ type: 'result', id, result }));
}

/** Connects if the bridge is on and paired; closes it otherwise. Safe to call any time. */
export async function syncBridge(): Promise<void> {
  const settings = await getBridgeSettings();
  if (!settings.bridgeEnabled) {
    teardown();
    await armRetry(false);
    await setStatus('off');
    return;
  }
  if (!settings.bridgeToken) {
    teardown();
    await armRetry(false);
    await setStatus('unpaired');
    return;
  }
  if (socket || connecting) return;
  connecting = true;
  await armRetry(true);
  await setStatus('connecting');
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${settings.bridgePort}`);
    socket = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: settings.bridgeToken,
          version: chrome.runtime.getManifest().version,
        }),
      );
    };
    ws.onmessage = (event) => {
      let msg: { type?: string; id?: string; action?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        ready = true;
        clearInterval(keepalive);
        keepalive = setInterval(() => {
          if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keepalive' }));
        }, KEEPALIVE_MS);
        void setStatus('connected');
        return;
      }
      if (msg.type === 'request' && msg.id && msg.action) void answer(msg.id, msg.action, msg.params ?? {});
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      const refused = event.code === 4401;
      teardown();
      void setStatus(
        refused ? 'refused' : 'unreachable',
        refused
          ? 'The helper did not accept the pairing code. Run "ck pair" again and paste the new code.'
          : 'The helper is not running. Any ck command or the MCP server starts it; Capture Kit retries every minute.',
      );
    };
    ws.onerror = () => {
      /* onclose follows and reports */
    };
  } catch (error) {
    teardown();
    await setStatus('unreachable', String(error));
  } finally {
    connecting = false;
  }
}

export function bridgeConnected(): boolean {
  return ready && socket !== null && socket.readyState === WebSocket.OPEN;
}

/** Hands a finished report to the helper. Does nothing unless connected. */
export function pushCapture(record: BridgeRecord): void {
  if (!bridgeConnected() || !socket) return;
  try {
    socket.send(JSON.stringify({ type: 'capture', record }));
  } catch (error) {
    console.warn('[capture-kit] could not hand the capture to the bridge:', error);
  }
}

export function initBridge(h: BridgeHandlers): void {
  handlers = h;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) void syncBridge();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (BRIDGE_KEYS.some((k) => k in changes)) {
      teardown();
      void syncBridge();
    }
  });
  void syncBridge();
}
