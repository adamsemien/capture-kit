// Checks for the 2026-10-14 fix round. Self-contained and cross-platform
// (Linux or macOS), so they run without the macOS-only parts of
// scripts/acceptance.mjs.
//
//   npm run build && CHROME_BIN=/path/to/chrome-for-testing node scripts/round-checks.mjs
//
// CHECK A13 - viewport-sized sections keep their real height in a segmented
// capture.
//
// The defect: the segmented path overrides the viewport to as much as
// segmentSize tall, so every viewport-unit length resolves against that
// virtual viewport instead of the one the user sees. A 100vh hero came out
// thousands of pixels tall. The fix (VH_RECORD/HOLD/RELEASE in
// cdp-fullpage.ts) holds those lengths at their real-viewport values.
//
// What this proves, against the real built extension fired through the
// in-page trigger:
//   1. Every viewport-sized fixture section paints at its on-screen height,
//      within 2px, on a page tall enough to take the segmented path.
//   2. The report names the hold.
//   3. Zero residue: every attribute on every element, and the <head>, are
//      identical before and after the capture.
//   4. Falsifiable: a copy of the build with the hold disabled reproduces the
//      stretch, and announces itself from the page so the run cannot be
//      confused with the real build.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN;
if (!CHROME || !existsSync(CHROME)) {
  console.log('CHROME_BIN must point at a Chrome for Testing binary (branded Chrome ignores --load-extension).');
  process.exit(2);
}
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = `${ROOT}/dist`;
const WORK = process.env.CK_ROUND_WORK ?? '/tmp/ck-round-checks';
const DOWNLOADS = `${WORK}/downloads`;
const PORT = Number(process.env.CK_CDP_PORT ?? 9431);
const HTTP_PORT = Number(process.env.CK_HTTP_PORT ?? 8831);
const NEUTERED_DIST = `${WORK}/neutered-dist`;
const BEACON = '__ckVhHoldNeutered';
// The loop that writes the holds, as it appears in the bundle.
const HOLD_LOOP = 'for (const [el, vals, props] of moved) {';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const verdict = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`VERDICT ${name}: ${ok ? 'PASS' : 'FAIL'} - ${detail}`);
};

// Fixture colours. Saturated and far apart so a JPEG-free PNG decode can
// classify every row unambiguously.
const BANDS = [
  { id: 'hero', css: 'height:100vh', rgb: [200, 40, 40], expect: (vh) => vh },
  { id: 'dvh', css: 'height:100dvh', rgb: [40, 170, 40], expect: (vh) => vh },
  { id: 'minh', css: 'min-height:100vh', rgb: [40, 40, 200], expect: (vh) => vh },
  { id: 'calc', css: 'height:calc(100vh - 80px)', rgb: [220, 200, 40], expect: (vh) => vh - 80 },
  // Sized by JavaScript on resize, the way full-bleed heroes often are.
  { id: 'js', css: '', rgb: [200, 40, 200], expect: (vh) => vh },
  // Content-height section padded in viewport units.
  { id: 'pad', css: 'padding:20vh 0', rgb: [40, 190, 200], expect: (vh) => Math.round(vh * 0.4) + 100 },
];

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ready</title>
<style>
html,body{margin:0}
section{box-sizing:border-box}
${BANDS.map((b) => `#${b.id}{${b.css};background:rgb(${b.rgb.join(',')})}`).join('\n')}
#pad>div{height:100px}
#rest{height:9000px;background:repeating-linear-gradient(#f4f4f4 0 200px,#e2e2e2 200px 400px)}
</style></head>
<body>
${BANDS.map((b) => `<section id="${b.id}">${b.id === 'pad' ? '<div></div>' : ''}</section>`).join('\n')}
<section id="rest"></section>
<script>
  const js = document.getElementById('js');
  const fit = () => { js.style.height = innerHeight + 'px'; };
  fit();
  addEventListener('resize', fit);
  const snapshot = () => JSON.stringify({
    head: document.head.innerHTML.length,
    els: [...document.querySelectorAll('*')].map((e) =>
      e.tagName + '|' + [...e.attributes].map((a) => a.name + '=' + a.value).sort().join('&')),
  });
  let before = null;
  document.addEventListener('capture-kit:capture-complete', (e) => {
    setTimeout(() => {
      const after = snapshot();
      const b = JSON.parse(before), a = JSON.parse(after);
      const diffs = [];
      for (let i = 0; i < Math.max(b.els.length, a.els.length); i++) {
        if (b.els[i] !== a.els[i]) diffs.push({ before: b.els[i], after: a.els[i] });
      }
      document.title = 'RESULT ' + JSON.stringify({
        detail: e.detail,
        innerHeight,
        heads: [b.head, a.head],
        residue: diffs.slice(0, 5),
        residueCount: diffs.length + (b.head === a.head ? 0 : 1),
        neutered: document.documentElement.hasAttribute('${BEACON}'),
      });
    }, 600);
  });
  addEventListener('load', () => setTimeout(() => {
    before = snapshot();
    document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  }, 800));
