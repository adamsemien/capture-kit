// Checks for the 2026-10-14 fix round. Self-contained and cross-platform
// (Linux or macOS), so they run without the macOS-only parts of
// scripts/acceptance.mjs.
//
//   npm run build && CHROME_BIN=/path/to/chrome-for-testing node scripts/round-checks.mjs
//
// CHECK A13 - viewport-sized sections keep their real height in a segmented
// capture.
// CHECK A14 - "Copy to clipboard after capture".
// CHECK A15 - a chosen-folder write that fails partway leaves nothing behind.
// CHECK A16 - every scrolling column of a multi-column app shell is unrolled
// (NOBC-151).
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
import * as esbuild from 'esbuild';

const CHROME = process.env.CHROME_BIN;
if (!CHROME || !existsSync(CHROME)) {
  console.log('CHROME_BIN must point at a Chrome for Testing binary (branded Chrome ignores --load-extension).');
  process.exit(2);
}
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// CK_DIST points the checks at another build, e.g. an older commit, to show
// a verdict fails without the change under test.
const DIST = process.env.CK_DIST ?? `${ROOT}/dist`;
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

// CHECK A15's subject: the real writeFileAtomically from src/lib/output-dir.ts,
// bundled for a plain page and driven against the origin-private file system,
// which exposes the same directory/file handle API the chosen folder does.
const A15_BUNDLE = (
  await esbuild.build({
    stdin: {
      contents: `export { writeFileAtomically } from '${ROOT}/src/lib/output-dir.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'warning',
  })
).outputFiles[0].text;

// The bad chunk is a truncate with no size, which the stream rejects - after
// the good chunk before it has already reached the swap file. That is the
// shape of a write that dies partway.
const A15_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>a15</title></head><body>
<script type="module">
  import { writeFileAtomically } from '/a15.js';
  const BAD = { type: 'truncate' };
  // Pre-fix shape, kept here as the control: close() in a finally.
  async function preFix(dir, target, chunks) {
    const fh = await dir.getFileHandle(target, { create: true });
    const w = await fh.createWritable();
    try { for (const c of chunks) await w.write(c); } finally { await w.close(); }
  }
  const read = async (dir, name) => {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
    catch (e) { return e.name === 'NotFoundError' ? null : 'ERR ' + e.name; }
  };
  const out = {};
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });

    // 1. A fresh name, failing partway.
    let threw = false;
    try { await writeFileAtomically(root, 'fresh.jpg', ['AAAAAAAA', BAD], false); } catch { threw = true; }
    out.fresh = { threw, left: await read(root, 'fresh.jpg') };

    // 2. An existing latest.jpg, overwrite failing partway.
    await writeFileAtomically(root, 'latest.jpg', ['OLD-BYTES'], false);
    threw = false;
    try { await writeFileAtomically(root, 'latest.jpg', ['NEWNEW', BAD], true); } catch { threw = true; }
    out.existing = { threw, left: await read(root, 'latest.jpg') };

    // 3. The ordinary case still writes.
    await writeFileAtomically(root, 'ok.jpg', ['GOOD', '-BYTES'], false);
    out.ok = await read(root, 'ok.jpg');

    // Control: the pre-fix shape on the same failing input.
    threw = false;
    try { await preFix(root, 'control.jpg', ['AAAAAAAA', BAD]); } catch { threw = true; }
    out.control = { threw, left: await read(root, 'control.jpg') };
  } catch (e) {
    out.error = String(e);
  }
  document.title = 'RESULT ' + JSON.stringify(out);
</script></body></html>`;

// CHECK A16's fixture: the NoBC OS event builder's shape. A document that does
// not scroll, three columns side by side, two of which scroll on their own,
// and neither of those covers 40% of the screen - the old single-winner rule's
// floor. Each scrolling column ends in a sentinel colour that paints only if
// that column was unrolled to its end. The settings column carries a sticky
// tab bar that must paint once, not once per screen. A small fixed chat widget
// scrolls too, and its hidden content must stay hidden. ?shell=fixed puts the
// whole app in a position:fixed inset:0 shell, the other common app shape.
const A16 = {
  sentinelPreview: [0, 180, 90],
  sentinelSettings: [230, 120, 0],
  stickyTabs: [120, 0, 160],
  widgetHidden: [250, 0, 120],
  // The hero of the page inside the preview iframe: height:100vh, so it is
  // exactly as tall as the frame. A frame that grew with its column makes
  // the hero grow with it.
  frameHero: [20, 90, 220],
  // At a 1300px window each scrolling column is 500 / 1300 = 38% of the
  // screen, under the old 40% floor - the builder's shape. A settings column
  // that reached 40% would be unrolled by the old rule too, and the preview
  // would stretch beside it, so the check would prove nothing.
  columns: { nav: 150, preview: 300 + 250, settings: 800 + 250 },
};
const rgb = (c) => `rgb(${c.join(',')})`;
// ?shell=app is the NoBC OS operator shell, measured on the live builder on
// 2026-10-14: a min-h-dvh flex row, a flex-1 flex-col <main> with a header,
// and the builder row as a flex:1 1 0px, min-height:0, overflow:hidden child
// of that column. A flex-basis of 0 means the row's size never comes from its
// content, so unrolled columns cannot push it taller and its overflow:hidden
// clips them - the capture stayed one screen tall with two scrollers expanded.
// The settings column also holds a <textarea> that scrolls; form controls are
// never unrolled.
// ?frame=1 swaps the preview column for the builder's live preview: a pane
// whose child is an iframe filling it (h-full), the page inside sized in vh.
const FRAME_DOC = `<!doctype html><html><head><style>html,body{margin:0}
.hero{height:100vh;background:rgb(${A16.frameHero.join(',')})}.rest{height:2000px;background:#222}</style></head>
<body><div class="hero"></div><div class="rest"></div></body></html>`;
const appShellPage = (withFrame = false) => `<!doctype html>
<html><head><meta charset="utf-8"><title>ready</title><style>
html,body{margin:0;font:14px sans-serif}
.app{display:flex;min-height:100dvh}
.side{width:300px;flex:none;background:#3a3a3a}
main{display:flex;flex-direction:column;flex:1 1 0%;min-width:0;min-height:100dvh}
header{height:48px;flex:none;background:#ddd}
.row{display:flex;flex:1 1 0px;min-height:0;overflow:hidden}
.preview{flex:1 1 0%;min-height:0;overflow:auto;background:#111}
.settings{flex:1 1 0%;overflow-y:auto;background:#f6f3ee}
.tabs{position:sticky;top:0;height:56px;background:${rgb(A16.stickyTabs)}}
.r{height:120px;border-bottom:1px solid #ccc}
.sentinel-preview{height:160px;background:${rgb(A16.sentinelPreview)}}
.sentinel-settings{height:160px;background:${rgb(A16.sentinelSettings)}}
textarea{display:block;width:90%;height:220px;margin:12px}
</style></head><body>
<div class="app"><div class="side"></div><main><header></header><div class="row">
  ${withFrame
    ? `<div class="preview" style="overflow:hidden;display:flex;flex-direction:column"><iframe style="border:0;width:100%;flex:1 1 0%;min-height:0" srcdoc="${FRAME_DOC.replace(/"/g, '&quot;')}"></iframe></div>`
    : `<div class="preview">${'<div class="r"></div>'.repeat(18)}<div class="sentinel-preview"></div></div>`}
  <div class="settings"><div class="tabs"></div><textarea>${'line\n'.repeat(60)}</textarea>${'<div class="r"></div>'.repeat(26)}<div class="sentinel-settings"></div></div>
</div></main></div>
<script>
  document.addEventListener('capture-kit:capture-complete', (e) => {
    document.title = 'RESULT ' + JSON.stringify({ detail: e.detail, innerHeight, innerWidth });
  });
  addEventListener('load', () => setTimeout(() => {
    document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  }, 800));
</script></body></html>`;

const multiColumnPage = (fixedShell) => `<!doctype html>
<html><head><meta charset="utf-8"><title>ready</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:14px sans-serif}
.shell{display:flex;height:100vh;${fixedShell ? 'position:fixed;inset:0;height:auto;' : ''}}
nav{flex:1;min-width:0;background:#3a3a3a;color:#ddd;padding:16px;box-sizing:border-box}
.preview{width:500px;flex:none;overflow-y:auto;background:#111}
.settings{width:500px;flex:none;overflow-y:auto;background:#f6f3ee}
.tabs{position:sticky;top:0;height:56px;background:${rgb(A16.stickyTabs)}}
.row{height:120px;border-bottom:1px solid #ddd}
.preview .row{border-color:#222}
.sentinel-preview{height:160px;background:${rgb(A16.sentinelPreview)}}
.sentinel-settings{height:160px;background:${rgb(A16.sentinelSettings)}}
.widget{position:fixed;right:16px;bottom:16px;width:280px;height:240px;overflow-y:auto;background:#fff;box-shadow:0 2px 12px #0004}
.widget .top{height:240px;background:#fafafa}
.widget .hidden{height:600px;background:${rgb(A16.widgetHidden)}}
</style></head><body>
<div class="shell">
  <nav>Dashboard<br>Events<br>Members</nav>
  <div class="preview">${'<div class="row"></div>'.repeat(18)}<div class="sentinel-preview"></div></div>
  <div class="settings"><div class="tabs"></div>${'<div class="row"></div>'.repeat(26)}<div class="sentinel-settings"></div></div>
</div>
<div class="widget"><div class="top"></div><div class="hidden"></div></div>
<script>
  document.addEventListener('capture-kit:capture-complete', (e) => {
    document.title = 'RESULT ' + JSON.stringify({ detail: e.detail, innerHeight, innerWidth });
  });
  addEventListener('load', () => setTimeout(() => {
    document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  }, 800));
</script></body></html>`;

// Counts each named colour down one column of the image: total pixels and
// the number of separate runs (a sticky bar painted per screen is many runs).
const INSPECT_COLUMNS = `<!doctype html><html><head><meta charset="utf-8"><title>inspecting</title></head><body><script>
  const q = new URLSearchParams(location.search);
  const spec = JSON.parse(q.get('spec'));
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const out = { width: c.width, height: c.height, colours: {} };
    for (const s of spec) {
      const x = Math.min(c.width - 1, s.x);
      const col = ctx.getImageData(x, 0, 1, c.height).data;
      let pixels = 0, runs = 0, inRun = false;
      for (let y = 0; y < c.height; y++) {
        const hit = Math.abs(col[y*4] - s.rgb[0]) < 24 && Math.abs(col[y*4+1] - s.rgb[1]) < 24 && Math.abs(col[y*4+2] - s.rgb[2]) < 24;
        if (hit) { pixels++; if (!inRun) runs++; }
        inRun = hit;
      }
      out.colours[s.name] = { pixels, runs };
    }
    document.title = 'RESULT ' + JSON.stringify(out);
  };
  img.src = '/image?file=' + encodeURIComponent(q.get('file'));
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
  } else if (url.pathname === '/multi-column') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const shell = url.searchParams.get('shell');
    res.end(
      shell === 'app'
        ? appShellPage(url.searchParams.get('frame') === '1')
        : multiColumnPage(shell === 'fixed'),
    );
  } else if (url.pathname === '/inspect-columns') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(INSPECT_COLUMNS);
  } else if (url.pathname === '/a15') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(A15_PAGE);
  } else if (url.pathname === '/a15.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(A15_BUNDLE);
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

async function captureFixture(path = '/fixture', inspect = (image) => `/inspect?file=${encodeURIComponent(image)}`) {
  const url = `http://127.0.0.1:${HTTP_PORT}${path}${path.includes('?') ? '&' : '?'}n=${Date.now()}`;
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
  const inspectUrl = `http://127.0.0.1:${HTTP_PORT}${inspect(image)}`;
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

// --- CHECK A17 - straight to clipboard, no tab ------------------------------
// The keyboard shortcut and toolbar icon cannot be pressed by automation, so
// this drives the two halves that can be: the content script's COPY_IMAGE
// write into a focused page, read back from that page's own origin; and the
// popup path with the same settings, which must fall back to the result tab
// rather than leave nothing to paste. The decision rule itself is in the unit
// tests. A real shortcut capture is Adam's check.
{
  const run = await launch(DIST, { openResult: false, autoCopyImage: true, bundleFormat: 'jpeg' });
  console.log(`\n--- A17 straight to clipboard (extension ${run.id}) ---`);
  const pageUrl = `http://127.0.0.1:${HTTP_PORT}/inspect-blank?a17=${Date.now()}`;
  await cdp(`/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
  await sleep(800);
  const page = (await cdp('/json/list')).find((t) => t.url === pageUrl);
  const b = new Session((await cdp('/json/version')).webSocketDebuggerUrl);
  await b.open();
  for (const name of ['clipboard-read', 'clipboard-write']) {
    await b.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin: `http://127.0.0.1:${HTTP_PORT}` });
  }
  const ps = new Session(page.webSocketDebuggerUrl);
  await ps.open();
  await ps.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Send COPY_IMAGE from an extension page, the way the service worker does.
  await cdp(`/json/new?${encodeURIComponent(`chrome-extension://${run.id}/options/options.html`)}`, 'PUT');
  await sleep(800);
  const opt = (await cdp('/json/list')).find((t) => t.url.startsWith(`chrome-extension://${run.id}/options`));
  const os = new Session(opt.webSocketDebuggerUrl);
  await os.open();
  const sent = await os.eval(`(async () => {
    const c = new OffscreenCanvas(40, 30); const x = c.getContext('2d');
    x.fillStyle = 'rgb(10,200,120)'; x.fillRect(0, 0, 40, 30);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl)} });
    return await chrome.tabs.sendMessage(tab.id, { type: 'COPY_IMAGE', pngBase64: btoa(bin), text: 'A17 report text' });
  })()`);
  console.log('COPY_IMAGE response: ' + JSON.stringify(sent));
  const clip = await ps.eval(`(async () => {
    try {
      const out = [];
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          out.push({ type, bytes: blob.size, text: type.startsWith('text/') ? await blob.text() : null });
        }
      }
      return out;
    } catch (error) { return { error: String(error) }; }
  })()`);
  console.log('clipboard: ' + JSON.stringify(clip));
  const types = Array.isArray(clip) ? clip.map((c) => c.type) : [];
  verdict('A17 the page writes image and report', sent?.ok === true && types.includes('image/png') && types.includes('text/plain'), `response ${JSON.stringify(sent)}, types ${JSON.stringify(types)}`);
  verdict('A17 the report text is the one sent', Array.isArray(clip) && clip.some((c) => c.text === 'A17 report text'), JSON.stringify(clip));
  // A page that is not focused cannot take the write, and says so.
  await ps.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  ps.close();
  os.close();
  b.close();
  for (const t of await cdp('/json/list')) {
    if (t.type === 'page' && t.url !== 'about:blank') await cdp(`/json/close/${t.id}`);
  }

  // Popup path, same settings: the popup holds focus, so the tab opens.
  const url = `http://127.0.0.1:${HTTP_PORT}/inspect-blank?a17pop=${Date.now()}`;
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(800);
  await cdp(`/json/new?${encodeURIComponent(`chrome-extension://${run.id}/options/options.html`)}`, 'PUT');
  await sleep(800);
  const opt2 = (await cdp('/json/list')).find((t) => t.url.startsWith(`chrome-extension://${run.id}/options`));
  const os2 = new Session(opt2.webSocketDebuggerUrl);
  await os2.open();
  const resp = await os2.eval(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(url)} });
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 400));
    return await chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE' });
  })()`);
  os2.close();
  let opened = false;
  for (let i = 0; i < 20 && !opened; i++) {
    opened = (await cdp('/json/list')).some((t) => t.url.startsWith(`chrome-extension://${run.id}/result/`));
    if (!opened) await sleep(400);
  }
  console.log('popup-path capture: ' + JSON.stringify(resp));
  verdict('A17 the popup path falls back to the result tab', resp?.ok === true && resp?.copied === false && opened, `copied ${resp?.copied}, result tab ${opened}`);
}

