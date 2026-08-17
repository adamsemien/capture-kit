// Drives the FSA spike without a human: launches an isolated Chrome (its own
// profile, only this extension loaded), opens the spike page over CDP, and
// answers the native folder-chooser with AppleScript keystrokes aimed at that
// process specifically — never at whatever Chrome the user has open.
//
//   node scripts/spike-fsa/drive.mjs choose   # pick the folder + write (finding 1)
//   node scripts/spike-fsa/drive.mjs write    # write only, no picker (finding 2)
//
// The profile dir persists between runs on purpose: finding 2 is "did the
// permission survive a full browser restart", which only means anything if the
// same profile comes back up.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Branded Chrome 137+ ignores --load-extension outright, so the driver runs
// Chrome for Testing (same Chromium, same 151 build family) — the only way to
// get an unpacked extension in without a human at chrome://extensions.
const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/` +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PROFILE = '/tmp/ck-spike-profile';
const EXT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 9333;
const TARGET_DIR = `${process.env.HOME}/NoBad/_work/capture-kit-spike`;
const mode = process.argv[2] ?? 'choose';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function osa(script) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

/** One CDP websocket, one evaluate at a time — enough for a spike. */
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      return { __threw: result.exceptionDetails.exception?.description ?? 'threw' };
    }
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function launch() {
  if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT}`,
      `--disable-extensions-except=${EXT}`,
      // Chrome 137 turned --load-extension into a no-op behind this feature
      // flag; without disabling it the browser comes up with no extension and
      // the spike page is a network error.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--restore-last-session=false',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const v = await json('/json/version');
      if (v.Browser) return { child, browser: v.Browser };
    } catch {
      /* not up yet */
    }
  }
  throw new Error('Chrome never opened its debugging port');
}