</script>
</body></html>`;

// A one-screen page for the clipboard and sweep checks: fires the capture on
// load and reports completion through its title, like FIXTURE.
const SHORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ready</title></head>
<body style="margin:0;font:16px sans-serif"><h1>capture-kit round checks</h1>
<div style="height:300px;background:rgb(30,120,220)"></div>
<script>
  document.addEventListener('capture-kit:capture-complete', (e) => {
    document.title = 'RESULT ' + JSON.stringify({ detail: e.detail });
  });
  addEventListener('load', () => setTimeout(() => {
    document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  }, 800));
</script></body></html>`;

// Decodes the capture in a Chrome tab (no image decoder in Node, no
// dependencies here) and reports run lengths of each fixture colour down the
// middle column.
const INSPECT = `<!doctype html><html><head><meta charset="utf-8"><title>inspecting</title></head><body><script>
  const bands = ${JSON.stringify(BANDS.map((b) => ({ id: b.id, rgb: b.rgb })))};
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const x = Math.floor(c.width / 2);
    const col = ctx.getImageData(x, 0, 1, c.height).data;
    const runs = {};
    for (const b of bands) runs[b.id] = [];
    let cur = null, start = 0;
    const classify = (y) => {
      const r = col[y * 4], g = col[y * 4 + 1], bl = col[y * 4 + 2];
      for (const b of bands) {
        if (Math.abs(r - b.rgb[0]) < 24 && Math.abs(g - b.rgb[1]) < 24 && Math.abs(bl - b.rgb[2]) < 24) return b.id;
      }
      return null;
    };
    for (let y = 0; y <= c.height; y++) {
      const k = y < c.height ? classify(y) : null;
      if (k !== cur) {
        if (cur) runs[cur].push(y - start);
        cur = k; start = y;
      }
    }
    document.title = 'RESULT ' + JSON.stringify({ width: c.width, height: c.height, runs });
  };
  img.src = '/image?file=' + encodeURIComponent(new URLSearchParams(location.search).get('file'));
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  if (url.pathname === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  } else if (url.pathname === '/inspect-blank') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>reader</title><p>reader</p>');
  } else if (url.pathname === '/short') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SHORT_PAGE);
  } else if (url.pathname === '/inspect') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(INSPECT);
  } else if (url.pathname === '/image') {
    const file = url.searchParams.get('file');
    res.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    res.end(readFileSync(file));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));

async function cdp(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __threw: r.exceptionDetails.exception?.description };
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

let child = null;
let launches = 0;
async function stop() {
  if (!child) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    child.kill('SIGKILL');
  } catch {
    /* gone */
  }
  await Promise.race([exited, sleep(5000)]);
  child = null;
}
process.on('exit', () => {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  server.close();
});

async function launch(dist, patch = {}) {
  await stop();
  // A fresh profile directory per launch: a killed Chrome can still be
  // flushing the last one.
  launches += 1;
  const profile = `${WORK}/profile-${launches}-${Date.now()}`;
  rmSync(profile, { recursive: true, force: true });
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(`${profile}/Default`, { recursive: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  writeFileSync(
    `${profile}/Default/Preferences`,
    JSON.stringify({ download: { default_directory: DOWNLOADS, prompt_for_download: false } }),
  );
  child = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${dist}`,
      `--disable-extensions-except=${dist}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--headless=new',
      '--no-sandbox',
      '--window-size=1300,900',
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      if ((await cdp('/json/version')).Browser) break;
    } catch {
      /* not up */
    }
  }
  const version = await cdp('/json/version');
  const browser = new Session(version.webSocketDebuggerUrl);
  await browser.open();
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  browser.close();
  let id = null;
  for (let i = 0; i < 30 && !id; i++) {
    const sw = (await cdp('/json/list')).find(
      (t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'),
    );
    if (sw) id = new URL(sw.url).host;
    else await sleep(300);
  }
  if (!id) throw new Error('extension service worker never appeared');
  await cdp(`/json/new?${encodeURIComponent(`chrome-extension://${id}/options/options.html`)}`, 'PUT');
  await sleep(1000);
  const opt = (await cdp('/json/list')).find((t) => t.url.startsWith(`chrome-extension://${id}/options`));
  const options = new Session(opt.webSocketDebuggerUrl);
  await options.open();
  const set = await options.eval(`(async () => {
    await chrome.storage.sync.set(Object.assign({ allowInPageTrigger: true, openResult: false, bundleFormat: 'png',
      segmentSize: 8192, stampUrlOnImage: false, maintainLatest: false }, ${JSON.stringify(patch)}));
    return await chrome.storage.sync.get(null);
  })()`);
  options.close();
  return { id, set };
}

