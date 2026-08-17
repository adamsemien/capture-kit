// Runs the NOBC-82 acceptance checks end to end and prints raw output.
//
//   npm run build && node scripts/acceptance.mjs
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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';

const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/` +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = `${ROOT}/dist`;
const PROFILE = '/tmp/ck-accept-profile';
const DOWNLOADS = '/tmp/ck-accept-downloads';
const OUTPUT_DIR = `${process.env.HOME}/NoBad/_work/capture-kit-accept`;
const PORT = 9334;
const HTTP_PORT = 8765;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => execFileSync('/usr/bin/osascript', ['-e', s], { encoding: 'utf8' }).trim();

function extensionId() {
  const hex = createHash('sha256').update(DIST).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
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

// The page under capture reports through its title, so nothing has to attach a
// second debugger to it.
const TRIGGER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ready</title></head>
<body><h1>capture-kit acceptance page</h1>
<p>Some text so the capture has pixels in it.</p>
<script>
  document.addEventListener('capture-kit:capture-complete', (e) => {
    document.title = 'RESULT ' + JSON.stringify(e.detail);
  });
  window.fire = () => document.dispatchEvent(new CustomEvent('capture-kit:capture'));
  // Fired on load, and again whenever the URL carries a fresh ?n=
  addEventListener('load', () => setTimeout(window.fire, 800));
</script>
</body></html>`;

function startHttp() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TRIGGER_PAGE);
  });
  server.listen(HTTP_PORT, '127.0.0.1');
  return server;
}

function seedProfile() {
  mkdirSync(`${PROFILE}/Default`, { recursive: true });
  const prefs = `${PROFILE}/Default/Preferences`;
  if (!existsSync(prefs)) {
    // Keeps every fallback download out of the real ~/Downloads.
    writeFileSync(prefs, JSON.stringify({ download: { default_directory: DOWNLOADS } }));
  }
}

function launch() {
  seedProfile();
  mkdirSync(DOWNLOADS, { recursive: true });
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${DIST}`,
      `--disable-extensions-except=${DIST}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return child;
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

const id = extensionId();
const optionsUrl = `chrome-extension://${id}/options/options.html`;
const http = startHttp();

heading('SETUP');
let chrome = launch();
console.log(`chrome: ${await waitForPort()}`);
console.log(`extension id: ${id}`);
console.log(`output folder: ${OUTPUT_DIR}`);
console.log(`downloads redirected to: ${DOWNLOADS}`);

// --- check 1: choose the folder, capture, files land there --------------
heading('CHECK 1 — chosen folder receives the capture, Downloads gains nothing');
await openTab(optionsUrl);
let options = await attach(optionsUrl);
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
options.close();

let page = await openTab(`http://127.0.0.1:${HTTP_PORT}/?n=1`);
let detail = await waitForResult(page.id);
console.log('capture-kit:capture-complete → ' + JSON.stringify(detail));
console.log(`\n${OUTPUT_DIR}:`);
console.log(listDir(OUTPUT_DIR).join('\n'));
console.log(`\n${DOWNLOADS} (must stay empty):`);
console.log(listDir(DOWNLOADS).join('\n') || '(empty)');

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
await sleep(4000);
chrome = launch();
console.log(`chrome restarted: ${await waitForPort()}`);
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

chrome.kill('SIGTERM');
await sleep(2000);
http.close();
process.exit(0);
