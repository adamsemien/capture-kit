// How ck and the MCP server reach the helper: HTTP on 127.0.0.1. Each request
// first asks /challenge, checks that the answer proves the helper holds the
// pairing code, and only then sends the request, signed with a proof of its
// own (see proof.mjs) - the code itself is never sent. If the helper is not
// running yet, it is started in the background and left running, so the
// extension can connect to it.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { nonce, proof, proofMatches } from './proof.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export class BridgeError extends Error {}

export function createClient() {
  const { port, token } = loadConfig();
  const base = `http://127.0.0.1:${port}`;

  const impostor = () =>
    new BridgeError(
      `Something other than the Capture Kit helper is answering on port ${port}, so nothing was sent to it. ` +
        'Stop whatever is using that port, or set CAPTURE_KIT_PORT and the same port in Capture Kit\'s settings.',
    );

  /** A one-time challenge from the helper, once it has proved it holds the code. */
  async function challenge(timeoutMs) {
    const mine = nonce();
    const res = await fetch(`${base}/challenge?c=${mine}`, { signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => null);
    if (!json || typeof json.nonce !== 'string' || !proofMatches(json.proof, proof(token, 'helper', mine, json.nonce))) {
      throw impostor();
    }
    return json.nonce;
  }

  async function raw(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
    const theirs = await challenge(Math.min(timeoutMs, 5000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          'x-capture-kit-auth': `${theirs}.${proof(token, 'client', theirs, `${method} ${path}`)}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async function running() {
    try {
      const s = await raw('/status', { timeoutMs: 1500 });
      return s.ok === true;
    } catch (error) {
      // Something else holds the port: say so rather than try to start a
      // helper that could not bind it.
      if (error instanceof BridgeError) throw error;
      return false;
    }
  }

  async function ensureDaemon() {
    if (await running()) return;
    const child = spawn(process.execPath, [join(here, 'daemon-main.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 125));
      if (await running()) return;
    }
    throw new BridgeError(`Could not start the Capture Kit helper on port ${port}.`);
  }

  async function call(path, options) {
    await ensureDaemon();
    return raw(path, options);
  }

  return {
    port,
    status: () => call('/status'),
    list: (limit = 10) => call(`/captures?limit=${limit}`),
    latest: () => call('/captures/latest'),
    get: (id) => call(`/captures/${encodeURIComponent(id)}`),
    tabs: () => call('/tabs', { timeoutMs: 20_000 }),
    capture: ({ urlContains, scroll } = {}) =>
      call('/capture', { method: 'POST', body: { urlContains, scroll }, timeoutMs: 200_000 }),
    wait: (seconds = 300) => call(`/wait?timeout=${seconds}`, { timeoutMs: (seconds + 10) * 1000 }),
    stop: async () => ((await running()) ? raw('/shutdown', { method: 'POST' }) : { ok: true }),
    running,
    ensureDaemon,
  };
}