async function titleResult(targetId, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const t = (await cdp('/json/list')).find((x) => x.id === targetId);
    if (t?.title?.startsWith('RESULT ')) {
      return JSON.parse(
        t.title
          .slice(7)
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'"),
      );
    }
    await sleep(400);
  }
  return { error: 'timed out' };
}

function newest(dir, ext) {
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(ext) && !n.startsWith('latest')) found.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

async function captureFixture() {
  const url = `http://127.0.0.1:${HTTP_PORT}/fixture?n=${Date.now()}`;
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(500);
  const tab = (await cdp('/json/list')).find((t) => t.url === url);
  const page = await titleResult(tab.id);
  if (page.error) return { error: page.error };
  // Downloads land a beat after the completion event.
  let image = null;
  let report = null;
  for (let i = 0; i < 30 && !(image && report); i++) {
    image = newest(DOWNLOADS, '.png');
    report = newest(DOWNLOADS, '.md');
    if (!(image && report)) await sleep(300);
  }
  if (!image) return { page, error: 'no image written' };
  const inspectUrl = `http://127.0.0.1:${HTTP_PORT}/inspect?file=${encodeURIComponent(image)}`;
  await cdp(`/json/new?${encodeURIComponent(inspectUrl)}`, 'PUT');
  await sleep(500);
  const itab = (await cdp('/json/list')).find((t) => t.url === inspectUrl);
  const px = await titleResult(itab.id, 20000);
  const md = report ? readFileSync(report, 'utf8') : '';
  const modeLine = md.split('\n').find((l) => /Capture mode/.test(l)) ?? '(no capture mode line)';
  for (const t of [tab, itab]) await cdp(`/json/close/${t.id}`);
  return { page, px, modeLine, image };
}

