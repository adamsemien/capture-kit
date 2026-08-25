// Diagnostic only - not part of the extension, not part of the build.
//
//   node scripts/probe-innerscroll.mjs                       # variant A
//   node scripts/probe-innerscroll.mjs --variant='B off-canvas-transform'
//   node scripts/probe-innerscroll.mjs --headed
//
// Stage 0 instrument for NOBC-82 (leak 1: inner-scroll expansion un-clips
// off-canvas siblings). It answers three questions with measurements rather
// than argument:
//
//   1. Can overflow be scoped to one axis? Sets overflow-x:hidden with
//      overflow-y:visible on a scratch element and reports the COMPUTED
//      overflow-y. If CSS rewrites the visible axis to `auto`, an axis-scoped
//      un-clip cannot work and the fix has to release height instead.
//
//   2. Which element actually clips the drawer? Runs the real
//      innerScrollPage('expand') - lifted out of src the same way
//      scripts/probe-reveal.mjs lifts it, so the probe cannot drift from the
//      code it probes - and reports every element that got
//      data-capture-kit-expand="ancestor", its computed overflow and height
//      before expansion, and whether the drawer's border box escapes it.
//
//   3. Does the drawer land inside the captured document box after expansion?
//      That is the condition under which it paints into a full-page capture.
//
// No extension is loaded and no capture is taken: this measures the DOM
// mechanism. Pixel counts come from scripts/acceptance.mjs CHECK A12.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { fixture, viewportFor } from './drawer-fixture.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHROME =
  process.env.CHROME_BIN ??
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/` +
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = Number(process.env.CK_PROBE_CDP_PORT ?? 9338);
const HTTP_PORT = Number(process.env.CK_PROBE_HTTP_PORT ?? 8769);
const PROFILE = '/tmp/ck-probe-innerscroll-profile';
const HEADED = process.argv.includes('--headed');
const VARIANT =
  process.argv.find((a) => a.startsWith('--variant='))?.slice(10) ?? 'A off-canvas-left100';
const VIEWPORT = viewportFor(VARIANT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- innerScrollPage, lifted out of src ---------------------------------
//
// scripts/probe-reveal.mjs already does this extraction and emits a console
// probe that contains it. Rather than write a second extractor that can drift
// from the first, this probe runs that generator and pulls the function out of
// its output by the same marker probe-reveal.mjs writes.
const PROBE_SRC = execFileSync('node', [`${ROOT}/scripts/probe-reveal.mjs`], {
  encoding: 'utf8',
  maxBuffer: 8 << 20,
});
const fnStart = PROBE_SRC.indexOf('function innerScrollPage(');
if (fnStart < 0) {
  console.error('probe-reveal.mjs output no longer contains innerScrollPage; extraction failed.');
  process.exit(1);
}
let depth = 0;
let fnEnd = PROBE_SRC.indexOf('{', PROBE_SRC.indexOf(')', fnStart));
for (; fnEnd < PROBE_SRC.length; fnEnd++) {
  if (PROBE_SRC[fnEnd] === '{') depth++;
  else if (PROBE_SRC[fnEnd] === '}' && --depth === 0) break;
}
const INNER_SCROLL_PAGE = PROBE_SRC.slice(fnStart, fnEnd + 1);
if (!INNER_SCROLL_PAGE.includes('data-capture-kit-expand')) {
  console.error('extracted innerScrollPage does not mention the expand attribute; aborting.');
  process.exit(1);
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
    }
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

const cdp = async (path, method = 'GET') => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixture(url.searchParams.get('v') ?? VARIANT));
  });
  server.listen(HTTP_PORT, '127.0.0.1');
  return server;
}

if (!existsSync(CHROME)) {
  console.error(`Chrome for Testing not found at:\n  ${CHROME}\nSet CHROME_BIN.`);
  process.exit(1);
}

rmSync(PROFILE, { recursive: true, force: true });
const server = serve();
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(HEADED ? [] : ['--headless=new']),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
  try {
    server.close();
  } catch {
    /* already closed */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  try {
    const v = await cdp('/json/version');
    ready = Boolean(v && v.webSocketDebuggerUrl);
  } catch {
    /* port not listening yet */
  }
  if (!ready) await sleep(250);
}
if (!ready) {
  console.error(`Chrome never opened a debugging port on ${PORT}.`);
  cleanup();
  process.exit(1);
}

const url = `http://127.0.0.1:${HTTP_PORT}/?v=${encodeURIComponent(VARIANT)}`;
await cdp(`/json/new?${encodeURIComponent(url)}`, 'PUT');
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = (await cdp('/json/list')).find((t) => t.url === url) ?? null;
}
if (!target) {
  console.error('fixture tab never appeared');
  cleanup();
  process.exit(1);
}
const session = new Session(target.webSocketDebuggerUrl);
await session.open();
await session.send('Runtime.enable');
await sleep(400);

