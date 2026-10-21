// Runs the acceptance checks end to end and prints raw output.
//
//   npm run build && node scripts/acceptance.mjs            # headless
//   npm run build && node scripts/acceptance.mjs --headed    # watch it run
//   node scripts/acceptance.mjs --fresh                      # wipe scratch dirs first
//
// CHECK 1–5 cover the output-folder round; CHECK A1–A8 cover the one-click /
// context-block / URL-stamp / copy-naming round.
//
// Headless by default (--headless=new): a full run drives two browser sessions
// and dozens of tabs, and headed that takes over the screen for minutes. The
// only step that cannot run headless is CHECK 1's native folder picker; it is
// skipped with a message rather than faked. Everything else behaves identically
// — verified 2026-08-23, identical results headless and headed.
//
// Constraints this harness works around, all of them real:
//   - Branded Chrome 137+ ignores --load-extension, so this drives Chrome for
//     Testing (same 151 build family).
//   - Only one debugger may attach to a tab, and a capture IS a debugger
//     attach — so the page under capture is never touched over CDP. It reports
//     its result through document.title, which the /json/list endpoint exposes
//     without attaching to anything.
//   - The extension keyboard command cannot be pressed by automation (that is
//     the whole reason feature 2 exists), so captures here are fired the way an
//     agent fires them: the in-page capture-kit:capture event.
//   - Nothing is written to ~/Downloads or to ~/NoBad/_work/capture-kit: the
//     profile's download directory is redirected to a temp dir, and the chosen
//     output folder is a scratch dir.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  DRAWER_RGB,
  F_CHILD_RGB,
  H_SECTION_RGB,
  K_RGB,
  NAV_RGB,
  NAV_WIDTH,
  SENTINEL_RGB,
  V_RGB,
  fixture as drawerFixture,
  viewportFor,
} from './drawer-fixture.mjs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';

const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/` +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// CK_DIST points the harness at a build other than this worktree's — used to
// run the same wide-page check against an older commit's dist and settle
// "pre-existing or introduced by this branch" with evidence instead of
// argument.
const DIST = process.env.CK_DIST ?? `${ROOT}/dist`;
const PROFILE = '/tmp/ck-accept-profile';
const DOWNLOADS = '/tmp/ck-accept-downloads';
const OUTPUT_DIR = `${process.env.HOME}/NoBad/_work/capture-kit-accept`;
// Overridable so a run is not blocked by an unrelated local service holding a
// port. Defaults are unchanged; CK_HTTP_PORT/CK_CDP_PORT are for that case.
const PORT = Number(process.env.CK_CDP_PORT ?? 9334);
const HTTP_PORT = Number(process.env.CK_HTTP_PORT ?? 8765);
const README_NAME = 'README.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => execFileSync('/usr/bin/osascript', ['-e', s], { encoding: 'utf8' }).trim();

// Chrome derives an unpacked extension's id from the RESOLVED directory path.
// On macOS /tmp is a symlink to /private/tmp, so hashing the path as given
// produces an id that does not exist — the options page then 404s and every
// chrome.* eval comes back "undefined", which reads like a product failure
// rather than a harness one. realpath first.
function extensionId(dist = DIST) {
  const resolved = existsSync(dist) ? realpathSync(dist) : dist;
  const hex = createHash('sha256').update(resolved).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * The id Chrome actually assigned, read off the extension's own service-worker
 * target. The path-hash above is only a fallback: it has to match Chrome's
 * canonicalization of the dist path exactly, and when it does not, every
 * chrome.* eval returns undefined and the checks report nonsense instead of
 * failing. Asking the browser removes the guess.
 */
async function discoverExtensionId(fallback) {
  for (let i = 0; i < 20; i++) {
    const targets = await cdp('/json/list');
    const sw = Array.isArray(targets)
      ? targets.find(
          (t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'),
        )
      : null;
    if (sw) return new URL(sw.url).host;
    await sleep(500);
  }
  return fallback;
}

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
  async eval(expression, userGesture = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (r.exceptionDetails) return { __threw: r.exceptionDetails.exception?.description };
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * `?tall=1` renders a few thousand pixels of content so the capture engine
 * takes the segmented path for real. Without it the acceptance page is one
 * viewport tall and "segmented" captures come back as a single segment, which
 * would let the URL-stamp check pass without ever testing the case it exists
 * for. The rows are alternating light shades on purpose — nothing near-black,
 * so the footer detector cannot mistake page content for the band.
 */
function tallBlock(rows = 40) {
  let html = '';
  for (let i = 0; i < rows; i++) {
    const shade = i % 2 === 0 ? '#f2f2f4' : '#e4e4e8';
    html += `<div style="height:120px;background:${shade};padding:8px;font:16px sans-serif">row ${i}</div>`;
  }
  return html;
}

/**
 * `?wide=N` reproduces the shape behind the black-right-column report: an
 * element that is always N px wider than whatever the viewport is, so the
 * page's scrollWidth grows every time the viewport grows. `width: calc(100% +
 * Npx)` is the whole trick — a fixed-width overflow would stop overflowing
 * once the virtual viewport got wide enough, and the bug needs overflow that
 * survives the resize.
 *
 * The strip is a saturated colour, not a shade of grey, so an undrawn canvas
 * column is unmistakable next to it.
 */
function wideBlock(overflowPx) {
  return (
    `<div style="width:calc(100% + ${overflowPx}px);height:100%;` +
    `background:repeating-linear-gradient(90deg,#c2410c 0 60px,#ea580c 60px 120px);` +
    `color:#fff;font:14px sans-serif;padding:4px">` +
    `overflow strip — always ${overflowPx}px wider than the viewport</div>`
  );
}

// The page under capture reports through its title, so nothing has to attach a
// second debugger to it.
const TRIGGER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ready</title></head>
<body style="margin:0"><h1>capture-kit acceptance page</h1>
<p>Some text so the capture has pixels in it.</p>
__WIDE__
__TALL__
<script>
  document.addEventListener('capture-kit:capture-complete', (e) => {
    document.title = 'RESULT ' + JSON.stringify(e.detail);
  });
  window.fire = () => document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  // Fired on load, and again whenever the URL carries a fresh ?n=
  addEventListener('load', () => setTimeout(window.fire, 800));
</script>
</body></html>`;

// Pixel inspector for the URL-stamp checks. Node has no image decoder and this
// repo has no runtime dependencies, so the decoding happens where a decoder
// already exists: a Chrome tab. It draws the capture to a canvas, samples it,
// and reports through document.title — the same no-second-debugger trick the
// trigger page uses.
const INSPECT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>inspecting</title></head>
<body><script>
  const name = new URLSearchParams(location.search).get('file');
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const ctx = c.getContext('2d');
    // A "band row" is a full-width row of near-black pixels, sampled at five
    // x positions. Counting runs of them tells us the band appears exactly
    // once and where — a band stitched into the middle of a segmented capture
    // is the failure this check exists to catch.
    const xs = [2, Math.floor(c.width * 0.25), Math.floor(c.width / 2),
                Math.floor(c.width * 0.75), c.width - 3];
    const dark = (y) => xs.every((x) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return d[0] < 40 && d[1] < 40 && d[2] < 40;
    });
    const runs = [];
    let start = -1;
    for (let y = 0; y < c.height; y++) {
      if (dark(y)) { if (start < 0) start = y; }
      else if (start >= 0) { runs.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) runs.push([start, c.height - 1]);
    // Only runs tall enough to be a band; a dark UI stripe in the page is not one.
    const bands = runs.filter(([a, b]) => b - a + 1 >= 20);

    // Undrawn-canvas detector. A column the segment loop never painted stays
    // at the OffscreenCanvas initial value (transparent black), which encodes
    // as solid black in JPEG and as transparent in PNG. Both are caught by
    // sampling a column top-to-bottom and asking whether every sample is
    // either fully transparent or near-black. Rows inside the URL footer are
    // skipped, since the footer legitimately paints the full width dark.
    const footerTop = bands.length ? Math.min(...bands.map(([a]) => a)) : c.height;
    const ys = [];
    for (let i = 1; i <= 12; i++) {
      const y = Math.floor((footerTop * i) / 13);
      if (y < footerTop) ys.push(y);
    }
    const columnBlank = (x) => ys.every((y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return d[3] === 0 || (d[0] < 24 && d[1] < 24 && d[2] < 24);
    });
    // Walk in from the right edge to find where painted content stops.
    let blankFromRight = 0;
    for (let x = c.width - 1; x >= 0; x--) {
      if (!columnBlank(x)) break;
      blankFromRight += 1;
    }

    document.title = 'RESULT ' + JSON.stringify({
      width: c.width, height: c.height,
      bands: bands.map(([a, b]) => ({ top: a, bottom: b, height: b - a + 1 })),
      touchesBottom: bands.some(([, b]) => b === c.height - 1),
      blankColumnFromRight: blankFromRight,
      paintedWidth: c.width - blankFromRight,
    });
  };
  img.src = '/image?file=' + encodeURIComponent(name);
</script></body></html>`;

/**
 * CHECK A10's inspector. Two colours, both unique to the fixture:
 * the drawer (#c2185b) must be absent, the fixed header (#123a6b) must be
 * present exactly once. Header presence is reduced to BANDS — contiguous runs
 * of rows carrying header colour — because on the segmented path a header
 * left position:fixed repeats once per segment, and a count alone cannot see
 * that. One band = painted once.
 */
const DRAWER_INSPECT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>inspecting</title></head>
<body><script>
  const name = new URLSearchParams(location.search).get('file');
  const drawer = { r: ${DRAWER_RGB.r}, g: ${DRAWER_RGB.g}, b: ${DRAWER_RGB.b} };
  const header = { r: 18, g: 58, b: 107 };
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const near = (d, t) => Math.abs(d[0] - t.r) < 40 && Math.abs(d[1] - t.g) < 40 &&
      Math.abs(d[2] - t.b) < 40;
    let drawerPixels = 0, x0 = Infinity, x1 = -1, headerPixels = 0;
    const bands = [];
    let bandStart = -1;
    for (let y = 0; y < c.height; y += 4) {
      let headerRow = 0;
      for (let x = 0; x < c.width; x += 4) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (near(d, drawer)) { drawerPixels++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
        if (near(d, header)) { headerPixels++; headerRow++; }
      }
      // Absolute, not a fraction of image width: a leak widens the image,
      // which would push a perfectly good header below a percentage bar.
      const isHeaderRow = headerRow * 4 >= 200;
      if (isHeaderRow && bandStart < 0) bandStart = y;
      else if (!isHeaderRow && bandStart >= 0) { bands.push({ top: bandStart, bottom: y - 4 }); bandStart = -1; }
    }
    if (bandStart >= 0) bands.push({ top: bandStart, bottom: c.height - 1 });
    document.title = 'RESULT ' + JSON.stringify({
      width: c.width, height: c.height,
      drawerPixels: drawerPixels,
      drawerX: drawerPixels ? { from: x0, to: x1 } : null,
      headerPixels: headerPixels,
      headerBands: bands,
    });
  };
  img.src = '/image?file=' + encodeURIComponent(name);
</script></body></html>`;

/**
 * CHECK A11's inspector. A10's asks two fixed questions; A11 has to ask about
 * six colours across three fixtures - a drawer, its three children, and three
 * lazy sections - so the list comes in on the query string.
 *
 * Same 40-per-channel tolerance and same every-fourth-pixel sampling stride as
 * A10, so a count printed here means the same thing as a count printed there.
 * The whole bitmap is pulled once rather than a getImageData per pixel: at
 * these image sizes the per-pixel form takes minutes.
 */
const COLOUR_INSPECT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>inspecting</title></head>
<body><script>
  const q = new URLSearchParams(location.search);
  const targets = JSON.parse(q.get('colours'));
  const img = new Image();
  img.onerror = () => { document.title = 'RESULT ' + JSON.stringify({ error: 'decode failed' }); };
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const out = targets.map((t) => ({ name: t.name, pixels: 0, from: Infinity, to: -1 }));
    for (let y = 0; y < c.height; y += 4) {
      for (let x = 0; x < c.width; x += 4) {
        const i = (y * c.width + x) * 4;
        for (let k = 0; k < targets.length; k++) {
          const t = targets[k];
          if (Math.abs(data[i] - t.r) < 40 && Math.abs(data[i + 1] - t.g) < 40 &&
              Math.abs(data[i + 2] - t.b) < 40) {
            out[k].pixels++;
            if (x < out[k].from) out[k].from = x;
            if (x > out[k].to) out[k].to = x;
          }
        }
      }
    }
    document.title = 'RESULT ' + JSON.stringify({
      width: c.width, height: c.height,
      colours: out.map((o) => ({
        name: o.name, pixels: o.pixels, x: o.pixels ? { from: o.from, to: o.to } : null,
      })),
    });
  };
  img.src = '/image?file=' + encodeURIComponent(q.get('file'));
</script></body></html>`;