function neuter() {
  rmSync(NEUTERED_DIST, { recursive: true, force: true });
  cpSync(DIST, NEUTERED_DIST, { recursive: true });
  const worker = `${NEUTERED_DIST}/background/service-worker.js`;
  const src = readFileSync(worker, 'utf8');
  const hits = src.split(HOLD_LOOP).length - 1;
  if (hits !== 1) throw new Error(`neuter target found ${hits} times in the bundle, expected 1`);
  writeFileSync(
    worker,
    src.replace(
      HOLD_LOOP,
      `document.documentElement.setAttribute('${BEACON}', '1'); for (const [el, vals, props] of []) {`,
    ),
  );
}

function judge(label, r, wantHeld) {
  console.log(`\n--- ${label} ---`);
  if (r.error) {
    verdict(`${label} capture ran`, false, r.error);
    return null;
  }
  console.log('completion: ' + JSON.stringify(r.page.detail));
  console.log('report: ' + r.modeLine.trim());
  console.log('image: ' + r.px.width + 'x' + r.px.height + '  runs: ' + JSON.stringify(r.px.runs));
  console.log('build announced itself as neutered: ' + r.page.neutered);
  const vh = r.page.innerHeight;
  const rows = BANDS.map((b) => {
    const runs = r.px.runs[b.id] ?? [];
    const got = runs.reduce((a, n) => a + n, 0);
    return { id: b.id, want: b.expect(vh), got, runs: runs.length };
  });
  return { rows, vh, r, wantHeld };
}

// --- run -------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
console.log(`chrome: ${CHROME}`);

const real = await launch(DIST);
console.log(`extension id (real build): ${real.id}`);
const a = judge('A13 real build', await captureFixture(), true);
if (a) {
  for (const row of a.rows) {
    verdict(
      `A13 ${row.id} paints at its on-screen height`,
      Math.abs(row.got - row.want) <= 2 && row.runs === 1,
      `${row.got}px in ${row.runs} run(s), on screen ${row.want}px (viewport ${a.vh})`,
    );
  }
  verdict(
    'A13 report names the hold',
    /viewport heights held \(\d+ elements\)/.test(a.r.modeLine) && /segmented/.test(a.r.modeLine),
    a.r.modeLine.trim(),
  );
  verdict(
    'A13 zero residue on the page',
    a.r.page.residueCount === 0,
    `${a.r.page.residueCount} attribute/head differences ${JSON.stringify(a.r.page.residue)}`,
  );
  verdict('A13 real build is not the neutered one', a.r.page.neutered === false, `beacon ${a.r.page.neutered}`);
}

neuter();
const off = await launch(NEUTERED_DIST);
console.log(`\nextension id (hold disabled): ${off.id}`);
const n = judge('A13 falsifiability - hold disabled', await captureFixture(), false);
if (n) {
  const hero = n.rows.find((x) => x.id === 'hero');
  verdict(
    'A13 is falsifiable',
    n.r.page.neutered === true && hero.got > hero.want * 2,
    `hold disabled: hero ${hero.got}px against ${hero.want}px on screen, beacon ${n.r.page.neutered}`,
  );
}

