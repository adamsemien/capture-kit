// The local helper (NOBC-82, decided 2026-08-17): Capture Kit's extension
// dials out to it over a WebSocket (an MV3 extension cannot listen), and the
// ck command and the MCP server talk to it over HTTP. Both sides listen on
// 127.0.0.1 only.
//
// Who may talk to it - each proving it holds the pairing code, after the
// helper has proved it holds it first, and without the code ever being sent
// (see proof.mjs):
//   - the extension: a WebSocket whose Origin is a chrome-extension:// page.
//     Web pages cannot set that Origin, so a site you visit cannot pose as
//     the extension.
//   - ck and the MCP server: HTTP requests with no Origin header (browsers
//     always send one on the requests that could reach here) and a Host of
//     127.0.0.1 or localhost (which stops DNS-rebinding tricks). Each request
//     first fetches a one-time challenge from /challenge.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { nonce, proof, proofMatches } from './proof.mjs';
import { CaptureStore } from './store.mjs';

const HELLO_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_WAIT_S = 900;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** What a pending /wait is answered with when the helper stops. */
const STOPPED = Symbol('stopped');
/** How long an HTTP challenge stays usable, and how many may be outstanding. */
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 200;

export function startDaemon({ port, token, store = new CaptureStore(), log = () => {} }) {
  /** The extension's socket once it has said hello with the right code. */
  let ext = null;
  let extInfo = null;
  const pending = new Map();
  /** /wait callers: resolved by the next capture saved after they asked. */
  let waiters = [];
  /** The extension's name for a capture → the folder it was stored as (a repeat name gets a suffix). */
  const storedAs = new Map();
  /** A capture request's id → the folder its capture was stored as. */
  const storedByRequest = new Map();

  /** HTTP challenges handed out and not yet used: nonce -> expiry. One use each. */
  const challenges = new Map();
  function issueChallenge(clientNonce) {
    const now = Date.now();
    for (const [n, expires] of challenges) if (expires < now) challenges.delete(n);
    if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const n = nonce();
    challenges.set(n, now + CHALLENGE_TTL_MS);
    return { nonce: n, proof: proof(token, 'helper', clientNonce, n) };
  }
  /** "x-capture-kit-auth: <challenge nonce>.<client proof over the method and path>" */
  function requestAuthorized(req) {
    const header = String(req.headers['x-capture-kit-auth'] ?? '');
    const dot = header.indexOf('.');
    if (dot < 1) return false;
    const n = header.slice(0, dot);
    const expires = challenges.get(n);
    challenges.delete(n);
    if (!expires || expires < Date.now()) return false;
    return proofMatches(header.slice(dot + 1), proof(token, 'client', n, `${req.method} ${req.url}`));
  }

  const hostOk = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(json);
  }

  function withMarkdown(meta) {
    if (!meta) return null;
    let markdown = '';
    try {
      markdown = store.markdown(meta);
    } catch {
      markdown = '';
    }
    return { ...meta, markdown };
  }

  function askExtension(action, params, id = randomUUID()) {
    if (!ext) return Promise.reject(new Error('Capture Kit is not connected. Open Chrome, and check Settings → Agent bridge in Capture Kit is on and paired.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Capture Kit did not answer in time.'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ext.send(JSON.stringify({ type: 'request', id, action, params }));
    });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('request too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  const server = createServer(async (req, res) => {
    // Browsers attach Origin to every request that could carry a header
    // like ours; ck and the MCP server never do.
    if (req.headers.origin || !hostOk(req.headers.host)) return send(res, 403, { ok: false, error: 'forbidden' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // The one unauthenticated request: the helper proves itself to the
    // caller and hands it a one-time challenge to answer.
    if (req.method === 'GET' && url.pathname === '/challenge') {
      const clientNonce = url.searchParams.get('c') ?? '';
      if (clientNonce.length < 16 || clientNonce.length > 64) return send(res, 400, { ok: false, error: 'bad challenge' });
      return send(res, 200, { ok: true, helper: 'capture-kit', ...issueChallenge(clientNonce) });
    }
    if (!requestAuthorized(req)) return send(res, 401, { ok: false, error: 'bad pairing code' });
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, {
          ok: true,
          connected: Boolean(ext),
          extension: extInfo,
          captures: store.list().length,
          pid: process.pid,
        });
      }
      if (req.method === 'GET' && url.pathname === '/captures') {
        const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
        return send(res, 200, { ok: true, captures: store.list().slice(0, limit) });
      }
      if (req.method === 'GET' && url.pathname === '/captures/latest') {
        const meta = withMarkdown(store.latest());
        return meta ? send(res, 200, { ok: true, capture: meta }) : send(res, 404, { ok: false, error: 'no captures yet' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/captures/')) {
        const meta = withMarkdown(store.get(decodeURIComponent(url.pathname.slice('/captures/'.length))));
        return meta ? send(res, 200, { ok: true, capture: meta }) : send(res, 404, { ok: false, error: 'no such capture' });
      }
      if (req.method === 'GET' && url.pathname === '/tabs') {
        const result = await askExtension('tabs', {});
        return send(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && url.pathname === '/capture') {
        const body = await readBody(req);
        const requestId = randomUUID();
        const result = await askExtension('capture', {
          urlContains: typeof body.urlContains === 'string' ? body.urlContains : undefined,
          scroll: body.scroll === true,
        }, requestId);
        if (!result.ok) return send(res, 409, result);
        // The capture this request made, by the request's own id - not by
        // name, which a capture you take in the same minute can share (Codex
        // review on #28).
        const storedId = storedByRequest.get(requestId) ?? storedAs.get(result.id) ?? result.id;
        storedByRequest.delete(requestId);
        const meta = withMarkdown(store.get(storedId));
        return meta ? send(res, 200, { ok: true, capture: meta }) : send(res, 500, { ok: false, error: 'the capture was taken but not received' });
      }
      if (req.method === 'GET' && url.pathname === '/wait') {
        const seconds = Math.max(1, Math.min(MAX_WAIT_S, Number(url.searchParams.get('timeout')) || 300));
        const meta = await new Promise((resolve) => {
          const waiter = { resolve, timer: setTimeout(() => {
            waiters = waiters.filter((w) => w !== waiter);
            resolve(null);
          }, seconds * 1000) };
          waiters.push(waiter);
          req.on('close', () => {
            clearTimeout(waiter.timer);
            waiters = waiters.filter((w) => w !== waiter);
          });
        });
        if (meta === STOPPED) return send(res, 503, { ok: false, error: 'the Capture Kit helper was stopped' });
        return meta ? send(res, 200, { ok: true, capture: withMarkdown(meta) }) : send(res, 408, { ok: false, error: `no capture within ${seconds} s` });
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        send(res, 200, { ok: true });
        setTimeout(() => close(), 50);
        return;
      }
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!EXTENSION_ORIGIN.test(req.headers.origin ?? '') || !hostOk(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let hello = false;
      /** Set once the helper has answered the extension's hello with its own challenge. */
      let challenge = null;
      const helloTimer = setTimeout(() => ws.close(4401, 'no hello'), HELLO_TIMEOUT_MS);
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!hello) {
          // 1. hello {nonce}: the helper proves itself and sends its own nonce.
          if (!challenge) {
            if (msg.type !== 'hello' || typeof msg.nonce !== 'string' || msg.nonce.length < 16 || msg.nonce.length > 64) {
              ws.close(4401, 'bad hello');
              return;
            }
            challenge = { theirs: msg.nonce, ours: nonce(), version: msg.version };
            ws.send(JSON.stringify({ type: 'challenge', nonce: challenge.ours, proof: proof(token, 'helper', challenge.theirs, challenge.ours) }));
            return;
          }
          // 2. auth {proof}: the extension proves it holds the code too.
          if (msg.type !== 'auth' || !proofMatches(msg.proof, proof(token, 'extension', challenge.ours, challenge.theirs))) {
            ws.close(4401, 'bad pairing code');
            return;
          }
          msg.version = challenge.version;
          hello = true;
          clearTimeout(helloTimer);
          if (ext && ext !== ws) ext.close(4000, 'replaced');
          ext = ws;
          extInfo = { version: String(msg.version ?? ''), connectedAt: Date.now() };
          ws.send(JSON.stringify({ type: 'welcome' }));
          log(`extension connected (${extInfo.version})`);
          return;
        }
        if (msg.type === 'keepalive') return;
        if (msg.type === 'capture' && msg.record) {
          try {
            const meta = store.save(msg.record);
            storedAs.set(String(msg.record.id), meta.id);
            if (typeof msg.record.requestId === 'string') storedByRequest.set(msg.record.requestId, meta.id);
            log(`capture stored: ${meta.id}`);
            const ready = waiters;
            waiters = [];
            for (const w of ready) {
              clearTimeout(w.timer);
              w.resolve(meta);
            }
            ws.send(JSON.stringify({ type: 'stored', id: msg.record.id, storedAs: meta.id }));
          } catch (error) {
            log(`could not store a capture: ${error}`);
          }
          return;
        }
        if (msg.type === 'result' && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg.result ?? { ok: false, error: 'empty result' });
        }
      });
      ws.on('close', () => {
        clearTimeout(helloTimer);
        if (ext === ws) {
          ext = null;
          extInfo = null;
          for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error('Capture Kit disconnected.'));
            pending.delete(id);
          }
          log('extension disconnected');
        }
      });
    });
  });

  // Everything still waiting is answered before the server closes: an open
  // /wait would otherwise hold the process alive after "ck stop" said it
  // stopped (Codex review on #28).
  function close() {
    const stillWaiting = waiters;
    waiters = [];
    for (const w of stillWaiting) {
      clearTimeout(w.timer);
      w.resolve(STOPPED);
    }
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('the Capture Kit helper was stopped'));
      pending.delete(id);
    }
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close();
    // Drop idle keep-alive sockets once the answers above have gone out.
    setTimeout(() => server.closeAllConnections?.(), 100).unref?.();
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return { ready, close, server, store };
}