// An unpacked extension's id is a hash of its absolute path, so it is knowable
// before Chrome starts — the service-worker target itself is lazy and may not
// exist until the page messages it.
function extensionId() {
  const hex = createHash('sha256').update(EXT).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * The folder chooser is a macOS sheet on the browser window — invisible to
 * CDP. Wait for it to actually exist before typing, or the keystrokes land in
 * the page (an earlier run opened Chrome's find bar instead).
 */
function waitForFolderSheet(pid, seconds = 20) {
  for (let i = 0; i < seconds * 2; i++) {
    const state = osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
      set n to 0
      repeat with w in windows
        try
          set n to n + (count of sheets of w)
        end try
      end repeat
      set d to 0
      repeat with w in windows
        try
          if subrole of w is "AXDialog" then set d to d + 1
        end try
      end repeat
      return (n as text) & "," & (d as text) & "," & ((count of windows) as text)
    end tell`);
    const [sheets, dialogs] = state.split(',').map(Number);
    if (sheets > 0 || dialogs > 0) return state;
    execFileSync('/bin/sleep', ['0.5']);
  }
  return 'no sheet appeared';
}

/** Cmd+Shift+G, type the path, Return, Return — aimed at our Chrome only. */
function answerFolderDialog(pid) {
  osa(`tell application "System Events" to tell (first process whose unix id is ${pid}) to set frontmost to true`);
  const state = waitForFolderSheet(pid);
  console.log(`folder sheet state (sheets,dialogs,windows): ${state}`);
  osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
    set frontmost to true
    delay 0.5
    keystroke "g" using {command down, shift down}
    delay 1.5
    keystroke "${TARGET_DIR}"
    delay 1.5
    keystroke return
    delay 1.5
    keystroke return
  end tell`);
}

/** The "Let it edit files?" bubble is browser UI; CDP cannot reach it. */
function describeChromeUi(pid) {
  try {
    return osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
      set out to ""
      repeat with w in windows
        set out to out & "window: " & (name of w) & linefeed
        try
          repeat with b in (buttons of w)
            set out to out & "  button: " & (name of b) & linefeed
          end repeat
        end try
      end repeat
      return out
    end tell`);
  } catch (error) {
    return `ui read failed: ${error.message.split('\n')[0]}`;
  }
}

function clickChromeButton(pid, name) {
  return osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
    set frontmost to true
    delay 0.5
    repeat with w in windows
      try
        repeat with e in (entire contents of w)
          try
            if (role of e is "AXButton") and (title of e is "${name}") then
              click e
              return "clicked ${name}"
            end if
          end try
        end repeat
      end try
    end repeat
    return "no button named ${name}"
  end tell`);
}

/** Every button title in the process, however deeply nested (Chrome bubbles). */
function dumpButtons(pid) {
  try {
    return osa(`tell application "System Events" to tell (first process whose unix id is ${pid})
      set out to ""
      repeat with w in windows
        set out to out & "WINDOW: " & (name of w) & linefeed
        try
          set els to entire contents of w
          repeat with e in els
            try
              if role of e is "AXButton" or role of e is "AXCheckBox" or role of e is "AXRadioButton" then
                set out to out & "  " & (role of e) & ": " & (title of e) & linefeed
              end if
            end try
          end repeat
        end try
      end repeat
      return out
    end tell`);
  } catch (error) {
    return `ui read failed: ${error.message.split('\n')[0]}`;
  }
}

const { child, browser } = await launch();
const pid = child.pid;
console.log(JSON.stringify({ browser, pid, profile: PROFILE, mode }, null, 2));

const id = extensionId();
const pageUrl = `chrome-extension://${id}/spike.html`;
await json(`/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
await sleep(1500);

const targets = await json('/json/list');
const page = targets.find((t) => t.url === pageUrl);
const session = new Session(page.webSocketDebuggerUrl);
await session.open();
await session.send('Runtime.enable');

console.log('--- PROBE ---');
console.log(
  JSON.stringify(
    await session.eval(`(async () => ({
      page: {
        showDirectoryPicker: typeof showDirectoryPicker,
        createWritable: typeof FileSystemFileHandle.prototype.createWritable,
      },
      serviceWorker: await chrome.runtime.sendMessage({ type: 'SPIKE_PROBE' }),
    }))()`),
    null,
    2,
  ),
);

if (mode === 'choose') {
  console.log('--- CHOOSE (native dialog answered by AppleScript) ---');
  const picking = session.eval(
    `(async () => {
      try {
        const h = await showDirectoryPicker({ id: 'capture-kit-spike', mode: 'readwrite' });
        const { putHandle } = await import('./idb.js');
        await putHandle(h);
        return { picked: h.name, permission: await h.queryPermission({ mode: 'readwrite' }) };
      } catch (e) { return { error: String(e) }; }
    })()`,
    true,
  );
  await sleep(2000);
  answerFolderDialog(pid);
  await sleep(2000);
  console.log('chrome ui after dialog:\n' + describeChromeUi(pid));
  for (const label of ['Edit files', 'View files', 'Allow on every visit', 'Allow']) {
    const out = clickChromeButton(pid, label);
    if (out.startsWith('clicked')) {
      console.log(out);
      break;
    }
  }
  console.log('picker result: ' + JSON.stringify(await picking));
}

if (mode.startsWith('restore')) {
  // The permission is gone after a restart; this is the one path a user has to
  // get it back — a gesture-backed requestPermission, which is where Chrome
  // offers "Allow on every visit" if persistent grants exist for this origin.
  console.log('--- RESTORE (gesture-backed requestPermission) ---');
  const before = await session.eval(`(async () => {
    const { getHandle } = await import('./idb.js');
    const h = await getHandle();
    return h ? await h.queryPermission({ mode: 'readwrite' }) : 'NO HANDLE';
  })()`);
  console.log('queryPermission before: ' + JSON.stringify(before));

  const requesting = session.eval(
    `(async () => {
      const { getHandle } = await import('./idb.js');
      const h = await getHandle();
      try { return { requested: await h.requestPermission({ mode: 'readwrite' }) }; }
      catch (e) { return { error: String(e) }; }
    })()`,
    // `restore nogesture` asks the same question without a user gesture: if
    // that works, an extension page can silently re-arm the permission after a
    // restart and nobody has to click anything.
    process.argv[3] !== 'nogesture',
  );
  await sleep(2500);
  console.log('chrome ui while the prompt is up:\n' + dumpButtons(pid));
  for (const label of ['Allow on every visit', 'Allow this time', 'Edit files', 'Allow']) {
    const out = clickChromeButton(pid, label);
    if (out.startsWith('clicked')) {
      console.log(out);
      break;
    }
  }
  console.log('requestPermission result: ' + JSON.stringify(await requesting));
}

// Does the re-granted permission belong to the origin for the rest of the
// browser session, or only to the page that asked? If it dies with the page,
// the spec's plan B (a pinned extension page holding the handle) is required;
// if it survives, nothing needs pinning.
if (mode === 'restoreclose') {
  console.log('--- CLOSE THE GRANTING PAGE, THEN WRITE FROM A FRESH ONE ---');
  await json(`/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
  await sleep(1500);
  const second = (await json('/json/list')).find(
    (t) => t.url === pageUrl && t.id !== page.id,
  );
  await json(`/json/close/${page.id}`);
  session.close();
  await sleep(1000);
  const s2 = new Session(second.webSocketDebuggerUrl);
  await s2.open();
  await s2.send('Runtime.enable');
  console.log(
    'write from a page that never asked for permission, granting page closed:\n' +
      JSON.stringify(
        await s2.eval(
          `chrome.runtime.sendMessage({ type: 'SPIKE_WRITE', filename: 'spike-afterclose.txt', text: 'after close\\n' })`,
        ),
        null,
        2,
      ),
  );
  s2.close();
  child.kill('SIGTERM');
  await sleep(3000);
  process.exit(0);
}

console.log('--- WRITE FROM SERVICE WORKER ---');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
console.log(
  JSON.stringify(
    await session.eval(
      `chrome.runtime.sendMessage({
        type: 'SPIKE_WRITE',
        filename: 'spike-${mode}-${stamp}.txt',
        text: 'written from the MV3 service worker at ${stamp}\\n',
      })`,
      true,
    ),
    null,
    2,
  ),
);

session.close();
// SIGTERM, not kill: Chrome flushes its prefs on a clean shutdown, and whether
// the grant survives that shutdown is the whole of finding 2.
child.kill('SIGTERM');
await sleep(3000);
