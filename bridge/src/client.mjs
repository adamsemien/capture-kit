// How ck and the MCP server reach the helper: HTTP on 127.0.0.1 with the
// pairing code. If the helper is not running yet, it is started in the
// background and left running, so the extension can connect to it.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export class BridgeError extends Error {}

export function createClient() {
  const { port, token } = loadConfig();
  const base = `http://127.0.0.1:${port}`;

  async function raw(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
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
    } catch {
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