function startHttp() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/image') {
      // Served straight out of the folder the capture landed in, so the
      // inspector decodes the very bytes that were written to disk.
      const file = `${captureDir()}/${url.searchParams.get('file')}`;
      if (!existsSync(file)) {
        res.writeHead(404).end('no such capture');
        return;
      }
      const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type });
      res.end(readFileSync(file));
      return;
    }
    // CHECK A10's fixture: studio's shape, served from the same origin as
    // every other page here so one browser session covers the whole suite.
    if (url.pathname === '/drawer') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(drawerFixture(url.searchParams.get('v') ?? 'S studio-fixed-offcanvas', {
        reportsResult: true,
        manual: url.searchParams.get('manual') === '1',
      }));
      return;
    }
    // CHECK A19: a first-party request that fails, per version of the page.
    if (url.pathname.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('missing');
      return;
    }
    // CHECK A13's decoy: the page the person is "looking at" in another window.
    if (url.pathname === '/decoy') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>DECOY</title><body style="margin:0;background:#c62828;height:100vh">decoy</body>');
      return;
    }
    if (url.pathname === '/inspect') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INSPECT_PAGE);
      return;
    }
    if (url.pathname === '/inspect-drawer') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DRAWER_INSPECT_PAGE);
      return;
    }
    if (url.pathname === '/inspect-colours') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(COLOUR_INSPECT_PAGE);
      return;
    }
    const wide = Number(url.searchParams.get('wide') ?? 0);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      TRIGGER_PAGE.replace('__TALL__', url.searchParams.has('tall') ? tallBlock() : '').replace(
        '__WIDE__',
        wide > 0 ? wideBlock(wide) : '',
      ),
    );
  });
  server.listen(HTTP_PORT, '127.0.0.1');
  return server;
}

/**
 * Where the captures actually landed.
 *
 * The write seam routes to the chosen folder when its permission is live and
 * to Downloads otherwise, and the macOS folder-picker automation in CHECK 1 is
 * not reliable enough to assume the first. These checks are about the report
 * and the image, not about which directory won, so they follow the files —
 * and print which directory that was.
 */
function captureDir() {
  const candidates = [OUTPUT_DIR, `${DOWNLOADS}/${'capture-kit'}`];
  let best = null;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const mtime = statSync(`${dir}/${name}`).mtimeMs;
      if (!best || mtime > best.mtime) best = { dir, mtime };
    }
  }
  return best?.dir ?? OUTPUT_DIR;
}

/** Newest capture file matching a suffix, in whichever directory got written. */
function newestFile(suffix) {
  const dir = captureDir();
  const entries = readdirSync(dir)
    .filter((n) => !n.startsWith('.') && n.endsWith(suffix) && !n.startsWith('latest.'))
    .map((n) => ({ name: n, mtime: statSync(`${dir}/${n}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.name ?? null;
}

function readCapture(name) {
  return readFileSync(`${captureDir()}/${name}`, 'utf8');
}

/** The context block: the H1 plus the metadata block that immediately follows. */
function contextBlockOf(markdownFile) {
  if (!markdownFile) return '(no report file was written — reporting as a failure)';
  const blocks = readCapture(markdownFile).split('\n\n');
  return `${blocks[0]}\n\n${blocks[1]}`;
}

async function setSetting(session, patch) {
  return session.eval(
    `(async () => {
       await chrome.storage.sync.set(${JSON.stringify(patch)});
       return await chrome.storage.sync.get(${JSON.stringify(Object.keys(patch))});
     })()`,
  );
}

function seedProfile() {
  mkdirSync(`${PROFILE}/Default`, { recursive: true });
  const prefs = `${PROFILE}/Default/Preferences`;
  if (!existsSync(prefs)) {
    // Keeps every fallback download out of the real ~/Downloads.
    writeFileSync(prefs, JSON.stringify({ download: { default_directory: DOWNLOADS } }));
  }
}

/**
 * Headless by default. A full run opens dozens of tabs across two browser
 * sessions, and headed that means dozens of windows stealing the screen for
 * several minutes. `--headless=new` is the real browser — it loads unpacked
 * extensions, runs service workers, and speaks full CDP — so nothing about the
 * checks changes. Pass --headed to watch a run, or to exercise the one check
 * that needs a native dialog (see CHECK 1).
 */
const HEADED = process.argv.includes('--headed');

/**
 * Kill every Chrome still holding this harness's scratch profile.
 *
 * child.kill('SIGTERM') on the spawned launcher does NOT take the browser with
 * it: Chrome's browser process and its helpers survive, keep the debugging
 * port, and keep the profile open. Measured 2026-08-23 — 186 orphaned browsers
 * had accumulated across runs, all sharing /tmp/ck-accept-profile and one
 * downloads directory. They fought over both: files written by one instance
 * were cleaned up by another (this is what made README.txt appear and then
 * vanish), a stale instance answered on the debugging port and served a dead
 * options page, and every one of them had a visible window.
 *
 * Matched on the profile path, so it can only ever hit this harness's own
 * browsers and never a real Chrome.
 */
function killStrays() {
  try {
    execFileSync('/usr/bin/pkill', ['-f', PROFILE], { stdio: 'ignore' });
  } catch {
    // pkill exits 1 when nothing matched, which is the normal case.
  }
}

function launch(dist = DIST) {
  // Never share the profile with a survivor of an earlier run.
  killStrays();
  seedProfile();
  mkdirSync(DOWNLOADS, { recursive: true });
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${dist}`,
      `--disable-extensions-except=${dist}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      ...(HEADED ? [] : ['--headless=new']),
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return child;
}

// --- CHECK A11's disable mechanism --------------------------------------
//
// A check that only ever reports zero proves nothing. A11 therefore runs once
// against a build with the subtree veto deliberately no-opped, and the leak has
// to come back.
//
// The no-op is a textual substitution on a COPY of the built bundle, and the
// beacon it injects announces itself from the page the way `unstickNeutered`
// does in scripts/capture-fixture.mjs. Neither string exists in src, so
// neither can reach a shipped dist - which is a claim the PR body checks with
// `find dist -name '*.js' | xargs grep -l`.
const NEUTER_BEACON = '__ckRevealVetoNeutered';
const VETO_SOURCE_LINE = 'if (declaredClosed(el)) continue;';
const NEUTERED_DIST = '/tmp/ck-a11-neutered-dist';

/**
 * Copy dist, disable the closed-marker veto inside FORCE_REVEAL_SCRIPT, and
 * have the neutered script set the beacon on the page it runs in. The
 * substitution target has to appear exactly once, or the copy is not the thing
 * this check thinks it is.
 */
function neuterDist() {
  rmSync(NEUTERED_DIST, { recursive: true, force: true });
  cpSync(DIST, NEUTERED_DIST, { recursive: true });
  const worker = `${NEUTERED_DIST}/background/service-worker.js`;
  const before = readFileSync(worker, 'utf8');
  const hits = before.split(VETO_SOURCE_LINE).length - 1;
  if (hits !== 1) {
    throw new Error(
      `A11 disable mechanism found ${hits} copies of the veto line in the bundle, expected 1`,
    );
  }
  writeFileSync(
    worker,
    before.replace(
      VETO_SOURCE_LINE,
      `window.${NEUTER_BEACON} = true; if (false && declaredClosed(el)) continue;`,
    ),
  );
  return NEUTERED_DIST;
}

// --- CHECK A12's disable mechanism --------------------------------------
//
// Same shape as A11's above, aimed at leak 1. The fix is the absence of an
// `overflow` declaration from the ancestor rule in the stylesheet
// innerScrollPage injects, so the way to disable it is to put that declaration
// back. The substitution puts `overflow:visible !important` into the ancestor
// rule, which is exactly the pre-fix stylesheet, and has the same edit announce
// itself from the page.
//
// The beacon is an attribute on <html>, not a window property, because
// innerScrollPage runs in an isolated world (see captureVariant). The literal
// exists nowhere in src, so no shipped dist can contain it - checked in the PR
// body with `find dist -name '*.js' | xargs grep -l`.
const A12_BEACON = '__ckAncestorUnclipRestored';
// The invariant part of the ancestor rule, so a variable rename by the bundler
// cannot move the target.
const UNCLIP_SOURCE_LINE = '="ancestor"]{height:auto !important;max-height:none !important;}';
const UNCLIPPED_DIST = '/tmp/ck-a12-unclipped-dist';

/**
 * Copy dist, put `overflow:visible` back on the ancestor rule, and have the
 * restored stylesheet stamp the beacon on <html> as it is built. The stamp
 * rides in as a template-literal interpolation that evaluates to the empty
 * string, so the CSS text it produces is byte-for-byte the pre-fix rule.
 */
function restoreAncestorUnclip() {
  rmSync(UNCLIPPED_DIST, { recursive: true, force: true });
  cpSync(DIST, UNCLIPPED_DIST, { recursive: true });
  const worker = `${UNCLIPPED_DIST}/background/service-worker.js`;
  const before = readFileSync(worker, 'utf8');
  const hits = before.split(UNCLIP_SOURCE_LINE).length - 1;
  if (hits !== 1) {
    throw new Error(
      `A12 disable mechanism found ${hits} copies of the ancestor rule in the bundle, expected 1`,
    );
  }
  writeFileSync(
    worker,
    before.replace(
      UNCLIP_SOURCE_LINE,
      '="ancestor"]{height:auto !important;max-height:none !important;' +
        'overflow:visible !important;}' +
        '${(document.documentElement.setAttribute("' +
        A12_BEACON +
        '","1"), "")}',
    ),
  );
  return UNCLIPPED_DIST;
}

/**
 * FORCE_REVEAL_SCRIPT lifted out of src byte-for-byte, the same way
 * scripts/probe-reveal.mjs lifts it, so the reveal-forced identity check
 * compares the report against the real script rather than a retyped copy.
 */
const FORCE_REVEAL_SCRIPT_SRC = (() => {
  const src = readFileSync(`${ROOT}/src/lib/capture-engine/cdp-fullpage.ts`, 'utf8');
  const open = src.indexOf('const FORCE_REVEAL_SCRIPT = `');
  if (open < 0) throw new Error('could not find FORCE_REVEAL_SCRIPT in cdp-fullpage.ts');
  const start = src.indexOf('`', open) + 1;
  const end = src.indexOf('`', start);
  const body = src.slice(start, end);
  if (body.includes('${')) throw new Error('FORCE_REVEAL_SCRIPT interpolates; extraction is unsafe');
  // The slice is SOURCE text, not the runtime string: a `\\s` in the source is
  // a `\s` once TypeScript has evaluated the template literal, and evaluating
  // the raw slice instead would compile a regex that matches a literal
  // backslash. Re-evaluating it as a template literal - safe, since it
  // interpolates nothing - reproduces exactly the string the extension sends.
  return new Function('return `' + body + '`')();
})();

// Whatever ends this script — success, a thrown check, Ctrl-C — the browser
// goes with it. Without this, a failed run silently leaves a browser behind
// and poisons the next one.
process.on('exit', killStrays);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killStrays();
    process.exit(1);
  });
}

/**
 * Headless Chrome defaults to denying downloads, and the profile's
 * download.default_directory is not enough on its own. Browser.setDownloadBehavior
 * on the browser-level target arms them for the whole session, which is what
 * makes the write-seam checks meaningful headless rather than vacuous.
 */
async function armDownloads() {
  if (HEADED) return 'headed — profile preference is enough';
  const version = await cdp('/json/version');
  const browser = new Session(version.webSocketDebuggerUrl);
  await browser.open();
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });
  browser.close();
  return `allowed → ${DOWNLOADS}`;
}

async function waitForPort() {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const v = await cdp('/json/version');
      if (v.Browser) return v.Browser;
    } catch {
      /* not up */
    }
  }
  throw new Error('no debugging port');
}

/** Opens a tab and returns its target record, without attaching to it. */
async function openTab(url) {
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  await sleep(1200);
  return (await cdp('/json/list')).find((t) => t.url.startsWith(url.split('?')[0]));
}