// --- CHECK A15 - a write that fails partway leaves nothing behind ----------
{
  await launch(DIST);
  console.log('\n--- A15 failed writes ---');
  const url = `http://127.0.0.1:${HTTP_PORT}/a15?n=${Date.now()}`;
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(500);
  const tab = (await cdp('/json/list')).find((t) => t.url === url);
  const r = await titleResult(tab.id, 20000);
  console.log(JSON.stringify(r));
  verdict(
    'A15 a fresh name that fails partway leaves no file',
    r.fresh?.threw === true && r.fresh?.left === null,
    `threw ${r.fresh?.threw}, left ${JSON.stringify(r.fresh?.left)}`,
  );
  verdict(
    'A15 an existing file keeps its old bytes when an overwrite fails',
    r.existing?.threw === true && r.existing?.left === 'OLD-BYTES',
    `threw ${r.existing?.threw}, left ${JSON.stringify(r.existing?.left)}`,
  );
  verdict('A15 an ordinary write still lands', r.ok === 'GOOD-BYTES', JSON.stringify(r.ok));
  // The control measures what the old code actually left: not a truncated
  // file (an errored stream commits nothing on close) but an empty one, under
  // the real name, in the chosen folder.
  verdict(
    'A15 is falsifiable - the pre-fix shape leaves a 0-byte file',
    r.control?.threw === true && r.control?.left === '',
    `threw ${r.control?.threw}, left ${JSON.stringify(r.control?.left)}`,
  );
}

