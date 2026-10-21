// End to end for the agent bridge: the real extension in a test Chrome, the
// real helper, the ck command and an MCP client - nothing faked.
//
//   npm run build && (cd bridge && npm install) && CHROME_BIN=... node scripts/bridge-e2e.mjs
//
// Checks, in order:
//   E1 the extension connects once it has the pairing code
//   E2 a capture you take reaches `ck latest`, files and all
//   E3 `ck wait` returns the next capture you take
//   E4 `ck capture <match>` captures an allowed tab and returns it
//   E5 the MCP server's capture_tab returns the report and the image
//   E6 with agent captures off, a capture request is refused, plainly
//   E7 a wrong pairing code is refused and the status says so
//   E11 something else on the port gets nothing: no code, no proof, no capture
//   E12 switching the bridge off straight after on leaves it off
//   E9 a responsive sweep reaches the agent with every width
//   E10 a tab that moves to a site agents may not capture, as it comes to
//       the front, is refused - the agent gets nothing

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = process.env.CK_DIST ?? `${ROOT}/dist`;
const CHROME = process.env.CHROME_BIN;
const HOME = mkdtempSync(join(tmpdir(), 'ck-e2e-home-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'ck-e2e-profile-'));
const DOWNLOADS = mkdtempSync(join(tmpdir(), 'ck-e2e-dl-'));
const BRIDGE_PORT = 47950 + Math.floor(Math.random() * 40);
const PAGE_PORT = 8790 + Math.floor(Math.random() * 100) + 100;
const CDP_PORT = 9450 + Math.floor(Math.random() * 40);
const env = { ...process.env, CAPTURE_KIT_HOME: HOME, CAPTURE_KIT_PORT: String(BRIDGE_PORT) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const verdict = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`VERDICT ${name}: ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
};

if (!CHROME || !existsSync(CHROME)) {
  console.error('Set CHROME_BIN.');
  process.exit(1);
}

// A page on an allowed site (127.0.0.1 is in the default allowed list).
const pages = createServer((req, res) => {
  if (req.url.startsWith('/missing')) return res.writeHead(404).end('missing');
  if (req.url === '/hop') {
    // Leaves for a site agents may not capture the moment it is shown.
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>hop</title><body>hop<script>
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') location.replace('http://127.0.0.2:${PAGE_PORT}/');
      });</script></body>`);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>bridge e2e ${req.url}</title><body style="font:20px sans-serif;height:1400px;background:#e3f2fd">
    <h1>bridge e2e page ${req.url}</h1><script>console.error('E2E boom'); fetch('/missing-e2e');</script></body>`);
});
pages.listen(PAGE_PORT, '127.0.0.1');
// The same pages on 127.0.0.2: a loopback address that is NOT on the allowed list.
const elsewhere = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>not allowed</title><body style="background:#000">not an allowed site</body>');
});
elsewhere.listen(PAGE_PORT, '127.0.0.2');
const hopUrl = `http://127.0.0.1:${PAGE_PORT}/hop`;

const ck = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'bridge/bin/ck.mjs'), ...args], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, out, err }));
  });

// The helper, started the way ck starts it.
await ck('status');