async function attach(url) {
  const target = (await cdp('/json/list')).find((t) => t.url === url);
  const session = new Session(target.webSocketDebuggerUrl);
  await session.open();
  await session.send('Runtime.enable');
  return session;
}

/** Poll the capture page's title — the completion event, with no debugger. */
async function waitForResult(targetId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = (await cdp('/json/list')).find((t) => t.id === targetId);
    // /json/list HTML-escapes titles, so the JSON comes back with &quot;.
    if (target?.title?.startsWith('RESULT ')) {
      const raw = target.title
        .slice(7)
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");
      return JSON.parse(raw);
    }
    await sleep(500);
  }
  return { ok: false, error: 'timed out waiting for capture-kit:capture-complete' };
}

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .sort()
    .map((n) => `${n}  ${statSync(`${dir}/${n}`).size}B`);
}

function answerFolderDialog(pid, dir) {
  osa(`tell application "System Events" to tell (first process whose unix id is ${pid}) to set frontmost to true`);
  for (let i = 0; i < 40; i++) {
    const sheets = osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
      set n to 0
      repeat with w in windows
        try
          set n to n + (count of sheets of w)
        end try
      end repeat
      return n as text
    end tell`);
    if (Number(sheets) > 0) break;
    execFileSync('/bin/sleep', ['0.5']);
  }
  osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
    set frontmost to true
    delay 0.5
    keystroke "g" using {command down, shift down}
    delay 1.5
    keystroke "${dir}"
    delay 1.5
    keystroke return
    delay 1.5
    keystroke return
  end tell`);
}

function heading(text) {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

// ------------------------------------------------------------------ run --

if (process.argv.includes('--fresh')) {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  rmSync(DOWNLOADS, { recursive: true, force: true });
}
mkdirSync(OUTPUT_DIR, { recursive: true });

const http = startHttp();

heading('SETUP');
let chrome = launch();
console.log(`chrome: ${await waitForPort()}`);
console.log(`mode: ${HEADED ? 'headed (--headed)' : 'headless (--headless=new)'}`);
console.log(`downloads: ${await armDownloads()}`);
const computedId = extensionId();
const id = await discoverExtensionId(computedId);
const optionsUrl = `chrome-extension://${id}/options/options.html`;
console.log(`extension id: ${id}${id === computedId ? '' : ` (path hash predicted ${computedId})`}`);
console.log(`dist: ${DIST}`);
console.log(`output folder: ${OUTPUT_DIR}`);
console.log(`downloads redirected to: ${DOWNLOADS}`);

// --- check 1: choose the folder, capture, files land there --------------
heading('CHECK 1 — chosen folder receives the capture, Downloads gains nothing');
await openTab(optionsUrl);
let options = await attach(optionsUrl);
// The in-page trigger ships off, and every capture below is fired by a page,
// so the harness turns it on explicitly rather than depending on a default.
console.log(
  'enable in-page trigger: ' +
    JSON.stringify(
      await options.eval(
        `(async () => {
           await chrome.storage.sync.set({ pageTriggerMode: 'any' });
           return (await chrome.storage.sync.get('pageTriggerMode')).pageTriggerMode;
         })()`,
      ),
    ),
);
// The only step in the whole suite that cannot run headless: showDirectoryPicker
// opens a macOS native folder dialog, and the answer is typed into it with
// System Events. Headless Chrome has no window for System Events to address
// and never renders the dialog, so there is nothing to answer — the picker
// would hang until the eval timed out. It is skipped rather than faked, and
// the chosen-folder path is then exercised only under --headed.
if (HEADED) {
  // The options page's own button, so what ships is what gets tested.
  const clicking = options.eval(
    `(async () => {
       document.getElementById('output-dir-choose').click();
       await new Promise(r => setTimeout(r, 6000));
       return {
         name: document.getElementById('output-dir-name').textContent,
         note: document.getElementById('output-dir-note').textContent,
         status: document.getElementById('status').textContent,
       };
     })()`,
    true,
  );
  await sleep(1500);
  answerFolderDialog(chrome.pid, OUTPUT_DIR);
  await sleep(3000);
  console.log('options row after Choose: ' + JSON.stringify(await clicking));
} else {
  console.log(
    'SKIPPED (headless): choosing an output folder needs a native macOS dialog. ' +
      'Re-run with --headed to exercise the chosen-folder path. Every capture below ' +
      'therefore takes the Downloads fallback, which is the path the write seam is ' +
      'meant to fall back to — the checks that follow do not depend on which one won.',
  );
}
options.close();

let page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=1`);
let detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));
console.log(`\n${DOWNLOADS} (must stay empty):`);
console.log(listDir(DOWNLOADS).join('\n') || '(empty)');
console.log(`\n${DOWNLOADS}/capture-kit after the first capture:`);
console.log(listDir(`${DOWNLOADS}/capture-kit`).join('\n') || '(empty)');

// --- check 5: second capture uniquifies ---------------------------------
heading('CHECK 5 — a second capture of the same page gets a " (1)" suffix');
const before = listDir(OUTPUT_DIR);
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=2`);
detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));
console.log(
  '\nnew entries: ' +
    JSON.stringify(listDir(OUTPUT_DIR).filter((f) => !before.includes(f))),
);

// --- check 3 is the mechanism used above; state it explicitly -----------
heading('CHECK 3 — the in-page trigger is what fired every capture above');
console.log('trigger: document.dispatchEvent(new CustomEvent("capture-kit:capture"))');
console.log('last completion detail: ' + JSON.stringify(detail));

// --- check 2: full restart ----------------------------------------------
heading('CHECK 2 — quit Chrome fully, relaunch, capture without opening Settings');
chrome.kill('SIGTERM');
killStrays();
await sleep(4000);
chrome = launch();
console.log(`chrome restarted: ${await waitForPort()}`);
// A new browser session needs downloads armed again.
console.log(`downloads: ${await armDownloads()}`);
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=3`);
detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));
console.log(`\n${DOWNLOADS}/capture-kit:`);
console.log(listDir(`${DOWNLOADS}/capture-kit`).join('\n') || '(empty)');

// --- check 4: the fallback notice and the one-click reconnect -----------
heading('CHECK 4 — lapsed permission: capture still succeeds, result tab says so');
const resultTab = (await cdp('/json/list')).find((t) => t.url.includes('/result/result.html'));
if (resultTab) {
  const result = new Session(resultTab.webSocketDebuggerUrl);
  await result.open();
  await result.send('Runtime.enable');
  console.log(
    'output chip: ' +
      JSON.stringify(
        await result.eval(
          `[...document.querySelectorAll('#meta .chip, #meta > *')].map(e => e.textContent.trim()).filter(t => t.startsWith('Output'))[0] ?? null`,
        ),
      ),
  );
  console.log(
    'warning band: ' +
      JSON.stringify(
        await result.eval(`document.querySelector('#warnings .warn-band')?.textContent.trim() ?? null`),
      ),
  );
  console.log(
    'reconnect click → ' +
      JSON.stringify(
        await result.eval(
          `(async () => {
             const b = [...document.querySelectorAll('#warnings button')].find(b => /Reconnect/.test(b.textContent));
             if (!b) return 'no reconnect button';
             b.click();
             await new Promise(r => setTimeout(r, 1500));
             return b.textContent;
           })()`,
          true,
        ),
      ),
  );
  result.close();
} else {
  console.log('no result tab found');
}

heading('CHECK 4b — after reconnecting, the next capture goes to the chosen folder again');
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=4`);
detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));

// ======================================================================
// This round: one-click capture, context block, URL stamp, copy naming.
// ======================================================================

await openTab(optionsUrl);
options = await attach(optionsUrl);

// If the options page did not really load, every chrome.* eval below returns
// "undefined" and the checks quietly report nonsense. Fail loudly instead.
{
  const alive = await options.eval(`typeof chrome !== 'undefined' && !!chrome.storage`);
  console.log(`options page has extension APIs: ${JSON.stringify(alive)}`);
  if (alive !== true) {
    console.log(`ABORT — ${optionsUrl} did not load. Extension id derivation or dist path is wrong.`);
    chrome.kill('SIGTERM');
killStrays();
    http.close();
    process.exit(1);
  }
}

// --- A13: a page-fired capture photographs the page that asked ---------
//
// The in-page trigger used to capture "the active tab of the last-focused
// window". When the asking page sat in a window the person was not using,
// the capture photographed the person's own tab instead - on a real machine
// that was an open dialog showing a client secret. The fixture waits in
// window A; a decoy opens in a new, focused window B; then the fixture fires.
// The report must name the fixture, never the decoy.
async function tabTargetingCheck(label) {
  await setSetting(options, { pageTriggerMode: 'any' });
  const fixtureUrl =
    `http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent('S studio-fixed-offcanvas')}&manual=1`;
  const decoyUrl = `http://127.0.0.1:${HTTP_PORT}/decoy`;
  const t = await openExact(fixtureUrl);
  if (!t) return { label, verdict: 'FAIL', why: 'fixture tab never appeared' };
  const browser = new Session((await cdp('/json/version')).webSocketDebuggerUrl);
  await browser.open();
  const { targetId: decoyId } = await browser.send('Target.createTarget', {
    url: decoyUrl,
    newWindow: true,
  });
  await sleep(1500);
  const wA = (await browser.send('Browser.getWindowForTarget', { targetId: t.id })).windowId;
  const wB = (await browser.send('Browser.getWindowForTarget', { targetId: decoyId })).windowId;
  // What the extension itself would call "the active tab" right now.
  const focusedUrl = await options.eval(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.url ?? null)`,
  );
  const before = newestFile('.md');
  const live = new Session(t.webSocketDebuggerUrl);
  await live.open();
  await live.send('Runtime.enable');
  await live.eval('window.__ckFire()');
  live.close();
  const detail = await waitForResult(t.id, 90000);
  await sleep(1500);
  const report = newestFile('.md');
  const reportUrl =
    report && report !== before ? (/^- \*\*URL:\*\* (.+)$/m.exec(readCapture(report))?.[1] ?? null) : null;
  await cdp(`/json/close/${decoyId}`);
  await cdp(`/json/close/${t.id}`);
  browser.close();
  console.log(`[${label}] fixture window ${wA}, decoy window ${wB}`);
  console.log(`[${label}] extension's active tab before firing: ${focusedUrl}`);
  console.log(`[${label}] capture-kit:capture-complete → ${JSON.stringify(detail)}`);
  console.log(`[${label}] report URL: ${reportUrl}`);
  const preconditionHeld = wA !== wB && focusedUrl === decoyUrl;
  const target = reportUrl === fixtureUrl ? 'fixture' : reportUrl === decoyUrl ? 'decoy' : 'neither';
  return { label, preconditionHeld, target };
}

// --- A14: the panel window captures the tab it was opened for (NOBC-167) --
//
// When the popup cannot open, Capture Kit opens it as its own small window.
// "The active tab of the last-focused window" is then the panel itself, so
// every button aimed at the panel. The fixture waits in window A; a panel
// opened for window A takes focus in its own window; its Capture button must
// capture the fixture.
async function panelTargetingCheck(label) {
  await setSetting(options, { pageTriggerMode: 'any' });
  const fixtureUrl =
    `http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent('S studio-fixed-offcanvas')}&manual=1&panel=1`;
  const t = await openExact(fixtureUrl);
  if (!t) return { label, verdict: 'FAIL', why: 'fixture tab never appeared' };
  await sleep(800);
  const origin = await options.eval('location.origin');
  const windowId = await options.eval(
    `chrome.tabs.query({}).then((ts) => ts.find((x) => x.url === ${JSON.stringify(fixtureUrl)})?.windowId ?? null)`,
  );
  const panelUrl = `${origin}/popup/popup.html?window=${windowId}`;
  const browser = new Session((await cdp('/json/version')).webSocketDebuggerUrl);
  await browser.open();
  const { targetId: panelId } = await browser.send('Target.createTarget', { url: panelUrl, newWindow: true });
  await sleep(1500);
  // The guess the old code made. Extension pages hide their own URL from
  // tabs.query without the tabs permission, so the window id is compared.
  const focusedWindow = await options.eval(
    `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.windowId ?? null)`,
  );
  const panelTarget = (await cdp('/json/list')).find((x) => x.id === panelId);
  const panel = new Session(panelTarget.webSocketDebuggerUrl);
  await panel.open();
  await panel.send('Runtime.enable');
  const before = newestFile('.md');
  await panel.eval(`document.getElementById('capture-bundle').click()`, true);
  let status = '';
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    status = await panel.eval(`document.getElementById('status')?.textContent ?? ''`);
    if (/^Saved|could|can|not|fail|error/i.test(status) && status !== 'Capturing…') break;
  }
  await sleep(1500);
  const report = newestFile('.md');
  const reportUrl =
    report && report !== before ? (/^- \*\*URL:\*\* (.+)$/m.exec(readCapture(report))?.[1] ?? null) : null;
  panel.close();
  await cdp(`/json/close/${panelId}`);
  await cdp(`/json/close/${t.id}`);
  browser.close();
  console.log(`[${label}] fixture in window ${windowId}; panel ${panelUrl}`);
  console.log(`[${label}] last-focused window with the panel open: ${focusedWindow} (fixture's: ${windowId})`);
  console.log(`[${label}] panel status: ${JSON.stringify(status)}`);
  console.log(`[${label}] report URL: ${reportUrl}`);
  const preconditionHeld = focusedWindow !== null && focusedWindow !== windowId;
  const target = reportUrl === fixtureUrl ? 'fixture' : reportUrl ? 'other' : 'nothing';
  return { label, preconditionHeld, target, status };
}