// --- CHECK A14 - "Copy to clipboard after capture" -------------------------
// ON: the result tab puts image/png AND the report on the clipboard with no
// click. OFF (the control): the clipboard carries the report text only, as
// before - so the image on the clipboard is the setting's doing.
async function clipboardAfterCapture(id) {
  const url = `http://127.0.0.1:${HTTP_PORT}/short?n=${Date.now()}`;
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(500);
  const tab = (await cdp('/json/list')).find((t) => t.url === url);
  const done = await titleResult(tab.id);
  let result = null;
  for (let i = 0; i < 30 && !result; i++) {
    result = (await cdp('/json/list')).find((t) => t.url.startsWith(`chrome-extension://${id}/result/`));
    if (!result) await sleep(300);
  }
  if (!result) return { done, error: 'no result tab opened' };
  const session = new Session(result.webSocketDebuggerUrl);
  await session.open();
  // Give the write time to land: the PNG re-encode runs first.
  let status = '';
  for (let i = 0; i < 25; i++) {
    status = await session.eval(`document.getElementById('status')?.textContent ?? ''`);
    if (/copied|could not/i.test(status)) break;
    await sleep(300);
  }
  session.close();
  // Read it back from an ordinary page: an extension page cannot read the
  // clipboard without the clipboardRead manifest permission, which this
  // extension does not hold and should not gain for a test.
  // Permission overrides last only as long as the CDP session that set them,
  // so this one stays open until the read is done.
  const b = new Session((await cdp('/json/version')).webSocketDebuggerUrl);
  await b.open();
  for (const name of ['clipboard-read', 'clipboard-write']) {
    await b.send('Browser.setPermission', {
      permission: { name },
      setting: 'granted',
      origin: `http://127.0.0.1:${HTTP_PORT}`,
    });
  }
  await cdp(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  await sleep(300);
  const blank = (await cdp('/json/list')).filter((t) => t.url === 'about:blank').pop();
  const reader = new Session(blank.webSocketDebuggerUrl);
  await reader.open();
  await reader.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // A page that does not fire a capture: same origin, no trigger script.
  await reader.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/inspect-blank?${Date.now()}` });
  await sleep(600);
  const clip = await reader.eval(`(async () => {
    try {
      const items = await navigator.clipboard.read();
      const out = [];
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          out.push({ type, bytes: blob.size, head: type.startsWith('text/') ? (await blob.text()).slice(0, 60) : null });
        }
      }
      return out;
    } catch (error) { return { error: String(error) }; }
  })()`);
  reader.close();
  b.close();
  for (const t of await cdp('/json/list')) {
    if (t.type === 'page' && t.url !== 'about:blank') await cdp(`/json/close/${t.id}`);
  }
  return { done, status, clip };
}

{
  const on = await launch(DIST, { openResult: true, autoCopyImage: true, bundleFormat: 'jpeg' });
  console.log(`\n--- A14 auto-copy ON (extension ${on.id}) ---`);
  const r = await clipboardAfterCapture(on.id);
  console.log('completion: ' + JSON.stringify(r.done?.detail));
  console.log('result tab status: ' + JSON.stringify(r.status));
  console.log('clipboard: ' + JSON.stringify(r.clip));
  const types = Array.isArray(r.clip) ? r.clip.map((c) => c.type) : [];
  const text = Array.isArray(r.clip) ? r.clip.find((c) => c.type === 'text/plain') : null;
  verdict(
    'A14 ON puts the image on the clipboard',
    types.includes('image/png') && (r.clip.find((c) => c.type === 'image/png')?.bytes ?? 0) > 1000,
    `types ${JSON.stringify(types)}`,
  );
  verdict('A14 ON puts the report alongside it', !!text && text.bytes > 200, `text ${text ? text.bytes + 'B' : 'absent'}`);
  verdict('A14 ON says so on screen', /copied/i.test(r.status) && !/could not/i.test(r.status), JSON.stringify(r.status));

  const offRun = await launch(DIST, { openResult: true, autoCopyImage: false, bundleFormat: 'jpeg' });
  console.log(`\n--- A14 auto-copy OFF, the control (extension ${offRun.id}) ---`);
  const o = await clipboardAfterCapture(offRun.id);
  console.log('result tab status: ' + JSON.stringify(o.status));
  console.log('clipboard: ' + JSON.stringify(o.clip));
  const offTypes = Array.isArray(o.clip) ? o.clip.map((c) => c.type) : [];
  verdict(
    'A14 OFF leaves the image off the clipboard',
    Array.isArray(o.clip) && !offTypes.includes('image/png') && offTypes.includes('text/plain'),
    `types ${JSON.stringify(offTypes)}`,
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`);
await stop();
server.close();
process.exit(failures === 0 ? 0 : 1);