mkdirSync(`${PROFILE}/Default`, { recursive: true });
writeFileSync(`${PROFILE}/Default/Preferences`, JSON.stringify({ download: { default_directory: DOWNLOADS } }));
const chrome = spawn(CHROME, [
  `--load-extension=${DIST}`,
  `--disable-extensions-except=${DIST}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--headless=new',
  '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' });

const cdp = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { method })).json();
class Session {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { chrome.kill('SIGTERM'); } catch {}
  await ck('stop');
  pages.close();
  elsewhere.close();
  for (const d of [HOME, PROFILE, DOWNLOADS]) rmSync(d, { recursive: true, force: true });
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await cdp('/json/version')).webSocketDebuggerUrl) break; } catch {}
    await sleep(250);
  }
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    const sw = (await cdp('/json/list')).find((t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(500);
  }
  if (!extId) throw new Error('extension service worker never appeared');
  const optTarget = await cdp(`/json/new?${encodeURIComponent(`chrome-extension://${extId}/options/options.html`)}`, 'PUT');
  await sleep(1200);
  const options = new Session(optTarget.webSocketDebuggerUrl);
  await options.open();
  await options.send('Runtime.enable');
  await options.eval(`chrome.storage.sync.set({ openResult: false, autoCopyImage: false, maintainLatest: false, bundleFormat: 'jpeg' })`);

  const token = JSON.parse(readFileSync(join(HOME, 'bridge.json'), 'utf8')).token;
  await options.eval(`chrome.storage.local.set(${JSON.stringify({ bridgeEnabled: true, bridgeToken: token, bridgePort: BRIDGE_PORT, bridgeCaptureMode: 'allowed' })})`);

  // E1
  let status = null;
  for (let i = 0; i < 40; i++) {
    status = JSON.parse((await ck('status', '--json')).out || '{}');
    if (status.connected) break;
    await sleep(250);
  }
  const optionsStatus = await options.eval(`chrome.storage.session.get('bridgeStatus').then((s) => s.bridgeStatus?.state ?? null)`);
  verdict('E1 extension connects with the pairing code', status?.connected === true && optionsStatus === 'connected',
    `ck status connected=${status?.connected}, settings page says ${optionsStatus}`);

  const pageUrl = `http://127.0.0.1:${PAGE_PORT}/app`;
  const page = await cdp(`/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
  await sleep(1500);
  const tabId = await options.eval(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(pageUrl)})?.id ?? null)`);
  const userCapture = async () => {
    await options.eval(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
    await sleep(300);
    return options.eval(`chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE', tabId: ${tabId} })`);
  };

  // E2
  const taken = await userCapture();
  await sleep(1000);
  const latest = JSON.parse((await ck('latest', '--json')).out || '{}');
  verdict('E2 a capture you take reaches ck latest',
    taken?.ok === true && latest.url === pageUrl && latest.errors >= 1 && existsSync(latest.imagePath ?? '') && /E2E boom/.test(latest.markdown ?? ''),
    `url ${latest.url}, errors ${latest.errors}, image on disk ${existsSync(latest.imagePath ?? '')}, report mentions the error ${/E2E boom/.test(latest.markdown ?? '')}`);

  // E3
  const waiting = ck('wait', '-t', '30', '--json');
  await sleep(1500);
  await userCapture();
  const waited = await waiting;
  const waitedCapture = JSON.parse(waited.out || '{}');
  verdict('E3 ck wait returns your next capture', waited.code === 0 && waitedCapture.id && waitedCapture.id !== latest.id,
    `exit ${waited.code}, got ${waitedCapture.id} after ${latest.id}`);

  // E4: put another page in front first, so the capture has to pick the right tab.
  await cdp(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  await sleep(500);
  const asked = await ck('capture', `127.0.0.1:${PAGE_PORT}/app`, '--json');
  const askedCapture = JSON.parse(asked.out || '{}');
  const askedText = askedCapture.markdown ?? '';
  verdict('E4 ck capture captures an allowed tab', asked.code === 0 && askedCapture.url === pageUrl && /through the Capture Kit bridge/.test(askedText),
    `exit ${asked.code}, url ${askedCapture.url}, trigger line ${/through the Capture Kit bridge/.test(askedText)} ${asked.err.trim()}`);

  // E5
  const { Client } = await import(join(ROOT, 'bridge/node_modules/@modelcontextprotocol/client/dist/index.mjs'));
  const { StdioClientTransport } = await import(join(ROOT, 'bridge/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'));
  const mcp = new Client({ name: 'e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bridge/bin/mcp.mjs')], env, stderr: 'ignore' }));
  const viaMcp = await mcp.callTool({ name: 'capture_tab', arguments: { url_contains: `127.0.0.1:${PAGE_PORT}/app` } });
  const image = viaMcp.content?.find((c) => c.type === 'image');
  verdict('E5 MCP capture_tab returns the report and the image',
    !viaMcp.isError && /# Capture —/.test(viaMcp.content?.[0]?.text ?? '') && image?.mimeType === 'image/jpeg' && image.data.length > 1000,
    `isError ${viaMcp.isError ?? false}, image ${image ? `${image.mimeType}, ${image.data.length} b64 chars` : 'none'}`);
  await mcp.close();

  // E12: on and off in quick succession, from a disconnected start.
  await options.eval(`chrome.storage.local.set({ bridgeEnabled: false })`);
  await sleep(500);
  await options.eval(`(async () => {
    for (let i = 0; i < 5; i++) {
      chrome.storage.local.set({ bridgeEnabled: true });
      chrome.storage.local.set({ bridgeEnabled: false });
    }
    await chrome.storage.local.set({ bridgeEnabled: false });
    return true;
  })()`);
  await sleep(3000);
  const toggled = JSON.parse((await ck('status', '--json')).out || '{}');
  const toggledState = await options.eval(`chrome.storage.session.get('bridgeStatus').then((s) => s.bridgeStatus?.state ?? null)`);
  verdict('E12 switched off straight after on, the bridge stays off', toggled.connected === false && toggledState === 'off',
    `helper connected=${toggled.connected}, settings page says ${toggledState}`);
  await options.eval(`chrome.storage.local.set({ bridgeEnabled: true })`);
  for (let i = 0; i < 40; i++) {
    if (JSON.parse((await ck('status', '--json')).out || '{}').connected) break;
    await sleep(250);
  }

  // E9
  const sweepTaken = await options.eval(`chrome.tabs.update(${tabId}, { active: true }).then(() => chrome.runtime.sendMessage({ type: 'CAPTURE_SWEEP', tabId: ${tabId} }))`);
  await sleep(1000);
  const sweep = JSON.parse((await ck('latest', '--json')).out || '{}');
  verdict('E9 a sweep reaches the agent with every width',
    sweepTaken?.ok === true && sweep.kind === 'sweep' && existsSync(sweep.imagePath ?? '') &&
      (sweep.extras ?? []).length === 2 && sweep.extras.every((x) => existsSync(x.path)),
    `kind ${sweep.kind}, first image ${existsSync(sweep.imagePath ?? '')}, other widths ${(sweep.extras ?? []).map((x) => x.label).join(', ')}`);

  // E10: the hop tab sits behind another, so asking for it brings it to the front.
  await cdp(`/json/new?${encodeURIComponent(hopUrl)}`, 'PUT');
  await sleep(1000);
  await cdp(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  await sleep(500);
  const before = JSON.parse((await ck('latest', '--json')).out || '{}').id;
  const hopped = await ck('capture', `127.0.0.1:${PAGE_PORT}/hop`);
  await sleep(500);
  const after10 = JSON.parse((await ck('latest', '--json')).out || '{}');
  verdict('E10 a tab that leaves for a site agents may not capture is refused',
    hopped.code !== 0 && /not on a site agents may capture/.test(hopped.err) && after10.id === before && !/127\.0\.0\.2/.test(after10.url ?? ''),
    `exit ${hopped.code}: ${hopped.err.trim()} - latest still ${after10.id === before ? 'the sweep' : after10.url}`);

  // E6
  await options.eval(`chrome.storage.local.set({ bridgeCaptureMode: 'off' })`);
  for (let i = 0; i < 40; i++) {
    if (JSON.parse((await ck('status', '--json')).out || '{}').connected) break;
    await sleep(250);
  }
  const refused = await ck('capture', `127.0.0.1:${PAGE_PORT}/app`);
  verdict('E6 with agent captures off, a capture request is refused', refused.code !== 0 && /turned off/.test(refused.err),
    `exit ${refused.code}: ${refused.err.trim()}`);

  // E7
  await options.eval(`chrome.storage.local.set({ bridgeToken: 'not-the-code-' + 'x'.repeat(40) })`);
  let wrongState = null;
  for (let i = 0; i < 40; i++) {
    wrongState = await options.eval(`chrome.storage.session.get('bridgeStatus').then((s) => s.bridgeStatus?.state ?? null)`);
    if (wrongState === 'mismatch') break;
    await sleep(250);
  }
  const after = JSON.parse((await ck('status', '--json')).out || '{}');
  verdict('E7 a wrong pairing code is refused', wrongState === 'mismatch' && after.connected === false,
    `settings page says ${wrongState}, helper connected=${after.connected}`);

  // E11: an impostor on another port; Capture Kit is pointed at it with the
  // real code. It must refuse to go on and say why, having sent nothing.
  const { WebSocketServer } = await import(join(ROOT, 'bridge/node_modules/ws/wrapper.mjs'));
  const impostorPort = BRIDGE_PORT + 50;
  const heard = [];
  const impostor = new WebSocketServer({ host: '127.0.0.1', port: impostorPort });
  impostor.on('connection', (ws) => {
    ws.on('message', (data) => {
      heard.push(String(data));
      const msg = JSON.parse(String(data));
      if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'challenge', nonce: 'n'.repeat(24), proof: 'guess' }));
    });
  });
  await options.eval(`chrome.storage.local.set(${JSON.stringify({ bridgeToken: token, bridgePort: impostorPort, bridgeCaptureMode: 'any' })})`);
  let impostorState = null;
  for (let i = 0; i < 40; i++) {
    impostorState = await options.eval(`chrome.storage.session.get('bridgeStatus').then((s) => s.bridgeStatus?.state ?? null)`);
    if (impostorState === 'mismatch') break;
    await sleep(250);
  }
  await userCapture();
  await sleep(800);
  impostor.close();
  const leaked = heard.some((m) => m.includes(token) || /"type":"(auth|capture|result)"/.test(m));
  verdict('E11 something else on the port gets nothing', impostorState === 'mismatch' && heard.length >= 1 && !leaked,
    `settings page says ${impostorState}; the impostor heard ${heard.length} message(s): ${heard.map((m) => JSON.parse(m).type).join(', ')}; code or capture leaked: ${leaked}`);
  options.close();
} catch (error) {
  console.error('e2e failed to run:', error);
  results.push({ name: 'run', ok: false });
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