function a14Verdict(r) {
  return !r.preconditionHeld
    ? 'INCONCLUSIVE — the fixture\'s window was still the last-focused one, so the old guess would have worked'
    : r.target === 'fixture'
      ? 'PASS — the panel captured the tab it was opened for'
      : `FAIL — panel captured ${r.target} (status: ${r.status})`;
}

// --- CHECK A15: hidden layers stay hidden (status.sentry.io) -------------
// Variant K: a reCAPTCHA-shaped challenge parked at top:-10000px holding a
// fixed full-viewport overlay, a fixed hidden badge half past the right
// edge, and an icon hidden with class="hidden" - plus an opacity:0 section
// below the fold that must still be revealed. Before the fix the overlay
// washed out the first screen, the badge widened the image, and the icon
// painted. Uses captureVariant/inspectColours below (function declarations,
// hoisted).
const K_VARIANT = 'K parked-hidden-layers';
const K_COLOURS = Object.entries(K_RGB).map(([name, c]) => ({ name, r: c.r, g: c.g, b: c.b }));
async function hiddenLayersCheck() {
  const run = await captureVariant(K_VARIANT, K_COLOURS);
  const by = Object.fromEntries((run.px?.colours ?? []).map((c) => [c.name, c.pixels]));
  // The viewport the capture itself reports, not the fixture's nominal one:
  // the suite's window is narrower than 1440.
  const vwLine = /Viewport:\*\*\s*(\d+)/.exec((run.modeLine ?? []).join(' '));
  const vw = vwLine ? Number(vwLine[1]) : viewportFor(K_VARIANT).width;
  const leaks = ['overlay', 'badge', 'icon'].filter((k) => (by[k] ?? 0) > 50);
  const widened = (run.px?.width ?? 0) > vw;
  const lazyShown = (by.lazy ?? 0) > 200;
  return { run, by, vw, leaks, widened, lazyShown };
}
function a15Verdict(r) {
  if (r.run.error || r.run.px?.error) return `INCONCLUSIVE — ${r.run.error ?? r.run.px.error}`;
  const problems = [];
  if (r.leaks.length) problems.push(`hidden layers painted: ${r.leaks.map((k) => `${k} ${r.by[k]} px`).join(', ')}`);
  if (r.widened) problems.push(`image widened to ${r.run.px.width}px past the ${r.vw}px viewport`);
  if (!r.lazyShown) problems.push(`the lazy section was NOT revealed (${r.by.lazy ?? 0} px) - over-corrected`);
  return problems.length
    ? `FAIL — ${problems.join('; ')}`
    : `PASS — no hidden layer painted, width ${r.run.px.width}px, lazy section revealed (${r.by.lazy} px)`;
}

// --- CHECK A19: before/after -----------------------------------------------
// Capture #v1, then #v2 of the same page (same page key). The second report
// must compare against the first: one changed area with an outlined copy
// written, E2 new and E1 gone, /missing-v2 new and /missing-v1 gone. The
// first report must have no comparison (a first capture has nothing to
// compare against).
const Z_VARIANT = 'Z before-after';
async function beforeAfterCheck() {
  await setSetting(options, { compareWithPrevious: true, openResult: false, autoCopyImage: false, stampUrlOnImage: false });
  const base = `http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent(Z_VARIANT)}&manual=1&n=${Date.now()}`;
  const t = await openExact(`${base}#v1`);
  if (!t) return { error: 'fixture tab never appeared' };
  await sleep(1500);
  const tabId = await options.eval(
    `chrome.tabs.query({}).then((ts) => ts.find((x) => (x.url ?? '').startsWith(${JSON.stringify(base)}))?.id ?? null)`,
  );
  const capture = async () => {
    await options.eval(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
    await sleep(300);
    const r = await options.eval(`chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE', tabId: ${tabId} })`);
    await sleep(1500);
    return { r, report: newestFile('.md') };
  };
  // The fixture picks its version from the hash at load: change the hash, let
  // that land, reload, and wait for the load to finish - a reload sent on the
  // heels of the hash change could reload the old version.
  const goto = async (hash) => {
    await options.eval(`chrome.tabs.update(${tabId}, { url: ${JSON.stringify(base)} + ${JSON.stringify(hash)} }).then(() => true)`);
    await sleep(600);
    await options.eval(`chrome.tabs.reload(${tabId}).then(() => true)`);
    await sleep(400);
    for (let i = 0; i < 40; i++) {
      const tab = await options.eval(`chrome.tabs.get(${tabId}).then((x) => ({ status: x.status, url: x.url }))`);
      if (tab.status === 'complete' && tab.url.endsWith(hash)) break;
      await sleep(250);
    }
    await sleep(1200);
  };
  const first = await capture();
  const firstText = first.report ? readCapture(first.report) : '';
  await goto('#v2');
  const second = await capture();
  const text = second.report ? readCapture(second.report) : '';
  const changesFile = /outlined in (\S+_changes\.png)/.exec(text)?.[1] ?? null;
  // A session of the same page, back at #v1: its mirror copy (latest-session/
  // 01.md) must carry the comparison and its own 01_changes.png.
  await goto('#v1');
  const session = await options.eval(`chrome.runtime.sendMessage({ type: 'SESSION_START', tabIds: [${tabId}], reload: false })`);
  await sleep(2500);
  const mirrorDir = [OUTPUT_DIR, `${DOWNLOADS}/capture-kit`, DOWNLOADS]
    .map((d) => `${d}/latest-session`)
    .find((d) => existsSync(`${d}/01.md`));
  const mirrorText = mirrorDir ? readFileSync(`${mirrorDir}/01.md`, 'utf8') : '';
  await cdp(`/json/close/${t.id}`);
  // Turned off the way a synced Chrome turns it off - straight in storage,
  // not through the settings page - the kept copies must go.
  const countKept = `new Promise((resolve) => {
    const req = indexedDB.open('capture-kit-compare');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) { db.close(); return resolve(0); }
      const c = db.transaction('pages', 'readonly').objectStore('pages').count();
      c.onsuccess = () => { db.close(); resolve(c.result); };
      c.onerror = () => { db.close(); resolve(-1); };
    };
    req.onerror = () => resolve(-1);
  })`;
  const keptBefore = await options.eval(countKept);
  await options.eval(`chrome.storage.sync.set({ compareWithPrevious: false }).then(() => true)`);
  await sleep(800);
  const keptAfter = await options.eval(countKept);
  // The settings page open meanwhile shows the change, so a later save there cannot undo it.
  const boxAfterOff = await options.eval(`document.getElementById('compare-previous')?.checked ?? null`);
  await options.eval(`chrome.storage.sync.set({ compareWithPrevious: true }).then(() => true)`);
  return {
    firstOk: first.r?.ok === true,
    secondOk: second.r?.ok === true,
    firstHasSection: firstText.includes('## Changes since the last capture'),
    section: text.split('## Changes since the last capture of this page')[1]?.split('\n## ')[0] ?? null,
    changesFile,
    changesFileExists: changesFile ? existsSync(`${captureDir()}/${changesFile}`) : false,
    sessionOk: session?.ok !== false,
    keptBefore,
    keptAfter,
    boxAfterOff,
    mirrorFound: Boolean(mirrorDir),
    mirrorHasSection: mirrorText.includes('## Changes since the last capture'),
    mirrorOutlined: /outlined in 01_changes\.png/.test(mirrorText) && Boolean(mirrorDir && existsSync(`${mirrorDir}/01_changes.png`)),
  };
}
function a19Verdict(r) {
  if (r.error) return `INCONCLUSIVE — ${r.error}`;
  const problems = [];
  if (!r.firstOk || !r.secondOk) problems.push('a capture failed');
  if (r.firstHasSection) problems.push('the first capture of the page already had a comparison');
  const s = r.section ?? '';
  if (!s) problems.push('the second report has no comparison section');
  if (!/\*\*Picture:\*\* [1-9]\d* areas? changed/.test(s)) problems.push('no changed area reported');
  if (!r.changesFileExists) problems.push('no outlined changes image written');
  if (!/Console errors:\*\* 1 new, 1 gone/.test(s) || !/E2 new problem/.test(s) || !/E1 boot failed/.test(s)) problems.push('console errors not compared right');
  if (!/Failed requests:\*\* 1 new, 1 gone/.test(s) || !/missing-v2/.test(s) || !/missing-v1/.test(s)) problems.push('failed requests not compared right');
  if (r.boxAfterOff !== false) problems.push(`the open settings page still shows comparison on (${r.boxAfterOff})`);
  if (!(r.keptBefore > 0) || r.keptAfter !== 0) problems.push(`turning it off in synced storage did not clear the kept copies (${r.keptBefore} then ${r.keptAfter})`);
  if (!r.mirrorFound) problems.push('the session mirror latest-session/01.md was not found');
  else if (!r.mirrorHasSection) problems.push('the session mirror has no comparison section');
  else if (!r.mirrorOutlined) problems.push('the session mirror does not point at its own 01_changes.png');
  return problems.length ? `FAIL — ${problems.join('; ')}` : `PASS — second report: area outlined in ${r.changesFile}, E2 new / E1 gone, /missing-v2 new / /missing-v1 gone; first report had no comparison; session mirror carries it with 01_changes.png; switched off in synced storage, ${r.keptBefore} kept copies became ${r.keptAfter}`;
}

if (process.argv.includes('--only-before-after')) {
  heading('CHECK A19 — before/after');
  const r = await beforeAfterCheck();
  console.log('result: ' + JSON.stringify(r));
  console.log('VERDICT A19 before/after: ' + a19Verdict(r));
  options.close();
  chrome.kill('SIGTERM');
  killStrays();
  await sleep(2000);
  http.close();
  process.exit(0);
}

// --- CHECK A16: a virtualized list captures whole (Vercel) ---------------
// Variant V: 120 rows drawn only near the viewport, short enough for the
// single-shot path. Rows 1-20 carry one colour, rows 21-120 another. Before
// the fix the image held the rows drawn at load and a blank spacer, so the
// second colour was missing. Five times as many "rest" rows as "top" rows, so
// a whole list shows rest at well over twice top.
const V_VARIANT = 'V virtualized-short';
const V_COLOURS = Object.entries(V_RGB).map(([name, c]) => ({ name, r: c.r, g: c.g, b: c.b }));
async function virtualizedCheck() {
  const run = await captureVariant(V_VARIANT, V_COLOURS);
  const by = Object.fromEntries((run.px?.colours ?? []).map((c) => [c.name, c.pixels]));
  return { run, by };
}
function a16Verdict(r) {
  if (r.run.error || r.run.px?.error) return `INCONCLUSIVE — ${r.run.error ?? r.run.px.error}`;
  const top = r.by.top ?? 0;
  const rest = r.by.rest ?? 0;
  if (top < 200) return `INCONCLUSIVE — the first rows did not paint either (${top} px)`;
  return rest >= 2 * top
    ? `PASS — whole list drawn: rows 21-120 ${rest} px against rows 1-20 ${top} px`
    : `FAIL — list cut off: rows 21-120 ${rest} px against rows 1-20 ${top} px`;
}

if (process.argv.includes('--only-virtualized')) {
  heading('CHECK A16 — a virtualized list captures whole');
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false });
  const own = await virtualizedCheck();
  console.log('pixels: ' + JSON.stringify(own.run.px) + ' mode: ' + JSON.stringify(own.run.modeLine));
  console.log('VERDICT A16 virtualized list: ' + a16Verdict(own));
  if (process.env.CK_COMPARE_DIST) {
    heading('CHECK A16 (falsifiability) — the same fixture on the comparison build');
    console.log(`extension id (comparison build): ${await relaunchWith(process.env.CK_COMPARE_DIST)}`);
    const old = await virtualizedCheck();
    console.log('pixels: ' + JSON.stringify(old.run.px) + ' mode: ' + JSON.stringify(old.run.modeLine));
    const v = a16Verdict(old);
    console.log(
      'VERDICT A16 is falsifiable: ' +
        (v.startsWith('FAIL') ? `PASS — the comparison build cuts the list off (${v})` : `FAIL — ${v}`),
    );
  }
  options.close();
  chrome.kill('SIGTERM');
  killStrays();
  await sleep(2000);
  http.close();
  process.exit(0);
}

