// Diagnostic only — not part of the extension, not part of the build.
//
//   npm run build && node scripts/capture-fixture.mjs
//   npm run build && node scripts/capture-fixture.mjs --headed
//
// Closes the one link scripts/repro-drawer.mjs argues rather than shows.
// repro-drawer proves the drawer ends up unclipped and inside the document
// box; it does NOT prove those become pixels in the file on disk. This runs
// the real extension — real service worker, real debugger attach, real
// segmented capture, real write — against the same fixture, then decodes the
// written bytes and counts the drawer's colour.
//
// The drawer is #c2185b and appears nowhere else on the page, so "is the
// drawer on disk" reduces to "does that colour exist in the image, and where".
//
// Nothing is written to ~/Downloads or to ~/NoBad/_work/capture-kit: the
// profile's download directory is redirected to a temp dir, and this profile
// has never been granted an output folder, so the extension's write seam takes
// its Downloads fallback into that temp dir.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DRAWER_RGB, DEFAULT_VARIANT, fixture, viewportFor } from './drawer-fixture.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = process.env.CK_DIST ?? `${ROOT}/dist`;
const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/` +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PROFILE = '/tmp/ck-capfix-profile';
const DOWNLOADS = '/tmp/ck-capfix-downloads';
const PORT = 9337;
const HTTP_PORT = 8768;
const HEADED = process.argv.includes('--headed');
const VARIANT = process.argv.find((a) => a.startsWith('--variant='))?.slice(10) ?? DEFAULT_VARIANT;
const VIEWPORT = viewportFor(VARIANT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const dir of [PROFILE, DOWNLOADS]) rmSync(dir, { recursive: true, force: true });
mkdirSync(`${PROFILE}/Default`, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
writeFileSync(
  `${PROFILE}/Default/Preferences`,
  JSON.stringify({ download: { default_directory: DOWNLOADS } }),
);

if (!existsSync(DIST)) {
  console.error(`No build at ${DIST}. Run: npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`Chrome for Testing not found at:\n  ${CHROME}\nSet CHROME_BIN.`);
  process.exit(1);
}

// The image is decoded in the browser — Node has no image decoder here — and
// the bytes come straight out of the folder the capture landed in, so the
// inspector reads exactly what was written.
const INSPECT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>inspecting</title></head>
<body><script>
  const params = new URLSearchParams(location.search);
  const target = { r: ${DRAWER_RGB.r}, g: ${DRAWER_RGB.g}, b: ${DRAWER_RGB.b} };
  const header = { r: 18, g: 58, b: 107 };  // #123a6b, the legitimate fixed chrome
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // JPEG is lossy, so an exact match would report zero on a correct
    // capture. A generous per-channel tolerance still cannot confuse this
    // pink with the page's greys or the lazy block's green.
    const near = (d, i) => Math.abs(d[i] - target.r) < 40 &&
      Math.abs(d[i + 1] - target.g) < 40 && Math.abs(d[i + 2] - target.b) < 40;
    // Grid scan with a bounding box, NOT a per-column threshold. A column
    // threshold silently fails when the drawer is shorter than the image: a
    // fixed drawer is height:100% of the initial containing block (786px here)
    // inside a 2872px capture, so no column ever reaches a 12-of-24-rows bar
    // even though the drawer is plainly on disk. Measured: drawerColumns 0
    // against a drawerPixelShare of 0.0556.
    let hits = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, sampled = 0;
    for (let x = 0; x < c.width; x += 4) {
      for (let y = 0; y < c.height; y += 8) {
        sampled++;
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (!near(d, 0)) continue;
        hits++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    // Legitimate fixed chrome must SURVIVE any fix — counted the same way so
    // a fix that fixes the leak by breaking the header is caught here.
    //
    // Scanned over the FULL height, not the top 200px, and reduced to bands:
    // contiguous runs of rows containing header colour. On the segmented path
    // a header that was left position:fixed repeats once per segment, and a
    // top-capped scan cannot see that. One band = painted once. The header
    // colour is unique to the header rule in the fixture, so a band is the
    // header and nothing else.
    const nearHeader = (d) => Math.abs(d[0] - header.r) < 40 &&
      Math.abs(d[1] - header.g) < 40 && Math.abs(d[2] - header.b) < 40;
    let headerHits = 0;
    const headerBands = [];
    let bandStart = -1;
    for (let y = 0; y < c.height; y += 4) {
      let rowHits = 0;
      for (let x = 0; x < c.width; x += 4) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (nearHeader(d)) { rowHits++; headerHits++; }
      }
      // A real header row is a wide run of colour, not a stray dark pixel.
      // Absolute, not a fraction of image width: a leak widens the image,
      // which would push a perfectly good header below a percentage bar.
      const isHeaderRow = rowHits * 4 >= 200;
      if (isHeaderRow && bandStart < 0) bandStart = y;
      else if (!isHeaderRow && bandStart >= 0) { headerBands.push({ top: bandStart, bottom: y - 4 }); bandStart = -1; }
    }
    if (bandStart >= 0) headerBands.push({ top: bandStart, bottom: c.height - 1 });
    document.title = 'RESULT ' + JSON.stringify({
      width: c.width, height: c.height,
      drawerPixels: hits,
      drawerBox: hits ? { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
      drawerPixelShare: +(hits / sampled).toFixed(4),
      headerPixels: headerHits,
      headerBands: headerBands,
    });
  };
  img.src = '/image?file=' + encodeURIComponent(params.get('file'));
</script></body></html>`;

function captureDir() {
  const candidates = [`${DOWNLOADS}/capture-kit`, DOWNLOADS];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    if (readdirSync(dir).some((n) => !n.startsWith('.') && /\.(jpg|png|md)$/.test(n))) return dir;
  }
  return DOWNLOADS;
}

function newestFile(suffix) {
  const dir = captureDir();
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir)
    .filter((n) => !n.startsWith('.') && n.endsWith(suffix) && !n.startsWith('latest.'))
    .map((n) => ({ name: n, mtime: statSync(`${dir}/${n}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.name ?? null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  if (url.pathname === '/image') {
    const file = `${captureDir()}/${url.searchParams.get('file')}`;
    if (!existsSync(file)) {
      res.writeHead(404).end('no such capture');
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === '/inspect') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INSPECT_PAGE);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture(url.searchParams.get('v') ?? VARIANT, { reportsResult: true, manual: true }));
});
server.listen(HTTP_PORT, '127.0.0.1');