const line = (s) => console.log(s);
const heading = (s) => console.log(`\n=== ${s} ===`);

line(`variant:   ${VARIANT}`);
line(`viewport:  ${VIEWPORT.width}x${VIEWPORT.height}`);
line(`url:       ${url}`);

// --- Q1: can overflow be scoped to one axis? ----------------------------
heading('CSS PROBE - overflow-x:hidden with overflow-y:visible');
const cssProbe = await session.eval(`(() => {
  const el = document.createElement('div');
  el.style.cssText = 'width:200px;height:200px;overflow-x:hidden;overflow-y:visible';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const out = { overflowX: cs.overflowX, overflowY: cs.overflowY };
  el.remove();
  return out;
})()`);
line(`declared:  overflow-x:hidden; overflow-y:visible`);
line(`computed:  overflow-x:${cssProbe.overflowX}; overflow-y:${cssProbe.overflowY}`);
line(
  cssProbe.overflowY === 'visible'
    ? 'VERDICT axis-scoped un-clip is possible: the visible axis stayed visible'
    : `VERDICT axis-scoped un-clip is IMPOSSIBLE: the visible axis computed to ` +
        `${cssProbe.overflowY}, which clips into a scroll region instead of painting outward`,
);

// --- Q2/Q3: what clips the drawer, and does expansion release it? --------
const DESCRIBE = `(() => {
  const ATTR = 'data-capture-kit-expand';
  const id = (el) => el === document.documentElement ? 'html'
    : el === document.body ? 'body'
    : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  const box = (el) => { const r = el.getBoundingClientRect(); return {
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    width: Math.round(r.width), height: Math.round(r.height) }; };
  const drawer = document.getElementById('drawer');
  const marked = Array.from(document.querySelectorAll('[' + ATTR + ']')).map((el) => {
    const cs = getComputedStyle(el);
    return {
      el: id(el),
      role: el.getAttribute(ATTR),
      overflowX: cs.overflowX, overflowY: cs.overflowY,
      height: cs.height, maxHeight: cs.maxHeight,
      box: box(el),
      containsDrawer: Boolean(drawer) && el.contains(drawer),
    };
  });
  const docEl = document.scrollingElement || document.documentElement;
  return {
    marked,
    doc: { scrollWidth: docEl.scrollWidth, scrollHeight: docEl.scrollHeight },
    drawer: drawer ? {
      position: getComputedStyle(drawer).position,
      left: getComputedStyle(drawer).left,
      right: getComputedStyle(drawer).right,
      top: getComputedStyle(drawer).top,
      width: getComputedStyle(drawer).width,
      height: getComputedStyle(drawer).height,
      transform: getComputedStyle(drawer).transform,
      box: box(drawer),
      offsetParent: drawer.offsetParent ? id(drawer.offsetParent) : null,
      clippingAncestors: (() => {
        const out = [];
        let n = drawer.parentElement;
        while (n) {
          const cs = getComputedStyle(n);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
            out.push({ el: id(n), overflowX: cs.overflowX, overflowY: cs.overflowY,
                       marked: n.getAttribute(ATTR), box: box(n) });
          }
          n = n.parentElement;
        }
        return out;
      })(),
    } : null,
  };
})()`;