if (process.argv.includes('--only-hidden-layers')) {
  heading('CHECK A15 — hidden layers stay hidden, lazy content still revealed');
  console.log(
    'segment size 8192, stamp off: ' +
      JSON.stringify(await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false })),
  );
  const own = await hiddenLayersCheck();
  console.log('pixels: ' + JSON.stringify(own.run.px) + ' mode: ' + JSON.stringify(own.run.modeLine));
  console.log('VERDICT A15 hidden layers: ' + a15Verdict(own));
  if (process.env.CK_COMPARE_DIST) {
    heading('CHECK A15 (falsifiability) — the same fixture on the comparison build');
    console.log(`extension id (comparison build): ${await relaunchWith(process.env.CK_COMPARE_DIST)}`);
    const old = await hiddenLayersCheck();
    console.log('pixels: ' + JSON.stringify(old.run.px));
    console.log(
      'VERDICT A15 is falsifiable: ' +
        (old.leaks.length || old.widened
          ? `PASS — the comparison build leaks (${a15Verdict(old)})`
          : `FAIL — the comparison build did not leak either: ${a15Verdict(old)}`),
    );
  }
  options.close();
  chrome.kill('SIGTERM');
  killStrays();
  await sleep(2000);
  http.close();
  process.exit(0);
}

if (process.argv.includes('--only-a13') || process.argv.includes('--only-tab-targeting')) {
  heading('CHECK A13 — a page-fired capture photographs the page that asked');
  const own = await tabTargetingCheck('this build');
  console.log(
    'VERDICT A13 capture pinned to the asking tab: ' +
      (!own.preconditionHeld
        ? 'INCONCLUSIVE — the decoy window never became the extension\'s active tab'
        : own.target === 'fixture'
          ? 'PASS — the report names the page that fired, not the focused decoy'
          : `FAIL — captured the ${own.target}`),
  );
  heading('CHECK A14 — the panel window captures the tab it was opened for');
  console.log('VERDICT A14 panel pinned to its window: ' + a14Verdict(await panelTargetingCheck('this build')));
  if (process.env.CK_COMPARE_DIST) {
    heading('CHECK A13/A14 (falsifiability) — the same steps on the comparison build');
    console.log(`comparison dist: ${process.env.CK_COMPARE_DIST}`);
    console.log(`extension id (comparison build): ${await relaunchWith(process.env.CK_COMPARE_DIST)}`);
    const old = await tabTargetingCheck('comparison build');
    console.log(
      'VERDICT A13 is falsifiable: ' +
        (old.preconditionHeld && old.target === 'decoy'
          ? 'PASS — the comparison build photographed the focused decoy'
          : `FAIL — comparison build captured the ${old.target}, precondition ${old.preconditionHeld}`),
    );
    const oldPanel = await panelTargetingCheck('comparison build');
    console.log(
      'VERDICT A14 is falsifiable: ' +
        (oldPanel.preconditionHeld && oldPanel.target !== 'fixture'
          ? `PASS — the comparison build's panel captured ${oldPanel.target} (status: ${oldPanel.status})`
          : `FAIL — comparison build's panel captured the ${oldPanel.target}, precondition ${oldPanel.preconditionHeld}`),
    );
  }
  options.close();
  chrome.kill('SIGTERM');
  killStrays();
  await sleep(2000);
  http.close();
  process.exit(0);
}

// --- A1: the toolbar icon's popup follows the setting -------------------
heading('CHECK A1 — one-click mode swaps the action popup, and OFF restores it exactly');
console.log('default (fresh profile): ' + JSON.stringify(await options.eval(
  `chrome.action.getPopup({})`,
)));
console.log('setting round-trip ON:  ' + JSON.stringify(
  await setSetting(options, { iconCapturesImmediately: true }),
));
await sleep(1200);
const popupWhenOn = await options.eval(`chrome.action.getPopup({})`);
console.log('action popup with ON:   ' + JSON.stringify(popupWhenOn));
console.log('setting round-trip OFF: ' + JSON.stringify(
  await setSetting(options, { iconCapturesImmediately: false }),
));
await sleep(1200);
const popupWhenOff = await options.eval(`chrome.action.getPopup({})`);
console.log('action popup with OFF:  ' + JSON.stringify(popupWhenOff));
console.log('ON→OFF→ON in one session: ' + JSON.stringify(await (async () => {
  await setSetting(options, { iconCapturesImmediately: true });
  await sleep(900);
  const on2 = await options.eval(`chrome.action.getPopup({})`);
  await setSetting(options, { iconCapturesImmediately: false });
  await sleep(900);
  const off2 = await options.eval(`chrome.action.getPopup({})`);
  return { secondOn: on2, secondOff: off2 };
})()));
console.log('VERDICT popup empty when ON: ' + (popupWhenOn === ''));
console.log('VERDICT popup restored when OFF: ' + /popup\/popup\.html$/.test(popupWhenOff));
console.log(
  'icon context menu present: ' +
    JSON.stringify(await options.eval(
      `new Promise((r) => { try { chrome.contextMenus.update('capture-kit-open-panel', {}, () =>
         r(chrome.runtime.lastError ? 'missing: ' + chrome.runtime.lastError.message : 'present')); }
         catch (e) { r('threw: ' + e.message); } })`,
    )),
);
console.log('NOTE: the physical toolbar-icon click is ADAM-VERIFY — no automation can press it.');

// --- A2: the context block, local and deployed --------------------------
heading('CHECK A2 (i) — context block for a LOCALHOST page');
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=5`);
detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
let md = newestFile('.md');
console.log(`\n--- ${md} ---`);
console.log(contextBlockOf(md));

heading('CHECK A2 (ii) — context block for a DEPLOYED page');
// The in-page trigger needs our script on the page, which a real site will not
// have. An extension page can message the worker instead, which is the popup's
// own path — so the target tab is activated first and CAPTURE_BUNDLE is sent
// from here. Needs network; a failure is reported, never faked.
const deployedUrl = process.env.CK_DEPLOYED_URL ?? 'https://example.com/';
const deployedTab = await openTab(deployedUrl);
if (!deployedTab) {
  console.log(`FAILED to load ${deployedUrl} — no network? Reporting, not skipping.`);
} else {
  const before = newestFile('.md');
  console.log(
    'activate + CAPTURE_BUNDLE → ' +
      JSON.stringify(
        await options.eval(
          `(async () => {
             const tabs = await chrome.tabs.query({});
             const target = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(deployedUrl)}));
             if (!target) return { ok: false, reason: 'tab not found' };
             await chrome.tabs.update(target.id, { active: true });
             await chrome.windows.update(target.windowId, { focused: true });
             await new Promise(r => setTimeout(r, 600));
             return await chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE' });
           })()`,
        ),
      ),
  );
  await sleep(3000);
  md = newestFile('.md');
  if (md && md !== before) {
    console.log(`\n--- ${md} ---`);
    console.log(contextBlockOf(md));
  } else {
    console.log('no new report was written for the deployed page — reporting as a failure');
  }
}

// --- A3: the URL stamp --------------------------------------------------
heading('CHECK A3 — URL stamp OFF then ON, on a page tall enough to segment');
async function inspect(file) {
  const t = await openTab(`http://127.0.0.1:${HTTP_PORT}/inspect?file=${encodeURIComponent(file)}`);
  return waitForResult(t.id, 30000);
}

async function inspectDrawer(file) {
  const t = await openTab(
    `http://127.0.0.1:${HTTP_PORT}/inspect-drawer?file=${encodeURIComponent(file)}`,
  );
  return waitForResult(t.id, 30000);
}

// A small segment size forces the segmented path on an ordinary page, which is
// the case the "never mid-image" requirement is really about.
console.log('force segmentation: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 1024, stampUrlOnImage: false }),
));
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=6&tall=1`);
detail = await waitForResult(page.id);
const unstampedImage = newestFile('.jpg');
const unstampedReport = newestFile('.md');
console.log(`OFF image: ${unstampedImage}`);
console.log('OFF pixels: ' + JSON.stringify(await inspect(unstampedImage)));
console.log('OFF report stamp line: ' + JSON.stringify(
  readCapture(unstampedReport)
    .split('\n').filter((l) => l.startsWith('- **URL stamp:**')),
));
console.log('OFF report size lines: ' + JSON.stringify(
  readCapture(unstampedReport)
    .split('\n').filter((l) => /Full page:|Image file:/.test(l)),
));

console.log('\nstamp ON: ' + JSON.stringify(await setSetting(options, { stampUrlOnImage: true })));
// Result tabs accumulate and /json/list has no creation order, so the one this
// capture opens is identified by difference rather than by position.
const resultTabsBefore = new Set(
  (await cdp('/json/list')).filter((t) => t.url.includes('/result/result.html')).map((t) => t.id),
);
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=7&tall=1`);
detail = await waitForResult(page.id);
const stampedImage = newestFile('.jpg');
const stampedReport = newestFile('.md');
console.log(`ON image: ${stampedImage}`);
console.log('ON pixels: ' + JSON.stringify(await inspect(stampedImage)));
console.log('ON report stamp line: ' + JSON.stringify(
  readCapture(stampedReport)
    .split('\n').filter((l) => l.startsWith('- **URL stamp:**')),
));
console.log('ON report size lines: ' + JSON.stringify(
  readCapture(stampedReport)
    .split('\n').filter((l) => /Full page:|Image file:/.test(l)),
));
// The "never mid-image" requirement is only meaningfully tested on a capture
// that actually stitched segments, so the path taken is part of the evidence.
console.log('ON capture path: ' + JSON.stringify(
  readCapture(stampedReport).split('\n').filter((l) => l.startsWith('- **Capture mode:**')),
));
console.log('OFF capture path: ' + JSON.stringify(
  readCapture(unstampedReport).split('\n').filter((l) => l.startsWith('- **Capture mode:**')),
));
console.log('restore segment size: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false }),
));

