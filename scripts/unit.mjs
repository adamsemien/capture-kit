// Pure-function checks for the parts of this round that have no browser in
// them: environment classification, the footer's band arithmetic, and the
// report's context block.
//
//   npm test
//
// No test framework and no new dependency. esbuild (already here for the
// build) bundles the modules under test into one ESM file in a temp dir; the
// assertions are node:assert. Anything needing a real Chrome lives in
// scripts/acceptance.mjs instead.

import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'ck-unit-'));

const ENTRY = `
export { classifyEnvironment } from '${ROOT}/src/lib/env-marker.ts';
export { bandHeight, stampLabel } from '${ROOT}/src/lib/capture-engine/stamp.ts';
export { readEncodedImageSize } from '${ROOT}/src/lib/capture-engine/image-size.ts';
export { contextBlock, buildBundleMarkdown, captureModeLabel, withLatestNotice, LATEST_NOTICE, OUTPUT_README } from '${ROOT}/src/lib/bundle/markdown.ts';
export { planScrollOffsets } from '${ROOT}/src/lib/capture-engine/segments.ts';
export { CAPTURE_TRIGGER_LABEL } from '${ROOT}/src/lib/messages.ts';
`;

const entryPath = join(dir, 'entry.ts');
writeFileSync(entryPath, ENTRY);
const outfile = join(dir, 'bundle.mjs');
await esbuild.build({
  entryPoints: [entryPath],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message.split('\n').join('\n      ')}`);
  }
}

function heading(text) {
  console.log(`\n${text}`);
}

// ------------------------------------------------- classifyEnvironment --

heading('classifyEnvironment — local');
for (const url of [
  'http://localhost:3000/dash',
  'https://app.localhost/x',
  'http://127.0.0.1:8765/?n=1',
  'http://127.0.0.53/health',
  'http://[::1]:5173/',
  'http://0.0.0.0:8080/',
  'http://mac-studio.local/preview',
  'file:///Users/adam/build/index.html',
  'http://192.168.1.42:3000/',
  'http://10.0.0.7/',
  'http://172.16.0.9/',
  'http://172.31.255.254/',
]) {
  test(url, () => assert.equal(mod.classifyEnvironment(url).kind, 'local'));
}

heading('classifyEnvironment — deployed');
for (const url of [
  'https://example.com/',
  'https://app.example.com/dash?q=1',
  'http://172.15.0.1/', // just below the private block
  'http://172.32.0.1/', // just above it
  'http://192.169.1.1/',
  'http://11.0.0.1/',
  'https://notlocalhost.com/',
  'https://localhost.example.com/', // suffix must be the whole label
  'https://my.local.example.com/',
]) {
  test(url, () => assert.equal(mod.classifyEnvironment(url).kind, 'deployed'));
}

heading('classifyEnvironment — edge cases');
test('empty URL is deployed, and says so', () => {
  const m = mod.classifyEnvironment('');
  assert.equal(m.kind, 'deployed');
  assert.match(m.label, /no URL/);
});
test('unparseable URL is deployed and carries the raw string', () => {
  const m = mod.classifyEnvironment('not a url at all');
  assert.equal(m.kind, 'deployed');
  assert.match(m.label, /not a url at all/);
});
test('label names the host', () => {
  assert.equal(mod.classifyEnvironment('http://localhost:3000/x').label, 'local (localhost:3000)');
  assert.equal(mod.classifyEnvironment('https://example.com/x').label, 'deployed (example.com)');
});

// ------------------------------------------------------------ bandHeight --

heading('bandHeight — clamped, proportional');
test('narrow images get the 22px floor', () => assert.equal(mod.bandHeight(375), 22));
test('1512px → 27px', () => assert.equal(mod.bandHeight(1512), 27));
test('wide images get the 40px ceiling', () => assert.equal(mod.bandHeight(4000), 40));
test('monotonic across the range', () => {
  let previous = 0;
  for (let w = 100; w <= 5000; w += 50) {
    const h = mod.bandHeight(w);
    assert.ok(h >= previous, `bandHeight(${w}) = ${h} dropped below ${previous}`);
    assert.ok(h >= 22 && h <= 40, `bandHeight(${w}) = ${h} out of range`);
    previous = h;
  }
});

heading('readEncodedImageSize');
test('reads PNG dimensions from the IHDR header', () => {
  // 1×1 PNG, 2×3 patched into IHDR to prove the bytes are being read.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  png.writeUInt32BE(7, 16);
  png.writeUInt32BE(11, 20);
  assert.deepEqual(mod.readEncodedImageSize(png.toString('base64'), 'png'), { width: 7, height: 11 });
});
test('unreadable bytes return null rather than a guess', () => {
  assert.equal(mod.readEncodedImageSize('bm90YW5pbWFnZQ==', 'png'), null);
  assert.equal(mod.readEncodedImageSize('bm90YW5pbWFnZQ==', 'jpeg'), null);
});

heading('stampLabel');
test('absent stamp reads off', () => assert.equal(mod.stampLabel(undefined), 'off'));
test('extended names the height', () =>
  assert.match(mod.stampLabel({ mode: 'extended', height: 27 }), /^on — 27px footer appended/));
test('overlaid says it covered content', () =>
  assert.match(mod.stampLabel({ mode: 'overlaid', height: 40 }), /overlaid/));

// ---------------------------------------------------------- contextBlock --

const BLOCK_INPUT = {
  url: 'http://localhost:3000/dash',
  title: 'Dashboard',
  capturedAt: new Date('2026-08-23T18:12:04.881Z'),
  viewport: { width: 1512, height: 860 },
  contentSize: { width: 1512, height: 4210 },
  imageSize: { width: 1512, height: 4237 },
  captureMode: 'standard, segmented, 3 segments',
  trigger: 'icon',
  recorderActive: true,
  stamp: { mode: 'extended', height: 27 },
  userAgent: 'Mozilla/5.0 (test)',
};

heading('contextBlock');
test('URL is the first line and Environment the second', () => {
  const lines = mod.contextBlock(BLOCK_INPUT);
  assert.match(lines[0], /^- \*\*URL:\*\* http:\/\/localhost:3000\/dash$/);
  assert.match(lines[1], /^- \*\*Environment:\*\* local \(localhost:3000\)$/);
});
test('names the trigger in words, not a boolean', () => {
  const text = mod.contextBlock(BLOCK_INPUT).join('\n');
  assert.ok(text.includes(`- **Triggered by:** ${mod.CAPTURE_TRIGGER_LABEL.icon}`));
});
test('image-file size differs from full-page size when stamped', () => {
  const text = mod.contextBlock(BLOCK_INPUT).join('\n');
  assert.ok(text.includes('- **Full page:** 1512×4210'));
  assert.ok(text.includes('- **Image file:** 1512×4237'));
});
test('every field appears exactly once', () => {
  const text = mod.contextBlock(BLOCK_INPUT).join('\n');
  for (const field of [
    'URL:',
    'Environment:',
    'Viewport:',
    'Full page:',
    'Image file:',
    'Captured at:',
    'Capture mode:',
    'Triggered by:',
    'URL stamp:',
    'Recorder:',
    'Title:',
    'User agent:',
  ]) {
    const count = text.split(`**${field}**`).length - 1;
    assert.equal(count, 1, `${field} appears ${count} times`);
  }
});
test('no Relayout line when the captured layout is the on-screen one', () => {
  const text = mod.contextBlock(BLOCK_INPUT).join('\n');
  assert.ok(!text.includes('Relayout'));
});
test('Relayout line appears, and names both layouts, when they differ', () => {
  const text = mod
    .contextBlock({ ...BLOCK_INPUT, naturalSize: { width: 1608, height: 5578 } })
    .join('\n');
  assert.match(text, /- \*\*Relayout:\*\*/);
  assert.ok(text.includes('1608×5578'), 'pre-override layout not named');
  assert.ok(text.includes('1512×4210'), 'captured layout not named');
});
test('identical naturalSize does not trigger the Relayout line', () => {
  const text = mod
    .contextBlock({ ...BLOCK_INPUT, naturalSize: { width: 1512, height: 4210 } })
    .join('\n');
  assert.ok(!text.includes('Relayout'));
});
heading('pixel scale and browser zoom');
test('no Pixel scale line at 1:1', () => {
  assert.ok(!mod.contextBlock(BLOCK_INPUT).join('\n').includes('Pixel scale'));
});
test('Pixel scale line names the ratio on a high-DPI single shot', () => {
  const text = mod
    .contextBlock({
      ...BLOCK_INPUT,
      contentSize: { width: 1200, height: 5520 },
      imageSize: { width: 2400, height: 11040 },
      stamp: undefined,
    })
    .join('\n');
  assert.match(text, /- \*\*Pixel scale:\*\* 2×/);
});
test('no Browser zoom line at 100%', () => {
  const text = mod.contextBlock({ ...BLOCK_INPUT, browserZoom: 1 }).join('\n');
  assert.ok(!text.includes('Browser zoom'));
});
test('Browser zoom line states the tab zoom and that capture was at 100%', () => {
  const text = mod.contextBlock({ ...BLOCK_INPUT, browserZoom: 0.25 }).join('\n');
  assert.match(text, /- \*\*Browser zoom:\*\* the tab was at 25%/);
  assert.match(text, /captured at 100%|capture was taken at 100%/);
});

test('recorder-inactive wording is unmistakable', () => {
  const text = mod.contextBlock({ ...BLOCK_INPUT, recorderActive: false }).join('\n');
  assert.match(text, /NOT ACTIVE for this page/);
});

// ------------------------------------------------------ full page report --

const BUNDLE_INPUT = {
  meta: {
    url: 'https://app.example.com/dash',
    title: 'Dashboard',
    viewport: { width: 1512, height: 860 },
    userAgent: 'Mozilla/5.0 (test)',
  },
  contentSize: { width: 1512, height: 4210 },
  fullSize: { width: 1512, height: 4210 },
  imageSize: { width: 1512, height: 4210 },
  truncated: false,
  consoleEntries: [],
  networkFailures: [],
  recorderActive: true,
  includeLogs: true,
  capturedAt: new Date('2026-08-23T18:12:04.881Z'),
  imageFilename: 'dashboard_2026-08-23_18-12.jpg',
  captureMode: 'standard',
  revealForced: 0,
  segments: 1,
  trigger: 'shortcut',
};

heading('buildBundleMarkdown');
test('H1 is line 1 and the context block is the first content block', () => {
  const lines = mod.buildBundleMarkdown(BUNDLE_INPUT).split('\n');
  assert.match(lines[0], /^# Capture — Dashboard$/);
  assert.equal(lines[1], '');
  assert.match(lines[2], /^Image: /);
  assert.match(lines[3], /^Contents: /);
  assert.match(lines[4], /^- \*\*URL:\*\* /);
  assert.match(lines[5], /^- \*\*Environment:\*\* deployed \(app\.example\.com\)/);
});
test('the context block precedes every console section', () => {
  const text = mod.buildBundleMarkdown(BUNDLE_INPUT);
  assert.ok(text.indexOf('- **Environment:**') < text.indexOf('## Console'));
});
test('URL stamp reads off when nothing was stamped', () => {
  assert.ok(mod.buildBundleMarkdown(BUNDLE_INPUT).includes('- **URL stamp:** off'));
});

// ------------------------------------------------ segmented grid coverage --
//
// The black-right-column defect was a planning bug: the grid was laid out
// against a viewport that did not exist. These lock the invariant that matters
// — whatever viewport is passed, the offsets must cover the whole extent.

heading('planScrollOffsets — full coverage, no gaps');
function coversFully(total, viewport) {
  const offsets = mod.planScrollOffsets(total, viewport);
  let reach = 0;
  for (const o of offsets) {
    if (o > reach) return { ok: false, gapAt: reach, offsets };
    reach = Math.max(reach, o + viewport);
  }
  return { ok: reach >= total, reach, offsets };
}
test('viewport narrower than content tiles without gaps', () => {
  for (const [total, viewport] of [
    [2016, 1608], // the reproduced case: canvas 2016, real viewport 1608
    [2293, 1871], // Adam's numbers
    [5544, 2048],
    [1000, 300],
    [1001, 1000],
  ]) {
    const r = coversFully(total, viewport);
    assert.ok(r.ok, `total ${total} viewport ${viewport} → ${JSON.stringify(r)}`);
  }
});
test('the old buggy planning width leaves the right edge uncovered', () => {
  // What the code used to do: plan against min(remeasured, segmentSize) rather
  // than the override actually in force. One offset, 1608px of real viewport,
  // 2016px of canvas — 408px never reached. This is the regression guard.
  assert.deepEqual(mod.planScrollOffsets(2016, 2016), [0]);
  const covered = coversFully(2016, 1608);
  assert.deepEqual(covered.offsets, [0, 408]);
  assert.ok(covered.ok);
});
test('viewport at least the content is a single offset', () => {
  assert.deepEqual(mod.planScrollOffsets(800, 800), [0]);
  assert.deepEqual(mod.planScrollOffsets(800, 1200), [0]);
});

// --------------------------------------------------------- latest.* notice --

heading('withLatestNotice');
test('sits immediately under the H1', () => {
  const out = mod.withLatestNotice('# Capture — Thing\n\nImage: a.jpg\nContents: x\n');
  const lines = out.split('\n');
  assert.equal(lines[0], '# Capture — Thing');
  assert.equal(lines[1], '');
  assert.equal(lines[2], mod.LATEST_NOTICE);
  assert.equal(lines[3], '');
  assert.equal(lines[4], 'Image: a.jpg');
});
test('the rest of the report is untouched', () => {
  const body = '# H\n\nrest\n\n## Console\n\nnone\n';
  assert.ok(mod.withLatestNotice(body).endsWith('rest\n\n## Console\n\nnone\n'));
});
test('a report with no heading still gets the notice', () => {
  assert.ok(mod.withLatestNotice('no heading here').startsWith(mod.LATEST_NOTICE));
});
test('applied to a real report, the H1 stays line 1', () => {
  const lines = mod.withLatestNotice(mod.buildBundleMarkdown(BUNDLE_INPUT)).split('\n');
  assert.match(lines[0], /^# Capture — Dashboard$/);
  assert.equal(lines[2], mod.LATEST_NOTICE);
});

heading('OUTPUT_README');
test('names every artefact kind the folder can hold', () => {
  for (const needle of ['latest.jpg', 'latest.md', 'session_', '_sweep.md', '.jpg', '.md']) {
    assert.ok(mod.OUTPUT_README.includes(needle), `missing ${needle}`);
  }
});
test('says latest.* is the stable path for an assistant', () => {
  assert.match(mod.OUTPUT_README, /stable path to point an AI assistant at/);
});
test('is plain text, not markdown', () => {
  assert.ok(!/^#|\*\*/m.test(mod.OUTPUT_README));
});

/**
 * The stylesheet innerScrollPage injects, evaluated rather than eyeballed.
 *
 * innerScrollPage is not exported - it is serialized into the page by
 * chrome.scripting.executeScript, so it has to stay self-contained - and the
 * assignment is a chain of template literals interpolating ATTR/ATTR_H. So the
 * file is de-typed with esbuild (already a dependency), the assignment
 * expression is lifted out, and it is evaluated with those two names bound.
 * What comes back is the literal CSS the extension puts on the page.
 *
 * This is leak 1's regression guard. The whole fix is that the ancestor rule
 * carries no `overflow` declaration: an ancestor at height:auto grows to
 * contain the expanded scroller, so its own overflow:hidden clips nothing on
 * the scroll axis, while still clipping an off-canvas sibling on the cross
 * axis. Put `overflow` back on that rule and NOBC-82 is reopened.
 */
heading('innerScrollPage injected stylesheet');
const innerScrollJs = (
  await esbuild.transform(readFileSync(`${ROOT}/src/lib/capture-engine/inner-scroll.ts`, 'utf8'), {
    loader: 'ts',
    format: 'esm',
  })
).code;
const assignment = /styleEl\.textContent\s*=\s*([\s\S]*?);\n/.exec(innerScrollJs);
assert.ok(assignment, 'could not find the styleEl.textContent assignment after de-typing');
const injectedCss = new Function(
  'ATTR',
  'ATTR_H',
  `return ${assignment[1]};`,
)('data-capture-kit-expand', 'data-capture-kit-expand-h');

/** One rule body by selector substring, e.g. `="ancestor"`. */
function ruleFor(selectorPart) {
  const rule = injectedCss
    .split('}')
    .map((s) => s + '}')
    .find((s) => s.includes(selectorPart));
  assert.ok(rule, `no rule in the injected stylesheet matched ${selectorPart}`);
  return rule;
}

test('the scroller rule releases its own overflow', () => {
  const rule = ruleFor('="scroller"');
  assert.match(rule, /overflow:visible/);
  assert.match(rule, /height:auto/);
  assert.match(rule, /max-height:none/);
});

test('the ancestor rule carries no overflow declaration', () => {
  const rule = ruleFor('="ancestor"');
  assert.ok(
    !/overflow/.test(rule),
    `ancestor rule must not touch overflow, got: ${rule}`,
  );
});

test('the ancestor rule still releases height', () => {
  const rule = ruleFor('="ancestor"');
  assert.match(rule, /height:auto/);
  assert.match(rule, /max-height:none/);
});

test('the horizontal rule releases width for both roles', () => {
  const rule = ruleFor('data-capture-kit-expand-h');
  assert.match(rule, /width:auto/);
  assert.match(rule, /max-width:none/);
  // Unscoped by role on purpose: a horizontal scroller and its ancestors both
  // need the width release, and neither needs an overflow change to get it.
  assert.ok(!/="(scroller|ancestor)"/.test(rule), `horizontal rule must stay role-agnostic: ${rule}`);
});

heading('captureModeLabel - viewport heights held');

test('names the hold with its count on a segmented capture', () => {
  assert.equal(
    mod.captureModeLabel('standard', 0, 2, 6),
    'standard, segmented, 2 segments + viewport heights held (6 elements)',
  );
});

test('says nothing about the hold when nothing was held', () => {
  assert.equal(mod.captureModeLabel('standard', 0, 1, 0), 'standard, single-shot');
  assert.equal(mod.captureModeLabel('standard', 0, 1), 'standard, single-shot');
});

test('keeps reveal-forced ahead of the hold', () => {
  assert.equal(
    mod.captureModeLabel('expanded-inner-scroll', 17, 3, 2),
    'expanded inner scroll, segmented, 3 segments + reveal-forced (17 elements)' +
      ' + viewport heights held (2 elements)',
  );
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