const chrome = spawn(
  CHROME,
  [
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    ...(HEADED ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
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
  try {
    server.close();
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

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

/** Chrome derives an unpacked extension's id from the RESOLVED directory path. */
function fallbackId() {
  const resolved = existsSync(DIST) ? realpathSync(DIST) : DIST;
  const hex = createHash('sha256').update(resolved).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function openTab(url) {
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(1200);
  return (await cdp('/json/list')).find((t) => t.url.startsWith(url.split('?')[0]));
}

async function waitForResult(targetId, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = (await cdp('/json/list')).find((t) => t.id === targetId);
    if (target?.title?.startsWith('RESULT ')) {
      return JSON.parse(
        target.title
          .slice(7)
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'"),
      );
    }
    await sleep(500);
  }
  return { ok: false, error: 'timed out waiting for capture-kit:capture-complete' };
}

// ---- run ----------------------------------------------------------------
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    const v = await cdp('/json/version');
    ready = Boolean(v && v.webSocketDebuggerUrl);
  } catch {
    /* not listening yet */
  }
  if (!ready) await sleep(250);
}
if (!ready) {
  console.error('Chrome never opened a debugging port.');
  cleanup();
  process.exit(1);
}

let extId = fallbackId();
for (let i = 0; i < 24; i++) {
  const targets = await cdp('/json/list');
  const sw = Array.isArray(targets)
    ? targets.find(
        (t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'),
      )
    : null;
  if (sw) {
    extId = new URL(sw.url).host;
    break;
  }
  await sleep(500);
}

const optionsTab = await openTab(`chrome-extension://${extId}/options/options.html`);
const options = new Session(optionsTab.webSocketDebuggerUrl);
await options.open();
await options.send('Runtime.enable');

console.log(`extension id: ${extId}`);
console.log(
  'settings: ' +
    JSON.stringify(
      await options.eval(
        `(async () => {
           await chrome.storage.sync.set({
             allowInPageTrigger: true,   // the only way automation can fire a capture
             openResult: false,          // no result tabs cluttering /json/list
             maintainLatest: false,      // do not touch a latest.* anywhere
             stampUrlOnImage: false,
             bundleFormat: 'jpeg',
           });
           return await chrome.storage.sync.get(
             ['allowInPageTrigger','openResult','maintainLatest','stampUrlOnImage','bundleFormat']);
         })()`,
      ),
    ),
);

const pageUrl = `http://127.0.0.1:${HTTP_PORT}/?v=${encodeURIComponent(VARIANT)}`;
console.log(`\nvariant: ${VARIANT}`);
const page = await openTab(pageUrl);

// ---- live-page residue (C4) --------------------------------------------
// Run against the captured page AFTER the capture has completed and the
// extension's debugger has detached. Everything the pipeline injects is
// namespaced, so "did the page come back clean" is a finite, countable
// question rather than an impression.
//
// `unstickNeutered` is not residue: it is the positive evidence that a
// deliberately no-opped build was the one actually running, for the STEP 1
// negative control. A build that silently failed to apply the no-op reports
// false here even though its capture numbers would look identical.
const RESIDUE_QUERY = `(() => {
  const attrs = ['offscreen','position','prev-style','scroll','force-reveal','expand','expand-h'];
  const counts = {};
  for (const a of attrs) counts[a] = document.querySelectorAll('[data-capture-kit-' + a + ']').length;
  const styles = ['__capture_kit_unstick__','__capture_kit_freeze__',
                  '__capture_kit_force_reveal__','__capture_kit_expand__']
    .filter((id) => document.getElementById(id));
  const drawer = document.getElementById('drawer');
  const cs = drawer ? getComputedStyle(drawer) : null;
  const r = drawer ? drawer.getBoundingClientRect() : null;
  return {
    attrCounts: counts,
    totalAttrs: Object.values(counts).reduce((a, b) => a + b, 0),
    injectedStylesheets: styles,
    drawer: drawer ? {
      visibility: cs.visibility, position: cs.position, display: cs.display,
      transform: cs.transform === 'none' ? 'none' : 'present',
      box: Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left),
      // Interactive again = it answers a hit test at its own centre.
      hitTestSelf: (() => {
        const el = document.elementFromPoint(
          Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)),
          Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
        return el ? (el === drawer || drawer.contains(el)) : null;
      })(),
    } : null,
    scroll: { x: window.scrollX, y: window.scrollY },
    unstickNeutered: window.__ckUnstickNeutered === true,
  };
})()`;

async function residueOf(target) {
  const s = new Session(target.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');
  const out = await s.eval(RESIDUE_QUERY);
  s.close();
  return out;
}

const liveTab = async () => (await cdp('/json/list')).find((t) => t.id === page.id) ?? page;

// Baseline BEFORE the capture fires. The fixture is in manual mode precisely
// so this cannot race the auto-fire timer.
const before = await residueOf(await liveTab());
console.log('page BEFORE capture: ' + JSON.stringify(before));

// Fire the capture the way an agent does — the page's own event.
{
  const s2 = new Session((await liveTab()).webSocketDebuggerUrl);
  await s2.open();
  await s2.send('Runtime.enable');
  await s2.eval('window.__ckFire()');
  s2.close();
}
const detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
await sleep(2500);

const residue = await residueOf(await liveTab());
console.log('page AFTER capture:  ' + JSON.stringify(residue));

// Restoration is post == pre, field by field, not an absolute assertion.
const drift = [];
if (residue.totalAttrs !== 0) drift.push(`residual attributes: ${JSON.stringify(residue.attrCounts)}`);
if (residue.injectedStylesheets.length) drift.push(`residual stylesheets: ${residue.injectedStylesheets.join(',')}`);
for (const k of ['visibility', 'position', 'display', 'transform', 'box', 'hitTestSelf']) {
  if (JSON.stringify(before.drawer?.[k]) !== JSON.stringify(residue.drawer?.[k])) {
    drift.push(`drawer.${k}: ${JSON.stringify(before.drawer?.[k])} -> ${JSON.stringify(residue.drawer?.[k])}`);
  }
}
if (JSON.stringify(before.scroll) !== JSON.stringify(residue.scroll)) {
  drift.push(`scroll: ${JSON.stringify(before.scroll)} -> ${JSON.stringify(residue.scroll)}`);
}
console.log(`C4 live-page restore: ${drift.length ? 'FAIL — ' + drift.join('; ') : 'PASS — post == pre, zero residue'}`);

const image = newestFile('.jpg') ?? newestFile('.png');
const report = newestFile('.md');
console.log(`written to: ${captureDir()}`);
console.log(`image: ${image}`);
console.log(`report: ${report}`);

if (report) {
  console.log(
    'report geometry: ' +
      JSON.stringify(
        readFileSync(`${captureDir()}/${report}`, 'utf8')
          .split('\n')
          .filter((l) => /Viewport:|Full page:|Image file:|Capture mode:/.test(l)),
      ),
  );
}

if (!image) {
  console.log('\nVERDICT: FAIL — no image was written, nothing to inspect');
  cleanup();
  process.exit(1);
}

const inspectTab = await openTab(`http://127.0.0.1:${HTTP_PORT}/inspect?file=${encodeURIComponent(image)}`);
const px = await waitForResult(inspectTab.id, 60000);
console.log('pixels: ' + JSON.stringify(px));

// Any substantial run of drawer-coloured columns is a leak; the widths
// differ per variant (452 for A-D, 384 for S).
// A real drawer is a solid block, not scattered antialiasing: require both
// a population of hits and a box wide enough to be a panel.
const leaked = (px.drawerPixels ?? 0) > 200 && (px.drawerBox?.w ?? 0) >= 80;
console.log(
  `\nVERDICT: ${
    leaked
      ? `LEAKS — the closed drawer is on disk: ${px.drawerPixels} sampled px, ` +
        `box ${px.drawerBox.w}x${px.drawerBox.h} at x ${px.drawerBox.x0}..${px.drawerBox.x1} of ${px.width}, ` +
        `${(px.drawerPixelShare * 100).toFixed(1)}% of sampled pixels`
      : `drawer not present in the written image (${px.drawerPixels} drawer-coloured px)`
  }`,
);
if (px.headerBands) {
  const n = px.headerBands.length;
  console.log(
    `C3 header bands: ${n === 1 ? 'PASS' : 'FAIL'} — ${n} band(s) ${JSON.stringify(px.headerBands)}` +
      (n > 1 ? ' — header repeated per segment' : ''),
  );
}
if (px.headerPixels !== undefined) {
  console.log(
    `fixed header in image: ${px.headerPixels > 100 ? `YES (${px.headerPixels} sampled px) — legitimate chrome survived` : `NO (${px.headerPixels} sampled px) — chrome was LOST`}`,
  );
}

cleanup();
