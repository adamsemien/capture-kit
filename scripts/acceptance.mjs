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
const PORT = 9334;
const HTTP_PORT = 8765;
const README_NAME = 'README.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => execFileSync('/usr/bin/osascript', ['-e', s], { encoding: 'utf8' }).trim();

// Chrome derives an unpacked extension's id from the RESOLVED directory path.
// On macOS /tmp is a symlink to /private/tmp, so hashing the path as given
// produces an id that does not exist — the options page then 404s and every
// chrome.* eval comes back "undefined", which reads like a product failure
// rather than a harness one. realpath first.
function extensionId() {
  const resolved = existsSync(DIST) ? realpathSync(DIST) : DIST;
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
    if (url.pathname === '/inspect') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INSPECT_PAGE);
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

function launch() {
  // Never share the profile with a survivor of an earlier run.
  killStrays();
  seedProfile();
  mkdirSync(DOWNLOADS, { recursive: true });
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${DIST}`,
      `--disable-extensions-except=${DIST}`,
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
           await chrome.storage.sync.set({ allowInPageTrigger: true });
           return (await chrome.storage.sync.get('allowInPageTrigger')).allowInPageTrigger;
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

options.close();
chrome.kill('SIGTERM');
killStrays();
await sleep(2000);
http.close();
process.exit(0);
