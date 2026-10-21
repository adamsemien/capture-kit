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
 * Proving who is who: the pairing code is never sent. Capture Kit says hello
 * with a random nonce; the helper must answer with an HMAC of both nonces
 * keyed by the code before Capture Kit answers with its own, and before it
 * sends any capture or acts on any request. A program that merely took the
 * port - another account on a shared computer, while the helper is stopped -
 * gets nothing (Codex review on #28; the helper side is bridge/src/proof.mjs).
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
  /** More pictures that belong to the report: a sweep's other widths. */
  extras?: { filename: string; mime: string; base64: string; label: string }[];
  /** What kind of capture this was, when not a single page: 'sweep', 'clip'. */
  kind?: string;
  errors: number;
  failures: number;
  /** Set when an agent asked for this capture: the helper's id for that request. */
  requestId?: string;
}

export interface BridgeHandlers {
  capture(params: { urlContains?: string; scroll?: boolean; requestId?: string }): Promise<{ ok: boolean; id?: string; error?: string }>;
  tabs(): Promise<{ ok: boolean; tabs?: { title: string; url: string; active: boolean }[]; error?: string }>;
}

/** HMAC-SHA256 over "role|a|b", keyed by the pairing code, base64url - as bridge/src/proof.mjs. */
async function proof(token: string, role: string, a: string, b: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${role}|${a}|${b}`)));
  let bin = '';
  for (const byte of mac) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Equal-length strings compared without stopping at the first difference. */
function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let socket: WebSocket | null = null;
/**
 * Bumped by every syncBridge call. A call that finds a newer one started
 * while it was awaiting stops there, so an older call holding settings from
 * before you turned the bridge off cannot reconnect after it (Codex review
 * on #28).
 */
let generation = 0;
let ready = false;
let keepalive: ReturnType<typeof setInterval> | undefined;
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
        requestId: id,
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
  const mine = ++generation;
  const current = () => mine === generation;
  const settings = await getBridgeSettings();
  if (!current()) return;
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
  // A live or opening socket is this generation's: nothing to do. An older
  // call still mid-connect is not waited for - it sees it is stale and stops.
  if (socket) return;
  try {
    await armRetry(true);
    await setStatus('connecting');
    if (!current()) return;
    const ws = new WebSocket(`ws://127.0.0.1:${settings.bridgePort}`);
    socket = ws;
    const mine = randomNonce();
    /** Set once the helper has proved itself; until then nothing else is answered. */
    let helperProved = false;
    let mismatch = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', nonce: mine, version: chrome.runtime.getManifest().version }));
    };
    ws.onmessage = async (event) => {
      if (socket !== ws) return;
      let msg: { type?: string; id?: string; action?: string; params?: Record<string, unknown>; nonce?: string; proof?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!helperProved) {
        const expected =
          msg.type === 'challenge' && typeof msg.nonce === 'string'
            ? await proof(settings.bridgeToken, 'helper', mine, msg.nonce)
            : null;
        if (!expected || !sameProof(msg.proof, expected)) {
          mismatch = true;
          ws.close(4403, 'no proof of the pairing code');
          return;
        }
        helperProved = true;
        ws.send(JSON.stringify({ type: 'auth', proof: await proof(settings.bridgeToken, 'extension', msg.nonce as string, mine) }));
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
        mismatch ? 'mismatch' : refused ? 'refused' : 'unreachable',
        mismatch
          // The two causes look the same from here, by design: neither side
          // shows the other anything until both have proved the code.
          ? `Whatever answered on port ${settings.bridgePort} did not prove it has this pairing code, so Capture Kit sent it nothing. Either the code here is not the helper's - run "ck pair" and paste it again - or something other than the helper is using that port.`
          : refused
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