// --- CHECK A16 - every scrolling column is unrolled (NOBC-151) -------------
// The control is a real older build, not a neutered copy: CK_CONTROL_DIST
// points at main's dist from before this change, which unrolled one scroller
// at 40% of the screen or nothing.
{
  const spec = [
    { name: 'previewEnd', rgb: A16.sentinelPreview, x: A16.columns.preview },
    { name: 'settingsEnd', rgb: A16.sentinelSettings, x: A16.columns.settings },
    { name: 'stickyTabs', rgb: A16.stickyTabs, x: A16.columns.settings },
    // The widget sits bottom-right; its hidden content would land in the
    // settings column if it were unrolled.
    { name: 'widgetHidden', rgb: A16.widgetHidden, x: A16.columns.settings + 80 },
  ];
  const inspect = (image) => `/inspect-columns?file=${encodeURIComponent(image)}&spec=${encodeURIComponent(JSON.stringify(spec))}`;
  const runA16 = async (label, shell) => {
    const r = await captureFixture(`/multi-column${shell === 'flex' ? '' : `?shell=${shell}`}`, inspect);
    console.log(`\n--- ${label} ---`);
    if (r.error) {
      console.log('error: ' + r.error);
      return null;
    }
    console.log('report: ' + r.modeLine.trim());
    console.log('image: ' + JSON.stringify(r.px));
    return r;
  };
  await launch(DIST);
  for (const shell of ['flex', 'fixed', 'app']) {
    const r = await runA16(`A16 real build, ${shell} shell`, shell);
    if (!r) {
      verdict(`A16 ${shell} capture ran`, false, 'no capture');
      continue;
    }
    const c = r.px.colours;
    verdict(`A16 ${shell} preview column unrolled to its end`, c.previewEnd.pixels >= 140, `sentinel ${c.previewEnd.pixels}px`);
    verdict(`A16 ${shell} settings column unrolled to its end`, c.settingsEnd.pixels >= 140, `sentinel ${c.settingsEnd.pixels}px`);
    verdict(`A16 ${shell} sticky tab bar paints once`, c.stickyTabs.runs === 1, `${c.stickyTabs.runs} run(s), ${c.stickyTabs.pixels}px`);
    verdict(`A16 ${shell} chat widget stays closed`, c.widgetHidden.pixels === 0, `${c.widgetHidden.pixels}px of its hidden content`);
    // Exactly two: the textarea in the app shell scrolls too and must not count.
    verdict(`A16 ${shell} report counts both columns`, /expanded inner scroll \(2 scrollers\)/.test(r.modeLine), r.modeLine.trim());
  }
  // The builder's preview: the settings column unrolls, the embedded page
  // keeps its on-screen height (757 - 48 header = 709px of hero).
  {
    const fspec = [
      { name: 'frameHero', rgb: A16.frameHero, x: A16.columns.preview },
      { name: 'settingsEnd', rgb: A16.sentinelSettings, x: A16.columns.settings },
    ];
    const r = await captureFixture(
      '/multi-column?shell=app&frame=1',
      (image) => `/inspect-columns?file=${encodeURIComponent(image)}&spec=${encodeURIComponent(JSON.stringify(fspec))}`,
    );
    console.log('\n--- A16 real build, app shell with a preview iframe ---');
    if (r.error) {
      verdict('A16 frame capture ran', false, r.error);
    } else {
      console.log('report: ' + r.modeLine.trim());
      console.log('image: ' + JSON.stringify(r.px));
      const c = r.px.colours;
      const onScreen = r.page.innerHeight - 48;
      verdict('A16 frame settings column still unrolled', c.settingsEnd.pixels >= 140, `sentinel ${c.settingsEnd.pixels}px`);
      verdict(
        'A16 frame embedded page keeps its screen height',
        Math.abs(c.frameHero.pixels - onScreen) <= 4 && c.frameHero.runs === 1,
        `hero ${c.frameHero.pixels}px in ${c.frameHero.runs} run(s), on screen ${onScreen}px`,
      );
      verdict(
        'A16 frame report says the frame was kept',
        /1 embedded frame kept at screen height/.test(r.modeLine),
        r.modeLine.trim(),
      );
    }
  }

  const control = process.env.CK_CONTROL_DIST;
  if (!control || !existsSync(control)) {
    console.log('\nA16 falsifiability skipped: set CK_CONTROL_DIST to a dist built from main before this change');
  } else {
    await launch(control);
    const r = await runA16('A16 falsifiability - control build (one scroller at 40% or nothing)', 'flex');
    const c = r?.px?.colours;
    verdict(
      'A16 is falsifiable',
      !!c && c.previewEnd.pixels === 0 && c.settingsEnd.pixels === 0,
      c ? `control: preview sentinel ${c.previewEnd.pixels}px, settings sentinel ${c.settingsEnd.pixels}px` : 'control capture failed',
    );
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`);
await stop();
server.close();
process.exit(failures === 0 ? 0 : 1);
