// The helper, the CLI client and the MCP server, against a stand-in for the
// extension. No browser here - scripts/acceptance.mjs drives the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const home = mkdtempSync(join(tmpdir(), 'ck-bridge-test-'));
process.env.CAPTURE_KIT_HOME = home;
const port = 47900 + Math.floor(Math.random() * 90);
process.env.CAPTURE_KIT_PORT = String(port);
const { loadConfig } = await import('../src/config.mjs');
const { startDaemon } = await import('../src/daemon.mjs');
const { CaptureStore, MAX_CAPTURES } = await import('../src/store.mjs');
const { createClient } = await import('../src/client.mjs');
const here = dirname(fileURLToPath(import.meta.url));

const { token } = loadConfig();
const EXT_ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
let daemon;
const client = () => createClient();

function record(id, extra = {}) {
  return {
    id, capturedAt: Date.now(), url: 'http://localhost:3000/x', title: 'X', trigger: 'shortcut',
    markdown: `# Capture — X\n\nImage: ${id}.png\n`, markdownFilename: `${id}.md`,
    image: { filename: `${id}.png`, mime: 'image/png', base64: PNG_1PX, width: 1, height: 1 },
    slices: [], errors: 2, failures: 1, ...extra,
  };
}

/** A pretend extension: connects, says hello, answers requests with `onRequest`. */
function fakeExtension({ code = token, origin = EXT_ORIGIN, onRequest } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
    const state = { ws, closedWith: null, welcomed: false };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: code, version: 'test' })));
    ws.on('message', async (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'welcome') { state.welcomed = true; resolve(state); }
      if (msg.type === 'request' && onRequest) {
        const result = await onRequest(msg, ws);
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      }
    });
    ws.on('close', (code) => { state.closedWith = code; resolve(state); });
    ws.on('error', () => { state.closedWith = 'error'; resolve(state); });
  });
}

before(async () => {
  daemon = startDaemon({ port, token, store: new CaptureStore(join(home, 'captures')) });
  await daemon.ready;
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

// node:http, not fetch: fetch quietly drops a custom Host header.
import { request } from 'node:http';
const raw = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });

test('the config file and folder are private to the user', () => {
  const cfg = loadConfig();
  assert.equal(statSync(cfg.path).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.ok(cfg.token.length >= 40);
});

test('HTTP needs the pairing code, no Origin, and a local Host', async () => {
  assert.equal((await raw('/status')).status, 401);
  assert.equal((await raw('/status', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw('/status', { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status, 403);
  assert.equal((await raw('/status', { authorization: `Bearer ${token}`, host: 'evil.example' })).status, 403);
  const ok = await raw('/status', { authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.connected, false);
});

test('a web page cannot connect as the extension, and a wrong code is refused', async () => {
  const page = await fakeExtension({ origin: 'https://evil.example' });
  assert.equal(page.welcomed, false);
  const wrong = await fakeExtension({ code: 'nope' });
  assert.equal(wrong.welcomed, false);
  assert.equal(wrong.closedWith, 4401);
});

test('a paired extension connects and its captures are stored as files', async () => {
  const ext = await fakeExtension();
  assert.equal(ext.welcomed, true);
  const status = await client().status();
  assert.equal(status.connected, true);
  ext.ws.send(JSON.stringify({ type: 'capture', record: record('page_one', {
    slices: [{ path: 'page_one_slices/slice-01.png', base64: PNG_1PX, top: 0, height: 1 }],
    changes: { filename: 'page_one_changes.png', base64: PNG_1PX },
  }) }));
  await new Promise((r) => setTimeout(r, 200));
  const latest = await client().latest();
  assert.equal(latest.ok, true);
  assert.equal(latest.capture.id, 'page_one');
  assert.match(latest.capture.markdown, /# Capture — X/);
  assert.ok(existsSync(latest.capture.imagePath));
  assert.ok(existsSync(latest.capture.slices[0].path));
  assert.ok(existsSync(latest.capture.changesPath));
  ext.ws.close();
});

test('file names from the extension cannot escape the capture folder', async () => {
  const ext = await fakeExtension();
  ext.ws.send(JSON.stringify({ type: 'capture', record: record('../../escape', {
    slices: [{ path: '../../../etc/slice.png', base64: PNG_1PX, top: 0, height: 1 }],
  }) }));
  await new Promise((r) => setTimeout(r, 200));
  const latest = await client().latest();
  const root = join(home, 'captures');
  for (const p of [latest.capture.folder, latest.capture.imagePath, latest.capture.slices[0].path]) {
    assert.ok(p.startsWith(root + '/'), p);
  }
  assert.equal(existsSync(join(home, 'etc')), false);
  ext.ws.close();
});

test("a sweep's other widths are stored beside it, inside the folder, and listed", async () => {
  const ext = await fakeExtension();
  ext.ws.send(JSON.stringify({ type: 'capture', record: record('sweep-x', {
    kind: 'sweep',
    extras: [
      { filename: 'sweep-x_w768.png', mime: 'image/png', base64: PNG_1PX, label: '768 px wide' },
      { filename: '../../out.png', mime: 'image/png', base64: PNG_1PX, label: 'escape' },
    ],
  }) }));
  await new Promise((r) => setTimeout(r, 200));
  const { capture } = await client().latest();
  const root = join(home, 'captures');
  assert.equal(capture.kind, 'sweep');
  assert.equal(capture.extras.length, 2);
  for (const x of capture.extras) {
    assert.ok(x.path.startsWith(root + '/'), x.path);
    assert.ok(existsSync(x.path));
  }
  const { header, listLine } = await import('../src/format.mjs');
  assert.match(header(capture), /Image \(768 px wide\): /);
  assert.match(listLine(capture), /\(sweep\)/);
  ext.ws.close();
});

test('wait returns the next capture, and times out cleanly', async () => {
  const ext = await fakeExtension();
  const waiting = client().wait(5);
  setTimeout(() => ext.ws.send(JSON.stringify({ type: 'capture', record: record('waited_for') })), 300);
  const got = await waiting;
  assert.equal(got.ok, true);
  assert.equal(got.capture.id, 'waited_for');
  const none = await client().wait(1);
  assert.equal(none.ok, false);
  assert.match(none.error, /no capture within 1 s/);
  ext.ws.close();
});

test('capture asks the extension and returns what it captured', async () => {
  const ext = await fakeExtension({
    onRequest: async (msg, ws) => {
      if (msg.action !== 'capture') return { ok: false, error: 'unexpected' };
      assert.equal(msg.params.urlContains, 'localhost:3000');
      assert.equal(msg.params.scroll, true);
      ws.send(JSON.stringify({ type: 'capture', record: record('asked_for') }));
      return { ok: true, id: 'asked_for' };
    },
  });
  const r = await client().capture({ urlContains: 'localhost:3000', scroll: true });
  assert.equal(r.ok, true);
  assert.equal(r.capture.id, 'asked_for');
  ext.ws.close();
});

test('a refusal from the extension is passed on, not dressed up as success', async () => {
  const ext = await fakeExtension({ onRequest: async () => ({ ok: false, error: 'Agent captures are turned off in Capture Kit settings.' }) });
  const r = await client().capture({});
  assert.equal(r.ok, false);
  assert.match(r.error, /turned off/);
  ext.ws.close();
});

test(`only the newest ${MAX_CAPTURES} captures are kept`, () => {
  const store = new CaptureStore(join(home, 'prune-test'));
  for (let i = 0; i < MAX_CAPTURES + 5; i++) store.save({ ...record(`p${i}`), capturedAt: 1000 + i });
  const list = store.list();
  assert.equal(list.length, MAX_CAPTURES);
  assert.equal(list[0].id, `p${MAX_CAPTURES + 4}`);
});

test('the MCP server lists its tools and returns the latest capture with its image', async () => {
  const ext = await fakeExtension();
  ext.ws.send(JSON.stringify({ type: 'capture', record: record('for_mcp') }));
  await new Promise((r) => setTimeout(r, 200));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, '..', 'bin', 'mcp.mjs')],
    env: { ...process.env, CAPTURE_KIT_HOME: home, CAPTURE_KIT_PORT: String(port) },
    stderr: 'ignore',
  });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['capture_tab', 'get_capture', 'get_latest_capture', 'list_captures', 'list_tabs', 'wait_for_capture']);
  const res = await mcp.callTool({ name: 'get_latest_capture', arguments: {} });
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].type, 'text');
  assert.match(res.content[0].text, /Capture for_mcp/);
  assert.match(res.content[0].text, /Image: .*for_mcp\.png/);
  const image = res.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, PNG_1PX);
  const list = await mcp.callTool({ name: 'list_captures', arguments: { limit: 2 } });
  assert.match(list.content[0].text, /for_mcp .*\[2 errors, 1 failed request\]/);
  await mcp.close();
  ext.ws.close();
});