// --- A6: horizontally overflowing page ----------------------------------
heading('CHECK A6 — page wider than the viewport, segmented (the black-column case)');
// A page whose content is always 400px wider than the viewport, tall enough to
// force segmentation. The failure this catches: the segment grid is planned
// against the RE-MEASURED content width while the browser viewport is still
// the width set from the PRE-measurement, so the rightmost columns are never
// painted and the canvas's initial transparent-black shows through.
//
// The segment size matters and 1024 will NOT reproduce it. The override width
// is min(naturalWidth, segmentSize) and the planning width is
// min(remeasuredWidth, segmentSize); when segmentSize is below both they
// collapse to the same number and the bug hides. It only bites when
// segmentSize exceeds the page width — which is the default 8192 on nearly
// every real page. 2048 here is above this page's ~1600 and below its height,
// reproducing Adam's 8192-with-an-1871px-page shape at test scale.
console.log('segment size 2048, stamp off: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 2048, stampUrlOnImage: false }),
));
page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=8&tall=1&wide=400`);
detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
const wideImage = newestFile('.jpg');
const wideReport = newestFile('.md');
console.log(`wide image: ${wideImage}`);
const widePixels = await inspect(wideImage);
console.log('wide pixels: ' + JSON.stringify(widePixels));
console.log('wide report geometry: ' + JSON.stringify(
  readCapture(wideReport)
    .split('\n').filter((l) => /Viewport:|Full page:|Image file:|Capture mode:/.test(l)),
));
console.log(
  'VERDICT undrawn right column: ' +
    (widePixels.blankColumnFromRight > 2
      ? `FAIL — ${widePixels.blankColumnFromRight}px never painted ` +
        `(painted ${widePixels.paintedWidth} of ${widePixels.width})`
      : 'PASS — full canvas width painted'),
);
console.log('restore segment size: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192 }),
));

// --- A9: browser page zoom ----------------------------------------------
heading('CHECK A9 — browser page zoom is normalized, not compensated');
// Emulation.setDeviceMetricsOverride takes DIPs and page zoom multiplies on
// top, so under zoom Z a virtual viewport of W lays out W/Z CSS pixels. The
// segmented path used to size its canvas from the CSS measurement while each
// screenshot covered only W of it, leaving a 1/Z-proportion of the canvas
// unpainted — black in JPEG. Measured at DPR 1 and DPR 2 alike, so zoom is the
// variable and devicePixelRatio is not.
console.log('segment size 2048: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 2048, stampUrlOnImage: false }),
));
for (const zoom of [0.25, 0.8]) {
  page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=1${zoom * 100}&tall=1&wide=400`);
  // The trigger page fires a capture of its own on load. Let that one finish —
  // a capture is a debugger attach, and two on one tab is an instant failure.
  await waitForResult(page.id);
  await sleep(1500);
  console.log(`\nzoom ${zoom * 100}% applied: ` + JSON.stringify(
    await options.eval(
      `(async () => {
         const tabs = await chrome.tabs.query({});
         const t = tabs.filter(t => t.url && t.url.includes('n=1${zoom * 100}')).pop();
         if (!t) return 'tab not found';
         await chrome.tabs.setZoom(t.id, ${zoom});
         await new Promise(r => setTimeout(r, 500));
         await chrome.tabs.update(t.id, { active: true });
         await new Promise(r => setTimeout(r, 500));
         const before = await chrome.tabs.getZoom(t.id);
         const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_BUNDLE' });
         await new Promise(r => setTimeout(r, 500));
         // The user's zoom must be given back after the capture.
         return { zoomBefore: before, ok: res.ok, reason: res.reason, zoomAfter: await chrome.tabs.getZoom(t.id) };
       })()`,
    ),
  ));
  await sleep(2500);
  const zoomImage = newestFile('.jpg');
  const zoomReport = newestFile('.md');
  const px = await inspect(zoomImage);
  console.log('pixels: ' + JSON.stringify(px));
  console.log('report: ' + JSON.stringify(
    readCapture(zoomReport)
      .split('\n')
      .filter((l) => /Viewport:|Full page:|Image file:|Browser zoom:|Pixel scale:/.test(l)),
  ));
  console.log(
    `VERDICT zoom ${zoom * 100}%: ` +
      (px.blankColumnFromRight > 2
        ? `FAIL — ${px.blankColumnFromRight}px unpainted of ${px.width}`
        : 'PASS — full canvas width painted'),
  );
}
console.log('\nrestore segment size: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192 }),
));

// --- A4: the result tab's copy controls ---------------------------------
heading('CHECK A4 — result-tab button labels, tooltip, and Copy report visibility');
{
  const tabs = await cdp('/json/list');
  const resultTabs = tabs.filter((t) => t.url.includes('/result/result.html'));
  const newest = resultTabs.find((t) => !resultTabsBefore.has(t.id)) ?? resultTabs[0];
  if (!newest) {
    console.log('no result tab open — reporting as a failure');
  } else {
    const r = new Session(newest.webSocketDebuggerUrl);
    await r.open();
    await r.send('Runtime.enable');
    console.log('buttons in the actions bar: ' + JSON.stringify(
      await r.eval(
        `[...document.querySelectorAll('.actions button')]
           .map(b => ({ id: b.id, text: b.textContent.replace(/\\s+/g,' ').trim(), hidden: b.hidden }))`,
      ),
    ));
    console.log('tooltip (character-exact compare): ' + JSON.stringify(
      await r.eval(
        `(() => {
           const b = document.getElementById('copy-image-report');
           const want = "Puts the screenshot and the markdown report on the clipboard together. Some AI chats keep only the image - if the report didn't arrive, paste it separately with Copy report.";
           return { title: b && b.title, matchesExactly: !!b && b.title === want };
         })()`,
      ),
    ));
    console.log('Copy report is visible: ' + JSON.stringify(
      await r.eval(
        `(() => {
           const b = document.getElementById('copy-report');
           if (!b) return 'button missing';
           const cs = getComputedStyle(b);
           return { hidden: b.hidden, display: cs.display, visible: !b.hidden && cs.display !== 'none' && b.offsetParent !== null };
         })()`,
      ),
    ));
    console.log('any remaining "Copy for AI" / "Copy markdown" text on the surface: ' + JSON.stringify(
      await r.eval(`/Copy for AI|Copy markdown/.test(document.body.innerText) ? 'FOUND' : 'none'`),
    ));
    r.close();
  }
}

// --- A5: the other capture paths still work -----------------------------
heading('CHECK A5 — regression: Image only, responsive sweep, session list');
console.log('CAPTURE_PAGE (Image only) → ' + JSON.stringify(
  await options.eval(
    `(async () => {
       const tabs = await chrome.tabs.query({});
       const target = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:${HTTP_PORT}/?'));
       if (!target) return { ok: false, reason: 'no http tab' };
       await chrome.tabs.update(target.id, { active: true });
       await new Promise(r => setTimeout(r, 600));
       return await chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE', png: false });
     })()`,
  ),
));
await sleep(2500);
console.log('CAPTURE_SWEEP → ' + JSON.stringify(
  await options.eval(
    `(async () => {
       const tabs = await chrome.tabs.query({});
       const target = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:${HTTP_PORT}/?'));
       if (!target) return { ok: false, reason: 'no http tab' };
       await chrome.tabs.update(target.id, { active: true });
       await new Promise(r => setTimeout(r, 600));
       return await chrome.runtime.sendMessage({ type: 'CAPTURE_SWEEP' });
     })()`,
  ),
));
await sleep(4000);
const sweepReport = newestFile('_sweep.md');
if (sweepReport) {
  console.log(`\n--- ${sweepReport} (context block) ---`);
  console.log(contextBlockOf(sweepReport));
}
console.log('SESSION_LIST_TABS still answers → ' + JSON.stringify(
  await options.eval(
    `chrome.runtime.sendMessage({ type: 'SESSION_LIST_TABS' }).then(r => Array.isArray(r) ? r.length + ' tabs' : r)`,
  ),
));
// A real two-tab session run: the session path calls captureReport with its own
// trigger and writes an index.md, so it is the one path that would break
// silently if the new trigger argument were threaded wrong.
console.log('SESSION_START (2 capturable tabs) → ' + JSON.stringify(
  await options.eval(
    `(async () => {
       const tabs = await chrome.runtime.sendMessage({ type: 'SESSION_LIST_TABS' });
       const ids = tabs.filter(t => !t.blockedReason && t.url.startsWith('http://127.0.0.1:${HTTP_PORT}/?'))
                       .slice(0, 2).map(t => t.id);
       if (ids.length < 2) return { ok: false, reason: 'not enough capturable tabs: ' + ids.length };
       const r = await chrome.runtime.sendMessage({ type: 'SESSION_START', tabIds: ids, reload: false });
       return r.ok ? { ok: true, pages: r.summary.pages, folder: r.summary.folder, failures: r.summary.failures } : r;
     })()`,
  ),
));
await sleep(1500);
{
  const sessionDir = readdirSync(captureDir()).filter((n) => n.startsWith('session_')).sort().pop();
  console.log('session folder written: ' + JSON.stringify(sessionDir ?? null));
  if (sessionDir) {
    console.log('session folder contents: ' + JSON.stringify(listDir(`${captureDir()}/${sessionDir}`)));
    const indexPath = `${captureDir()}/${sessionDir}/index.md`;
    if (existsSync(indexPath)) {
      console.log('index.md first 6 lines:');
      console.log(readFileSync(indexPath, 'utf8').split('\n').slice(0, 6).join('\n'));
    }
    // One per-page report from inside the session, to prove the context block
    // and its "Triggered by" reach that path too.
    const pageReport = readdirSync(`${captureDir()}/${sessionDir}`)
      .find((n) => n.endsWith('.md') && n !== 'index.md');
    if (pageReport) {
      console.log(`\n--- ${sessionDir}/${pageReport} (context block) ---`);
      const blocks = readFileSync(`${captureDir()}/${sessionDir}/${pageReport}`, 'utf8').split('\n\n');
      console.log(`${blocks[0]}\n\n${blocks[1]}`);
    }
  }
}
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));
console.log(`\n${DOWNLOADS} (must hold nothing from this round):`);
console.log(listDir(DOWNLOADS).join('\n') || '(empty)');

// --- A7: secondary popup controls look clickable ------------------------
heading('CHECK A7 — popup secondary controls render as real buttons');
{
  const popupUrl = `chrome-extension://${id}/popup/popup.html`;
  await openTab(popupUrl);
  const popup = await attach(popupUrl);
  console.log('button affordances: ' + JSON.stringify(
    await popup.eval(
      `[...document.querySelectorAll('.buttons button')].map(b => {
         const cs = getComputedStyle(b);
         return {
           id: b.id,
           classes: b.className || '(none)',
           borderWidth: cs.borderTopWidth,
           borderStyle: cs.borderTopStyle,
           borderColorTransparent: cs.borderTopColor === 'rgba(0, 0, 0, 0)',
           backgroundTransparent: cs.backgroundColor === 'rgba(0, 0, 0, 0)',
         };
       })`,
    ),
  ));
  console.log('VERDICT no bare-text buttons left: ' + JSON.stringify(
    await popup.eval(
      `[...document.querySelectorAll('.buttons button')]
         .filter(b => { const cs = getComputedStyle(b);
           return cs.borderTopColor === 'rgba(0, 0, 0, 0)' && cs.backgroundColor === 'rgba(0, 0, 0, 0)'; })
         .map(b => b.id)`,
    ),
  ));
  console.log('no .quiet left in the popup: ' + JSON.stringify(
    await popup.eval(`document.querySelectorAll('.buttons button.quiet').length === 0`),
  ));
  popup.close();
}

// --- A8: latest.* self-explanation --------------------------------------
heading('CHECK A8 — latest.md notice and the one-time README.txt');
{
  const dir = captureDir();
  const readmePath = `${dir}/${README_NAME}`;
  console.log(`output folder in use: ${dir}`);
  // The write-once flag, so a missing README says which half failed: no flag
  // means the write never ran, flag set means it ran and the file went
  // somewhere this check is not looking.
  console.log('write-once flag: ' + JSON.stringify(
    await options.eval(`chrome.storage.local.get(null)`),
  ));
  console.log('README download records: ' + JSON.stringify(
    await options.eval(
      `chrome.downloads.search({}).then(items =>
         items.filter(i => /README/i.test(i.filename) || /README/i.test(i.url.slice(0, 40)))
              .map(i => ({ filename: i.filename, state: i.state, error: i.error, exists: i.exists })))`,
    ),
  ));
  console.log('chosen-folder state: ' + JSON.stringify(
    await options.eval(
      `(async () => {
         const el = document.getElementById('output-dir-name');
         return el ? el.textContent.trim() : '(no options DOM)';
       })()`,
    ),
  ));
  console.log(`README.txt exists: ${existsSync(readmePath)}`);
  if (existsSync(readmePath)) {
    console.log(`--- ${README_NAME} ---`);
    console.log(readFileSync(readmePath, 'utf8'));
  }
  const duplicates = readdirSync(dir).filter((n) => /^README( \(\d+\))?\.txt$/.test(n));
  console.log('README files present (must be exactly one): ' + JSON.stringify(duplicates));

  const latest = `${dir}/latest.md`;
  if (existsSync(latest)) {
    console.log('--- latest.md, first 6 lines ---');
    console.log(readFileSync(latest, 'utf8').split('\n').slice(0, 6).join('\n'));
  } else {
    console.log('no latest.md written — reporting as a failure');
  }
  // The timestamped original must NOT carry the rolling-copy line.
  const original = newestFile('.md');
  console.log(
    `timestamped original (${original}) carries the rolling-copy line: ` +
      (original ? readCapture(original).includes('rolling copy') : 'n/a'),
  );
}

