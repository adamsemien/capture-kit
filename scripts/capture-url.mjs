// Diagnostic only - not part of the extension, not part of the build.
//
//   npm run build && node scripts/capture-url.mjs <url> [<url> ...] [--out=DIR] [--size=1440x900]
//
// Runs the real extension (service worker, debugger attach, real capture
// path, real write) against live public pages in a throwaway profile, and
// copies each written image and report to --out. This is how a page-type bug
// gets reproduced without ever firing a capture on Adam's own tabs.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = process.env.CK_DIST ?? `${ROOT}/dist`;
const CHROME = process.env.CHROME_BIN;
const PROFILE = '/tmp/ck-url-profile';
const DOWNLOADS = '/tmp/ck-url-downloads';
const PORT = 9339;
const args = process.argv.slice(2);
const URLS = args.filter((a) => !a.startsWith('--'));
const OUT = args.find((a) => a.startsWith('--out='))?.slice(6) ?? '/tmp/ck-url-out';
const [W, H] = (args.find((a) => a.startsWith('--size='))?.slice(7) ?? '1440x900').split('x').map(Number);
const SETTLE_MS = Number(args.find((a) => a.startsWith('--settle='))?.slice(9) ?? 4000);
// --scroll uses the scroll-capture path (as the popup button does); --hover=x,y
// moves the mouse there first, so "the panel under the pointer" is testable.
const SCROLL = args.includes('--scroll');
const HOVER = args.find((a) => a.startsWith('--hover='))?.slice(8).split(',').map(Number);
const DPR = args.find((a) => a.startsWith('--dpr='))?.slice(6);

if (!CHROME || !existsSync(CHROME)) {
  console.error('Set CHROME_BIN to a Chrome for Testing binary.');
  process.exit(1);
}
if (!URLS.length) {
  console.error('Give at least one URL.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dir of [PROFILE, DOWNLOADS]) rmSync(dir, { recursive: true, force: true });
mkdirSync(`${PROFILE}/Default`, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(
  `${PROFILE}/Default/Preferences`,
  JSON.stringify({ download: { default_directory: DOWNLOADS } }),
);

const chrome = spawn(
  CHROME,
  [
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${W},${H}`,
    ...(DPR ? [`--force-device-scale-factor=${DPR}`] : []),
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
};
process.on('exit', cleanup);

const cdp = async (path, method = 'GET') => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

class Session {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function fallbackId() {
  const resolved = existsSync(DIST) ? realpathSync(DIST) : DIST;
  const hex = createHash('sha256').update(resolved).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function openTab(url) {
  const t = await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  return t;
}

function newest(dirList, re, since) {
  let best = null;
  for (const dir of dirList) {
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) {
      if (!re.test(n)) continue;
      const m = statSync(`${dir}/${n}`).mtimeMs;
      if (m >= since && (!best || m > best.m)) best = { p: `${dir}/${n}`, n, m };
    }
  }
  return best;
}

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  try {
    ready = Boolean((await cdp('/json/version'))?.webSocketDebuggerUrl);
  } catch {}
  if (!ready) await sleep(250);
}
if (!ready) {
  console.error('Chrome never opened a debugging port.');
  process.exit(1);
}

let extId = fallbackId();
for (let i = 0; i < 24; i++) {
  const targets = await cdp('/json/list');
  const sw = Array.isArray(targets)
    ? targets.find((t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'))
    : null;
  if (sw) {
    extId = new URL(sw.url).host;
    break;
  }
  await sleep(500);
}
const optTab = await openTab(`chrome-extension://${extId}/options/options.html`);
await sleep(1200);
const opt = new Session(optTab.webSocketDebuggerUrl);
await opt.open();
await opt.send('Runtime.enable');
await opt.eval(`chrome.storage.sync.set({
  pageTriggerMode: 'any', openResult: false, maintainLatest: false,
  stampUrlOnImage: true, bundleFormat: 'png' })`);

const results = [];
for (const [i, url] of URLS.entries()) {
  const started = Date.now();
  const tab = await openTab(url);
  const s = new Session(tab.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');
  // Wait for load, then let the page settle.
  for (let k = 0; k < 60; k++) {
    try {
      if ((await s.eval('document.readyState')) === 'complete') break;
    } catch {}
    await sleep(500);
  }
  await sleep(SETTLE_MS);
  let detail;
  if (HOVER) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: HOVER[0], y: HOVER[1] });
    await sleep(300);
  }
  if (SCROLL) {
    // The address as the browser holds it (a bare host gains a trailing slash).
    const href = await s.eval('location.href');
    const tabId = await opt.eval(
      `chrome.tabs.query({}).then((ts) => ts.find((x) => x.url === ${JSON.stringify(href)})?.id ?? null)`,
    );
    await opt.eval(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
    await sleep(300);
    try {
      detail = await opt.eval(`chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE', tabId: ${tabId}, scroll: true })`);
    } catch (e) {
      detail = { ok: false, error: String(e) };
    }
  } else try {
    detail = await s.eval(`new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 120000);
      document.addEventListener('capture-kit:capture-complete', (e) => { clearTimeout(t); resolve(e.detail); }, { once: true });
      document.dispatchEvent(new CustomEvent('capture-kit:capture'));
    })`);
  } catch (e) {
    detail = { ok: false, error: String(e) };
  }
  await sleep(1500);
  const dirs = [`${DOWNLOADS}/capture-kit`, DOWNLOADS];
  const img = newest(dirs, /\.(png|jpg)$/, started);
  const md = newest(dirs, /\.md$/, started);
  const tag = String(i + 1).padStart(2, '0') + '-' + new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');
  if (img) copyFileSync(img.p, `${OUT}/${tag}${img.n.slice(img.n.lastIndexOf('.'))}`);
  if (md) copyFileSync(md.p, `${OUT}/${tag}.md`);
  const line = { url, ok: detail?.ok ?? null, error: detail?.error ?? detail?.reason, image: img ? `${OUT}/${tag}` : null };
  results.push(line);
  console.log(JSON.stringify(line));
  s.close();
  try {
    await cdp(`/json/close/${tab.id}`);
  } catch {}
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
cleanup();
process.exit(0);