heading('BASELINE - before any expansion');
const before = await session.eval(DESCRIBE);
line(`document:  ${before.doc.scrollWidth} x ${before.doc.scrollHeight}`);
line(`drawer:    position:${before.drawer.position} left:${before.drawer.left} ` +
  `right:${before.drawer.right} top:${before.drawer.top} width:${before.drawer.width} ` +
  `height:${before.drawer.height}`);
line(`           transform:${before.drawer.transform}`);
line(`           box ${JSON.stringify(before.drawer.box)}`);
line(`           offsetParent: ${before.drawer.offsetParent}`);
line('clipping ancestors of the drawer (nearest first):');
for (const a of before.drawer.clippingAncestors) {
  line(`  ${a.el.padEnd(10)} overflow-x:${a.overflowX} overflow-y:${a.overflowY} ` +
    `box ${JSON.stringify(a.box)}`);
}

heading('DETECT + EXPAND - the real innerScrollPage out of src');
const detect = await session.eval(`(() => { ${INNER_SCROLL_PAGE}
  return innerScrollPage('detect'); })()`);
line(`innerScrollPage('detect') -> ${JSON.stringify(detect)}`);
if (!detect.shouldExpand) {
  line('page does not have the inner-scroll shape; nothing further to measure');
  session.close();
  cleanup();
  process.exit(0);
}
const expand = await session.eval(`(() => { ${INNER_SCROLL_PAGE}
  return innerScrollPage('expand'); })()`);
line(`innerScrollPage('expand') -> ${JSON.stringify(expand)}`);
await sleep(300);

const styleText = await session.eval(
  `document.getElementById('__capture_kit_expand__')?.textContent ?? '(no stylesheet)'`,
);
line(`injected stylesheet:\n  ${styleText}`);

heading('AFTER EXPANSION');
const after = await session.eval(DESCRIBE);
line(`document:  ${after.doc.scrollWidth} x ${after.doc.scrollHeight}`);
line('marked elements:');
for (const m of after.marked) {
  line(`  ${m.el.padEnd(10)} role:${String(m.role).padEnd(8)} ` +
    `overflow-x:${m.overflowX} overflow-y:${m.overflowY} height:${m.height} ` +
    `box ${JSON.stringify(m.box)}`);
}
line(`drawer box after: ${JSON.stringify(after.drawer.box)}`);
line('clipping ancestors of the drawer after expansion (nearest first):');
if (after.drawer.clippingAncestors.length === 0) {
  line('  (none - every clip was released)');
}
for (const a of after.drawer.clippingAncestors) {
  line(`  ${a.el.padEnd(10)} overflow-x:${a.overflowX} overflow-y:${a.overflowY} ` +
    `marked:${a.marked} box ${JSON.stringify(a.box)}`);
}

// The condition under which a full-page capture paints the drawer: its box
// lands inside the document box and nothing above it still clips horizontally.
const insideDoc =
  after.drawer.box.right > 0 &&
  after.drawer.box.left < after.doc.scrollWidth &&
  after.drawer.box.bottom > 0 &&
  after.drawer.box.top < after.doc.scrollHeight;
const stillClipped = after.drawer.clippingAncestors.some(
  (a) => a.overflowX !== 'visible' && a.box.right <= after.drawer.box.left,
);
heading('VERDICT');
line(`drawer box inside the document box: ${insideDoc}`);
line(`a horizontal clip still hides it:   ${stillClipped}`);
line(
  insideDoc && !stillClipped
    ? 'LEAKS - the drawer is inside the captured document box and nothing clips it'
    : 'CLEAN - the drawer stays outside the captured content',
);

// Restore, so the probe leaves the page as it found it.
await session.eval(`(() => { ${INNER_SCROLL_PAGE}
  return innerScrollPage('restore'); })()`);
const restored = await session.eval(DESCRIBE);
line(`\nafter restore: document ${restored.doc.scrollWidth} x ${restored.doc.scrollHeight}, ` +
  `drawer box ${JSON.stringify(restored.drawer.box)}`);
line(
  JSON.stringify(restored.drawer.box) === JSON.stringify(before.drawer.box)
    ? 'restore returned the drawer to its baseline box'
    : 'RESTORE MISMATCH - the drawer did not return to its baseline box',
);

session.close();
cleanup();
process.exit(0);