// --- A10: a closed off-canvas fixed drawer stays closed -----------------
heading('CHECK A10 — UNSTICK does not re-anchor an off-canvas fixed element');
// The studio defect: a chat drawer that is SHUT on screen appeared fully open
// in every capture. It is position:fixed and parked off-canvas, and `fixed`
// contributes nothing to the document's scrollable overflow — so the page
// measures as if the drawer were not there. UNSTICK's non-placeable branch
// rewrote it to position:absolute, which puts it INTO the document: the page
// widened by the off-canvas extent and the drawer painted, open, into the
// image.
//
// Fixture geometry is studio's literal numbers (left:916px +
// translateX(422.4px), width 384, overflow:clip on body and html). Before the
// fix this capture came back 1722 wide carrying 9406 drawer-coloured pixels;
// after it, 1300 wide and zero.
//
// The header is the negative half of the check and matters as much: the
// non-placeable branch exists to bring legitimate fixed chrome into a
// full-page capture, so a "fix" that simply stopped unsticking things would
// pass the drawer half and silently break the feature. It must appear, and on
// the segmented path it must appear exactly ONCE.
console.log('segment size 8192, stamp off: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false }),
));

for (const [variant, expectSegments] of [
  ['S studio-fixed-offcanvas', false],
  ['S2 studio-fixed-offcanvas-tall', true],
]) {
  console.log(`\n--- ${variant} ---`);
  page = await openTab(`http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent(variant)}`);
  detail = await waitForResult(page.id);
  console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
  await sleep(1500);
  const drawerImage = newestFile('.jpg');
  const drawerReport = newestFile('.md');
  const modeLine = drawerReport
    ? readCapture(drawerReport).split('\n').filter((l) => /Full page:|Capture mode:/.test(l))
    : [];
  console.log('report geometry: ' + JSON.stringify(modeLine));
  const px = await inspectDrawer(drawerImage);
  console.log('pixels: ' + JSON.stringify(px));

  console.log(
    'VERDICT drawer: ' +
      (px.drawerPixels > 200
        ? `FAIL — closed drawer painted (${px.drawerPixels} px at x ${px.drawerX.from}..${px.drawerX.to} of ${px.width})`
        : `PASS — closed drawer absent (${px.drawerPixels} px)`),
  );
  console.log(
    'VERDICT fixed header survived: ' +
      (px.headerPixels > 100 ? `PASS — ${px.headerPixels} px` : `FAIL — ${px.headerPixels} px, chrome lost`),
  );
  console.log(
    'VERDICT header painted once: ' +
      (px.headerBands.length === 1
        ? `PASS — 1 band ${JSON.stringify(px.headerBands)}`
        : px.headerBands.length === 0
          ? 'FAIL — 0 bands, header never painted'
          : `FAIL — ${px.headerBands.length} bands ${JSON.stringify(px.headerBands)} (per-segment repeat)`),
  );
  if (expectSegments) {
    const segmented = modeLine.some((l) => /segmented, \d+ segments/.test(l));
    console.log(
      'VERDICT took the segmented path (pass 2 of UNSTICK ran): ' +
        (segmented ? 'PASS' : 'FAIL — single-shot, pass 2 never executed'),
    );
  }

  // The live page must come back exactly as it was: the veto hides an element
  // the user can see, and a capture that dies mid-flight must not leave it that
  // way.
  const live = await attach(`http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent(variant)}`);
  console.log('live-page residue: ' + JSON.stringify(await live.eval(
    `(() => {
       const attrs = ['offscreen','position','prev-style','scroll','force-reveal','expand','expand-h'];
       const counts = {};
       for (const a of attrs) counts[a] = document.querySelectorAll('[data-capture-kit-' + a + ']').length;
       const d = document.getElementById('drawer');
       return {
         totalAttrs: Object.values(counts).reduce((a, b) => a + b, 0),
         stylesheets: ['__capture_kit_unstick__','__capture_kit_freeze__','__capture_kit_force_reveal__',
                       '__capture_kit_expand__'].filter((id) => document.getElementById(id)),
         drawerVisibility: d ? getComputedStyle(d).visibility : null,
         drawerPosition: d ? getComputedStyle(d).position : null,
       };
     })()`,
  )));
  live.close();
}

// --- A11: FORCE_REVEAL vetoes closed subtrees ---------------------------
heading('CHECK A11 — FORCE_REVEAL skips closed subtrees, and still reveals lazy sections');
// Leak 2. FORCE_REVEAL was a flat querySelectorAll('*') scan that forced
// opacity:1;visibility:visible on every computed-hidden element it found. Two
// holes, both artifacts of the scan being flat:
//
//   1. the position:fixed skip did not reach descendants. visibility inherits,
//      so a closed fixed drawer was skipped while every child inside it
//      computed visibility:hidden with position:static, got marked, and
//      painted. Variant F.
//   2. nothing consulted the closed-state markers the page already publishes,
//      so a drawer carrying aria-hidden="true" was treated exactly like a
//      lazy section waiting on scroll. Variant G, and variant D.
//
// The replacement walks the tree top down and skips a vetoed element's whole
// subtree. Variant H is the guard on the other side: three opacity:0 sections
// with no marker of any kind, which must still be revealed. A fix that closed
// the drawers by simply revealing less would fail H.
console.log('segment size 8192, stamp off: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false }),
));

// A and B are leak 1: an off-canvas absolute drawer un-clipped by the inner
// scroll expansion. Nothing in this check touches that path - neither drawer is
// computed-hidden, so FORCE_REVEAL never marked either of them - and the fix
// for it is a separate PR. They are captured here as a regression guard, so
// their numbers are RECORDED against the origin/main build rather than judged.
// Calling them FAIL would report someone else's open bug as this check's.
const LEAK_1_VARIANTS = new Set(['A off-canvas-left100', 'B off-canvas-transform']);

const named = (rgb, name) => ({ name, r: rgb.r, g: rgb.g, b: rgb.b });
const DRAWER_ONLY = [named(DRAWER_RGB, 'drawer')];
const A11_COLOURS = {
  'A off-canvas-left100': DRAWER_ONLY,
  'B off-canvas-transform': DRAWER_ONLY,
  'C display-none': DRAWER_ONLY,
  'D visibility-hidden': DRAWER_ONLY,
  'F fixed-visibility-hidden': [
    ...DRAWER_ONLY,
    ...F_CHILD_RGB.map((c, i) => named(c, `child${i}`)),
  ],
  'G absolute-aria-hidden': DRAWER_ONLY,
  'H lazy-sections': H_SECTION_RGB.map((c, i) => named(c, `section${i}`)),
};

/** Opens a tab and waits for that exact URL, so seven drawer tabs cannot alias. */
async function openExact(url) {
  await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const target = (await cdp('/json/list')).find((t) => t.url === url);
    if (target) return target;
  }
  return null;
}

async function inspectColours(file, colours) {
  const url =
    `http://127.0.0.1:${HTTP_PORT}/inspect-colours?file=${encodeURIComponent(file)}` +
    `&colours=${encodeURIComponent(JSON.stringify(colours))}`;
  const t = await openExact(url);
  if (!t) return { error: 'inspector tab never appeared' };
  const out = await waitForResult(t.id, 60000);
  await cdp(`/json/close/${t.id}`);
  return out;
}

/**
 * Runs one drawer-fixture variant through the real extension and counts
 * colours. `colours` defaults to A11's list for the variant; A12 passes its
 * own, because it asks about the sentinel as well as the drawer.
 */
async function captureVariant(variant, colours = A11_COLOURS[variant]) {
  const url = `http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent(variant)}`;
  const t = await openExact(url);
  if (!t) return { variant, error: 'fixture tab never appeared' };
  const detail = await waitForResult(t.id, 90000);
  await sleep(1500);
  const image = newestFile('.jpg');
  const report = newestFile('.md');
  const modeLine = report
    ? readCapture(report).split('\n').filter((l) => /Viewport:|Full page:|Capture mode:/.test(l))
    : [];
  const px = await inspectColours(image, colours);
  // Positive evidence that a deliberately no-opped build was the one running,
  // mirroring `unstickNeutered` in scripts/capture-fixture.mjs. The literal is
  // written into a COPY of dist by neuterDist() below and exists nowhere in
  // src, so it can never reach a shipped build.
  const live = new Session(t.webSocketDebuggerUrl);
  await live.open();
  await live.send('Runtime.enable');
  const neutered = await live.eval(`window.${NEUTER_BEACON} === true`);
  // A12's beacon. innerScrollPage runs through chrome.scripting.executeScript,
  // whose default world is ISOLATED, so a window property set there is not
  // readable from the main world this Session evaluates in. The DOM is shared
  // across worlds, so the beacon is an attribute on <html> instead. Same shape
  // as A11's otherwise: one literal, written into a COPY of dist, absent from
  // src, checkable in a shipped dist with a grep.
  const unclipRestored = await live.eval(
    `document.documentElement.getAttribute('${A12_BEACON}') === '1'`,
  );
  live.close();
  await cdp(`/json/close/${t.id}`);
  return { variant, detail, image, modeLine, px, neutered, unclipRestored };
}

function revealForcedFrom(modeLine) {
  const m = /reveal-forced \((\d+) elements\)/.exec(modeLine.join(' '));
  return m ? Number(m[1]) : 0;
}

const a11 = {};
for (const variant of Object.keys(A11_COLOURS)) {
  console.log(`\n--- ${variant} ---`);
  const r = await captureVariant(variant);
  a11[variant] = r;
  if (r.error) {
    console.log(`FAIL — ${r.error}`);
    continue;
  }
  console.log('capture-kit:capture-complete → ' + JSON.stringify(r.detail));
  console.log('report geometry: ' + JSON.stringify(r.modeLine));
  console.log('pixels: ' + JSON.stringify(r.px));
  const by = Object.fromEntries((r.px.colours ?? []).map((c) => [c.name, c]));
  if (variant.startsWith('H ')) {
    for (const c of r.px.colours ?? []) {
      console.log(
        `VERDICT ${c.name} still revealed: ` +
          (c.pixels >= 1000 ? `PASS — ${c.pixels} px` : `FAIL — ${c.pixels} px, over-corrected`),
      );
    }
    const forced = revealForcedFrom(r.modeLine);
    console.log(
      'VERDICT reveal-forced count >= 3: ' +
        (forced >= 3 ? `PASS — ${forced}` : `FAIL — ${forced}`),
    );
  } else if (LEAK_1_VARIANTS.has(variant)) {
    console.log(
      `RECORDED (leak 1, separate PR) drawer: ${by.drawer.pixels} px` +
        (by.drawer.pixels ? ` at x ${by.drawer.x.from}..${by.drawer.x.to}` : '') +
        ` of ${r.px.width} — compare against the origin/main build, must be equal`,
    );
  } else {
    console.log(
      'VERDICT drawer absent: ' +
        (by.drawer.pixels > 200
          ? `FAIL — closed drawer painted (${by.drawer.pixels} px at x ` +
            `${by.drawer.x.from}..${by.drawer.x.to} of ${r.px.width})`
          : `PASS — closed drawer absent (${by.drawer.pixels} px)`),
    );
    for (const c of r.px.colours ?? []) {
      if (c.name === 'drawer') continue;
      console.log(
        `VERDICT ${c.name} absent: ` +
          (c.pixels > 200
            ? `FAIL — drawer child painted (${c.pixels} px at x ${c.x.from}..${c.x.to})`
            : `PASS — ${c.pixels} px`),
      );
    }
  }
}

// CK_DIST lets this same harness drive an older commit's build, which is how
// the A/B/H numbers above are compared across builds. Two parts of A11 only
// mean anything against a build compiled from THIS checkout's src: the
// reveal-forced identity check, and the neutering, whose substitution target
// does not exist in a pre-fix bundle at all.
const OWN_BUILD = existsSync(DIST) && realpathSync(DIST) === realpathSync(`${ROOT}/dist`);

// The report's reveal-forced number has to be the script's own return value,
// not a recount taken somewhere else in the pipeline.
if (OWN_BUILD) {
  const url = `http://127.0.0.1:${HTTP_PORT}/drawer?v=${encodeURIComponent('H lazy-sections')}`;
  const t = await openExact(url);
  const s = new Session(t.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');
  const direct = await s.eval(FORCE_REVEAL_SCRIPT_SRC);
  s.close();
  await cdp(`/json/close/${t.id}`);
  const reported = revealForcedFrom(a11['H lazy-sections'].modeLine ?? []);
  console.log(
    `\nVERDICT reported revealForced === FORCE_REVEAL_SCRIPT return: ` +
      (reported === direct
        ? `PASS — both ${direct}`
        : `FAIL — report says ${reported}, script returns ${direct}`),
  );
} else {
  console.log(
    `\nreveal-forced identity check skipped: running ${DIST}, which was not built from this src`,
  );
}

// --- shared by both falsifiability rounds --------------------------------
// A11 and A12 each need a negative control: without one, "0 drawer pixels"
// could mean the fix works or could mean the fixture never leaked in the first
// place. Both disables are a textual substitution on a COPY of the built
// bundle, which is the mechanism leak 3's STEP 1 negative control used
// (scripts/capture-fixture.mjs reports `unstickNeutered` off a hand-neutered
// build). Nothing about either is in src, so no shipped dist can contain them.
// Swapping the loaded extension means relaunching the browser, which is what
// this does.
async function relaunchWith(dist) {
  options.close();
  chrome.kill('SIGTERM');
  killStrays();
  await sleep(2000);
  chrome = launch(dist);
  await waitForPort();
  await armDownloads();
  const newId = await discoverExtensionId(extensionId(dist));
  const url = `chrome-extension://${newId}/options/options.html`;
  await openExact(url);
  options = await attach(url);
  await setSetting(options, {
    pageTriggerMode: 'any',
    segmentSize: 8192,
    stampUrlOnImage: false,
  });
  return newId;
}

heading('CHECK A11 (falsifiability) — variant G with the subtree veto disabled');
if (!OWN_BUILD) {
  console.log(`skipped: running ${DIST}, whose bundle has no veto to neuter`);
} else {
  console.log(`veto source line:  ${VETO_SOURCE_LINE}`);
  console.log(`neuter beacon:     window.${NEUTER_BEACON}`);
  const neuteredDist = neuterDist();
  console.log(`neutered dist:     ${neuteredDist}`);

  console.log(`extension id (neutered build): ${await relaunchWith(neuteredDist)}`);
  const gOff = await captureVariant('G absolute-aria-hidden');
  console.log('pixels: ' + JSON.stringify(gOff.px));
  console.log(`neutered build was the one running: ${gOff.neutered}`);
  const gOffPixels = gOff.px.colours?.[0]?.pixels ?? -1;
  console.log(
    'VERDICT A11 is falsifiable: ' +
      (gOffPixels > 200 && gOff.neutered === true
        ? `PASS — veto off leaks ${gOffPixels} px at x ${gOff.px.colours[0].x.from}..` +
          `${gOff.px.colours[0].x.to} of ${gOff.px.width}`
        : `FAIL — veto off leaked ${gOffPixels} px, beacon ${gOff.neutered}`),
  );

  console.log(`\nextension id (real build): ${await relaunchWith(DIST)}`);
  const gOn = await captureVariant('G absolute-aria-hidden');
  console.log('pixels: ' + JSON.stringify(gOn.px));
  console.log(`neutered build was the one running: ${gOn.neutered}`);
  const gOnPixels = gOn.px.colours?.[0]?.pixels ?? -1;
  console.log(
    'VERDICT veto re-enabled: ' +
      (gOnPixels <= 200 && gOn.neutered === false
        ? `PASS — ${gOnPixels} px, beacon ${gOn.neutered}`
        : `FAIL — ${gOnPixels} px, beacon ${gOn.neutered}`),
  );
}

// --- CHECK A12 ----------------------------------------------------------
heading('CHECK A12 — inner-scroll expansion no longer un-clips off-canvas siblings');
// Leak 1. innerScrollPage expands the dominant inner scroller and then walked
// every ancestor up to <html> forcing `overflow:visible` on each. An app shell
// that hides an off-canvas drawer by nothing but `overflow:hidden` on a
// container it shares with the scroller had that concealment taken away, and
// the drawer both widened the captured document box and painted.
//
// The fix does not scope the un-clip to one axis - CSS forbids it, and
// scripts/probe-innerscroll.mjs measures that: overflow-x:hidden with
// overflow-y:visible computes overflow-y:auto, and an auto axis clips into a
// scroll region rather than painting outward. It releases HEIGHT instead. An
// ancestor at height:100% with overflow:hidden clips the expanded child only
// because it cannot grow; at height:auto it grows to contain the child, so its
// retained overflow:hidden clips nothing on the scroll axis while still
// clipping the off-canvas sibling on the cross axis.
//
// Two questions, not one. A check that only counted the drawer would pass just
// as well against a "fix" that stopped expanding: no expansion, no un-clip, no
// drawer. So every variant here also counts the sentinel - a cyan block that is
// the last child of the scroller, thousands of pixels below the fold, which
// paints only if expansion reached the end of the scroller's content.
console.log('segment size 8192, stamp off: ' + JSON.stringify(
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false }),
));

const A12_DRAWER_AND_SENTINEL = [
  named(DRAWER_RGB, 'drawer'),
  named(SENTINEL_RGB, 'sentinel'),
];
const A12_COLOURS = {
  'A off-canvas-left100': A12_DRAWER_AND_SENTINEL,
  'B off-canvas-transform': A12_DRAWER_AND_SENTINEL,
  // The positive control: same shell, same sentinel, no drawer at all. It
  // carries the drawer colour in its list anyway, so "no drawer painted" is
  // measured here rather than assumed from the markup.
  'I sentinel-no-drawer': A12_DRAWER_AND_SENTINEL,
  // NOBC-166: the pinned-panel shell. No drawer; the sentinel must paint, and
  // so must the nav beside it - a blank capture fails both.
  'J pinned-panel-shell': [...A12_DRAWER_AND_SENTINEL, named(NAV_RGB, 'nav')],
};
const SENTINEL_FLOOR = 1000;

const a12 = {};
for (const variant of Object.keys(A12_COLOURS)) {
  console.log(`\n--- ${variant} ---`);
  const r = await captureVariant(variant, A12_COLOURS[variant]);
  a12[variant] = r;
  if (r.error) {
    console.log(`FAIL — ${r.error}`);
    continue;
  }
  console.log('capture-kit:capture-complete → ' + JSON.stringify(r.detail));
  console.log('report geometry: ' + JSON.stringify(r.modeLine));
  console.log('pixels: ' + JSON.stringify(r.px));
  const by = Object.fromEntries((r.px.colours ?? []).map((c) => [c.name, c]));
  if (!by.drawer || !by.sentinel) {
    // An inspector that failed to decode reports no colours at all, and a
    // missing count must not read as a clean zero.
    console.log(`FAIL — inspector returned no counts: ${JSON.stringify(r.px)}`);
    continue;
  }
  console.log(
    `VERDICT ${variant} off-canvas drawer absent: ` +
      (by.drawer.pixels === 0
        ? 'PASS — 0 drawer-colour pixels'
        : `FAIL — ${by.drawer.pixels} drawer-colour px at x ${by.drawer.x.from}..` +
          `${by.drawer.x.to} of ${r.px.width}`),
  );
  if (by.nav) {
    console.log(
      `VERDICT ${variant} nav still paints at the left: ` +
        (by.nav.pixels >= 10000 && by.nav.x.from <= 4 && by.sentinel.x?.from >= NAV_WIDTH - 4
          ? `PASS — nav ${by.nav.pixels} px at x ${by.nav.x.from}..${by.nav.x.to}, ` +
            `content from x ${by.sentinel.x.from}`
          : `FAIL — nav ${by.nav.pixels} px at ${JSON.stringify(by.nav.x)}, ` +
            `sentinel at ${JSON.stringify(by.sentinel.x)}`),
    );
    console.log(`J capture mode: ${r.modeLine.find((l) => /Capture mode/.test(l)) ?? '(none)'}`);
  }
  console.log(
    `VERDICT ${variant} scroller still expanded: ` +
      (by.sentinel.pixels >= SENTINEL_FLOOR
        ? `PASS — sentinel ${by.sentinel.pixels} px (floor ${SENTINEL_FLOOR})`
        : `FAIL — sentinel ${by.sentinel.pixels} px, below the ${SENTINEL_FLOOR} floor; ` +
          'expansion did not reach the end of the scroller'),
  );
}

// --- A12 falsifiability: the ancestor overflow rule put back --------------
// Without this, "0 drawer pixels" could mean the fix works or could mean the
// fixture never leaked. Same mechanism A11 uses: a textual substitution on a
// COPY of the built bundle, announcing itself from the page, with a literal
// that exists nowhere in src.
heading('CHECK A12 (falsifiability) — variant A with the ancestor overflow rule restored');
if (!OWN_BUILD) {
  console.log(`skipped: running ${DIST}, whose bundle has no ancestor rule to restore`);
} else {
  console.log(`ancestor rule target: ${UNCLIP_SOURCE_LINE}`);
  console.log(`restore beacon:       <html ${A12_BEACON}="1">`);
  const unclippedDist = restoreAncestorUnclip();
  console.log(`unclipped dist:       ${unclippedDist}`);

  console.log(`extension id (unclipped build): ${await relaunchWith(unclippedDist)}`);
  const aOff = await captureVariant('A off-canvas-left100', A12_DRAWER_AND_SENTINEL);
  console.log('pixels: ' + JSON.stringify(aOff.px));
  console.log(`unclipped build was the one running: ${aOff.unclipRestored}`);
  const aOffBy = Object.fromEntries((aOff.px.colours ?? []).map((c) => [c.name, c]));
  const aOffDrawer = aOffBy.drawer?.pixels ?? -1;
  console.log(
    'VERDICT A12 is falsifiable: ' +
      (aOffDrawer > 200 && aOff.unclipRestored === true
        ? `PASS — ancestor overflow back on leaks ${aOffDrawer} drawer px at x ` +
          `${aOffBy.drawer.x.from}..${aOffBy.drawer.x.to} of ${aOff.px.width}`
        : `FAIL — ancestor overflow back on leaked ${aOffDrawer} px, ` +
          `beacon ${aOff.unclipRestored}`),
  );

  console.log(`\nextension id (real build): ${await relaunchWith(DIST)}`);
  const aOn = await captureVariant('A off-canvas-left100', A12_DRAWER_AND_SENTINEL);
  console.log('pixels: ' + JSON.stringify(aOn.px));
  console.log(`unclipped build was the one running: ${aOn.unclipRestored}`);
  const aOnBy = Object.fromEntries((aOn.px.colours ?? []).map((c) => [c.name, c]));
  const aOnDrawer = aOnBy.drawer?.pixels ?? -1;
  const aOnSentinel = aOnBy.sentinel?.pixels ?? -1;
  console.log(
    'VERDICT ancestor rule re-disabled: ' +
      (aOnDrawer === 0 && aOnSentinel >= SENTINEL_FLOOR && aOn.unclipRestored === false
        ? `PASS — ${aOnDrawer} drawer px, sentinel ${aOnSentinel} px, ` +
          `beacon ${aOn.unclipRestored}`
        : `FAIL — ${aOnDrawer} drawer px, sentinel ${aOnSentinel} px, ` +
          `beacon ${aOn.unclipRestored}`),
  );
}

heading('CHECK A13 — a page-fired capture photographs the page that asked');
{
  const own = await tabTargetingCheck('this build');
  console.log(
    'VERDICT A13 capture pinned to the asking tab: ' +
      (!own.preconditionHeld
        ? 'INCONCLUSIVE — the decoy window never became the extension\'s active tab'
        : own.target === 'fixture'
          ? 'PASS — the report names the page that fired, not the focused decoy'
          : `FAIL — captured the ${own.target}`),
  );
}

heading('CHECK A14 — the panel window captures the tab it was opened for');
console.log('VERDICT A14 panel pinned to its window: ' + a14Verdict(await panelTargetingCheck('this build')));

heading('CHECK A15 — hidden layers stay hidden, lazy content still revealed');
{
  await setSetting(options, { segmentSize: 8192, stampUrlOnImage: false });
  const own = await hiddenLayersCheck();
  console.log('pixels: ' + JSON.stringify(own.run.px));
  console.log('VERDICT A15 hidden layers: ' + a15Verdict(own));
}

heading('CHECK A19 — before/after');
{
  const r = await beforeAfterCheck();
  console.log('VERDICT A19 before/after: ' + a19Verdict(r));
}

heading('CHECK A16 — a virtualized list captures whole');
{
  const own = await virtualizedCheck();
  console.log('pixels: ' + JSON.stringify(own.run.px));
  console.log('VERDICT A16 virtualized list: ' + a16Verdict(own));
}

options.close();
chrome.kill('SIGTERM');
killStrays();
await sleep(2000);
http.close();
process.exit(0);
