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
export { copiesFromPage, opensResultTab, clipboardText } from '${ROOT}/src/lib/clipboard-only.ts';
export { redactText, redactPage, redactedLabel, isJwt, REDACTED } from '${ROOT}/src/lib/redact.ts';
export { buildSessionIndex } from '${ROOT}/src/lib/session/manifest.ts';
export { decodeMappings, SourceMapIndex, parseSourceMap, cleanSourcePath, findSourceMapUrl, dataUrlText, parseFrame, formatFrame, FrameMapper, mapPageSources, sourceMapLabel } from '${ROOT}/src/lib/source-map.ts';
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

async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
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
  'ATTR_FB',
  'ATTR_IF',
  'FRAME_VAR',
  `return ${assignment[1]};`,
)(
  'data-capture-kit-expand',
  'data-capture-kit-expand-h',
  'data-capture-kit-expand-fb',
  'data-capture-kit-expand-frame',
  '--capture-kit-frame-h',
);

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

test('the column-item rule releases flex-basis and nothing else', () => {
  const rule = ruleFor('data-capture-kit-expand-fb');
  assert.match(rule, /flex-basis:auto/);
  // Width, height and overflow belong to the other rules; this one exists
  // only so a flex:1 1 0px item takes its size from its content.
  assert.ok(!/(^|[;{])\s*(width|height|overflow)/.test(rule), `fb rule must not touch other properties: ${rule}`);
});

test('embedded frames are held at their recorded height', () => {
  const rule = ruleFor('data-capture-kit-expand-frame]');
  assert.match(rule, /height:var\(--capture-kit-frame-h\) !important/);
});

heading('captureModeLabel - viewport heights held');

test('says when embedded frames were kept at screen height', () => {
  assert.equal(
    mod.captureModeLabel('expanded-inner-scroll', 0, 1, 0, 2, 1),
    'expanded inner scroll (2 scrollers, 1 embedded frame kept at screen height), single-shot',
  );
});

test('counts unrolled scrollers when there are several', () => {
  assert.equal(
    mod.captureModeLabel('expanded-inner-scroll', 0, 1, 0, 2),
    'expanded inner scroll (2 scrollers), single-shot',
  );
  assert.equal(mod.captureModeLabel('expanded-inner-scroll', 0, 1, 0, 1), 'expanded inner scroll, single-shot');
});

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

heading('straight to clipboard - when the page copies and when a tab opens');

const ON = { autoCopyImage: true, openResult: false };
test('shortcut and icon copy from the page when the tab is off', () => {
  assert.equal(mod.copiesFromPage(ON, 'shortcut'), true);
  assert.equal(mod.copiesFromPage(ON, 'icon'), true);
});

test('popup, agent, session and sweep never copy from the page', () => {
  for (const trigger of ['popup', 'agent', 'session', 'sweep']) {
    assert.equal(mod.copiesFromPage(ON, trigger), false, trigger);
  }
});

test('nothing copies from the page unless both settings ask for it', () => {
  assert.equal(mod.copiesFromPage({ autoCopyImage: false, openResult: false }, 'shortcut'), false);
  assert.equal(mod.copiesFromPage({ autoCopyImage: true, openResult: true }, 'shortcut'), false);
});

test('no tab opens after a page copy that landed', () => {
  assert.equal(mod.opensResultTab(ON, true), false);
});

test('a failed page copy opens the tab so the capture is not lost', () => {
  assert.equal(mod.opensResultTab(ON, false), true);
});

heading('clipboard - image only (NOBC-156)');
test('off: the report rides along with the image', () => {
  assert.equal(mod.clipboardText({ clipboardImageOnly: false }, '# report'), '# report');
});
test('on: the report stays off the clipboard', () => {
  assert.equal(mod.clipboardText({ clipboardImageOnly: true }, '# report'), undefined);
});
test('an empty report never goes on the clipboard either way', () => {
  assert.equal(mod.clipboardText({ clipboardImageOnly: false }, ''), undefined);
  assert.equal(mod.clipboardText({ clipboardImageOnly: false }, undefined), undefined);
});
test('image only never changes whether a copy happens or a tab opens', () => {
  const on = { autoCopyImage: true, openResult: false, clipboardImageOnly: true };
  assert.equal(mod.copiesFromPage(on, 'icon'), true);
  assert.equal(mod.opensResultTab(on, true), false);
});

test('with both settings off, no tab and no copy - as before', () => {
  assert.equal(mod.opensResultTab({ autoCopyImage: false, openResult: false }, false), false);
});

test('the tab always opens when asked for', () => {
  assert.equal(mod.opensResultTab({ autoCopyImage: false, openResult: true }, false), true);
  assert.equal(mod.opensResultTab({ autoCopyImage: true, openResult: true }, true), true);
});


// ------------------------------------------------------------- redact --
// Fake secrets are assembled at runtime so no credential-shaped literal sits
// in the repo for a secret scanner to flag. The AWS id is AWS's own
// documentation example.

const b64url = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const FAKE = {
  jwt: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'adam', iat: 1760000000 })}.c2lnbmF0dXJlLXRoYXQtaXMtZmFrZQ`,
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  bearer: 'Bearer ' + 'abc123DEF456ghi789JKL0',
  stripe: ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'),
};

heading('redact - the four the ticket names');
test('a JWT is replaced', () => {
  const r = mod.redactText(`token was ${FAKE.jwt} ok`);
  assert.equal(r.text, `token was ${mod.REDACTED} ok`);
  assert.equal(r.count, 1);
});
test('a JWT cut off by the message cap is still caught', () => {
  const cut = FAKE.jwt.split('.')[0] + '.' + FAKE.jwt.split('.')[1].slice(0, 6);
  assert.equal(mod.redactText(cut).count, 1);
});
test('base64 JSON that is not a JWT survives', () => {
  const imageParams = b64url({ width: 400, height: 300, fit: 'crop', src: 'avatar.png' });
  const url = `https://img.clerk.com/${imageParams}`;
  assert.equal(mod.redactText(url).text, url);
});
test('an AWS access key id is replaced', () => {
  assert.equal(mod.redactText(`key ${FAKE.aws} loaded`).text, `key ${mod.REDACTED} loaded`);
});
test('a Bearer header keeps its scheme and loses its value', () => {
  assert.equal(mod.redactText(`Authorization: ${FAKE.bearer}`).text, `Authorization: Bearer ${mod.REDACTED}`);
});
test('a Stripe-style live key is replaced', () => {
  assert.equal(mod.redactText(`stripe init ${FAKE.stripe}`).text, `stripe init ${mod.REDACTED}`);
});
test('all four in one message count as four', () => {
  const r = mod.redactText(`${FAKE.jwt} ${FAKE.aws} Authorization: ${FAKE.bearer} ${FAKE.stripe}`);
  assert.equal(r.count, 4);
  for (const value of [FAKE.jwt, FAKE.aws, FAKE.bearer.split(' ')[1], FAKE.stripe]) {
    assert.ok(!r.text.includes(value), `survived: ${value}`);
  }
});

heading('redact - by name');
test('a credential query value goes, the rest of the URL stays', () => {
  const r = mod.redactText('https://app.example.com/cb?access_token=abc123xyz&state=home#id_token=zzz999');
  assert.equal(r.text, `https://app.example.com/cb?access_token=${mod.REDACTED}&state=home#id_token=${mod.REDACTED}`);
  assert.equal(r.count, 2);
});
test('S3 signed URLs lose their signature and credential', () => {
  const r = mod.redactText('https://b.s3.amazonaws.com/f.png?X-Amz-Credential=ABC%2F2026&X-Amz-Signature=deadbeef&X-Amz-Expires=300');
  assert.match(r.text, /X-Amz-Credential=\[REDACTED\]&X-Amz-Signature=\[REDACTED\]&X-Amz-Expires=300/);
});
test('JSON password goes, author stays', () => {
  const r = mod.redactText('{"email":"a@b.co","password":"hunter2","author":"Adam"}');
  assert.equal(r.text, `{"email":"a@b.co","password":"${mod.REDACTED}","author":"Adam"}`);
});
test('a pasted cookie header goes as one value', () => {
  const r = mod.redactText('Cookie: sid=abc; theme=dark');
  assert.equal(r.text, `Cookie: ${mod.REDACTED}`);
  assert.equal(r.count, 1);
});
test('a pasted API key header goes', () => {
  assert.equal(mod.redactText('X-Api-Key: 9f8e7d6c5b4a3210').text, `X-Api-Key: ${mod.REDACTED}`);
});
test('a private key cut off before its END line goes', () => {
  const r = mod.redactText('loaded -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
  assert.equal(r.text, `loaded ${mod.REDACTED}`);
});

heading('redact - ordinary text survives');
for (const text of [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  'session_initializedSuccessfully',
  'Failed to set cookie: SameSite attribute missing',
  'GET https://api.example.com/v1/users?page=2&sort=name 500',
  'Token expired, refreshing',
  '{"author":"Adam","title":"Dinner"}',
  'https://app.thenobadcompany.com/operator/events/cmv8aygpl000006jke5kp3xxd/builder#rail-look',
]) {
  test(`untouched: ${text.slice(0, 50)}`, () => {
    const r = mod.redactText(text);
    assert.equal(r.text, text);
    assert.equal(r.count, 0);
  });
}
test('text that already says [REDACTED] is not counted again', () => {
  const once = mod.redactText(`a ${FAKE.stripe} b`).text;
  assert.equal(mod.redactText(once).count, 0);
});

heading('redactPage - one seam for every field');
test('URL, title, console message, call site and request URL are all scrubbed and counted', () => {
  const r = mod.redactPage({
    meta: { url: 'https://x.co/?token=aaa111', title: `Reset ${FAKE.aws}`, viewport: { width: 1, height: 1 }, userAgent: 'UA' },
    console: [{ level: 'error', message: `boom ${FAKE.jwt}`, source: 'https://x.co/app.js?sig=bbb222:1:2', timestamp: 1 }],
    network: [{ method: 'GET', url: `https://x.co/api?api_key=ccc333`, status: 401, durationMs: 5, timestamp: 2 }],
  });
  assert.equal(r.redacted, 5);
  assert.equal(r.meta.url, `https://x.co/?token=${mod.REDACTED}`);
  assert.equal(r.meta.userAgent, 'UA');
  assert.equal(r.console[0].level, 'error');
  assert.equal(r.network[0].status, 401);
  assert.ok(!JSON.stringify(r).includes('aaa111') && !JSON.stringify(r).includes('ccc333'));
});
test('the input record is not modified', () => {
  const console = [{ level: 'log', message: FAKE.stripe, timestamp: 1 }];
  mod.redactPage({ meta: { url: '', title: '', viewport: { width: 1, height: 1 }, userAgent: '' }, console, network: [] });
  assert.equal(console[0].message, FAKE.stripe);
});

heading('the Redacted line');
test('plural, singular and none, each with the screenshot caveat', () => {
  assert.match(mod.redactedLabel(3), /^3 values that looked like passwords, tokens or keys, shown as \[REDACTED\]\./);
  assert.match(mod.redactedLabel(1), /^1 value that/);
  assert.match(mod.redactedLabel(0), /^none found\./);
  for (const n of [0, 1, 3]) assert.match(mod.redactedLabel(n), /still in the screenshot/);
});
test('a page report prints it after the user agent', () => {
  const lines = mod.buildBundleMarkdown({ ...BUNDLE_INPUT, redacted: 2 }).split('\n');
  const ua = lines.findIndex((l) => l.startsWith('- **User agent:**'));
  assert.match(lines[ua + 1], /^- \*\*Redacted:\*\* 2 values/);
});
test('a report built without a count prints no line', () => {
  assert.ok(!mod.buildBundleMarkdown(BUNDLE_INPUT).includes('**Redacted:**'));
});
test('the session index states the total across pages', () => {
  const page = (redacted) => ({
    title: 't', url: 'https://x.co', contents: 'Contents: full-page image', imageFilename: 'a.jpg', markdownFilename: 'a.md',
    mirrorImageFilename: '01.jpg', mirrorMarkdownFilename: '01.md', errors: [], thirdPartyErrors: [], networkFailures: [],
    thirdPartyFailures: [], warningCount: 0, recorderActive: true, redacted,
  });
  const text = mod.buildSessionIndex({ capturedAt: new Date(), pages: [page(2), page(3)], failures: [], timings: [], totalMs: 1, cancelled: false });
  assert.match(text, /Redacted: 5 values/);
});


// ---------------------------------------------------- source maps (NOBC-153) --

heading('source maps - decoding');
test('a hand-made mappings string decodes to sorted segments per line', () => {
  // "AAAA,CAAC;AACD": line 0 -> (0 -> src0 L0 C0), (1 -> src0 L0 C1);
  // line 1 -> (0 -> src0 L1 C0). Only the generated column resets per line;
  // source index, original line and original column stay relative across lines.
  assert.deepEqual(mod.decodeMappings('AAAA,CAAC;AACD'), [
    [[0, 0, 0, 0], [1, 0, 0, 1]],
    [[0, 0, 1, 0]],
  ]);
});
test('segments without a source are dropped, names are skipped', () => {
  // "A" = generated column only; "AAAAA" carries a name index too.
  assert.deepEqual(mod.decodeMappings('A,CAAAA'), [[[1, 0, 0, 0]]]);
});
test('lookup takes the nearest segment at or before the column, 1-based in and out', () => {
  const index = new mod.SourceMapIndex({ sources: ['src/a.ts'], mappings: 'AAAA,KACE' });
  assert.deepEqual(index.lookup(1, 1), { file: 'src/a.ts', line: 1, column: 1 });
  assert.deepEqual(index.lookup(1, 5), { file: 'src/a.ts', line: 1, column: 1 });
  assert.deepEqual(index.lookup(1, 6), { file: 'src/a.ts', line: 2, column: 3 });
  assert.deepEqual(index.lookup(1, 99), { file: 'src/a.ts', line: 2, column: 3 });
  assert.equal(index.lookup(2, 1), null);
});
test('maps this module does not understand come back null', () => {
  assert.equal(mod.parseSourceMap('not json'), null);
  assert.equal(mod.parseSourceMap('{"version":3,"sections":[]}'), null);
  assert.equal(mod.parseSourceMap('{"version":3,"sources":[],"mappings":5}'), null);
  assert.ok(mod.parseSourceMap('{"version":3,"sources":["a.ts"],"mappings":"AAAA"}'));
});

heading('source maps - the real thing, built by esbuild');
const SRC = [
  "export function save(form) {",
  "  if (!form.title) {",
  "    throw new Error('boom');",
  "  }",
  "  return form;",
  "}",
].join('\n');
const built = await esbuild.build({
  stdin: { contents: SRC, sourcefile: 'src/components/EventForm.tsx', loader: 'ts', resolveDir: dir },
  bundle: true,
  minify: true,
  format: 'esm',
  sourcemap: 'external',
  write: false,
  outfile: join(dir, 'chunk-8f3a.js'),
});
const chunkJs = built.outputFiles.find((f) => f.path.endsWith('.js')).text;
const chunkMap = built.outputFiles.find((f) => f.path.endsWith('.map')).text;
test('a minified throw maps back to EventForm.tsx and the throw line', () => {
  const at = chunkJs.indexOf('Error(');
  assert.ok(at > 0, 'minified output has the throw');
  const before = chunkJs.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  const index = mod.parseSourceMap(chunkMap);
  const hit = index.lookup(line, column);
  assert.ok(hit, 'mapped');
  assert.match(hit.file, /src\/components\/EventForm\.tsx$/);
  assert.equal(hit.line, 3);
});

heading('source maps - finding the map');
const noHeaders = { get: () => null };
test('the SourceMap header wins over the comment', () => {
  const headers = { get: (n) => (n === 'SourceMap' ? 'maps/chunk.js.map' : null) };
  assert.equal(
    mod.findSourceMapUrl('https://x.co/static/chunk.js', headers, '//# sourceMappingURL=other.map'),
    'https://x.co/static/maps/chunk.js.map',
  );
});
test('a relative comment resolves against the script URL', () => {
  assert.equal(
    mod.findSourceMapUrl('https://x.co/static/chunk.js', noHeaders, 'var a=1;\n//# sourceMappingURL=chunk.js.map\n'),
    'https://x.co/static/chunk.js.map',
  );
});
test('a data: map is handed back as is', () => {
  const url = 'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==';
  assert.equal(mod.findSourceMapUrl('https://x.co/a.js', noHeaders, `//# sourceMappingURL=${url}`), url);
  assert.equal(mod.dataUrlText(url), '{"version":3}');
});
test('no header and no comment means no map', () => {
  assert.equal(mod.findSourceMapUrl('https://x.co/a.js', noHeaders, 'var a=1;'), null);
});
test('the comment is only read from the tail of a big script', () => {
  const big = '//# sourceMappingURL=early.map\n' + 'x'.repeat(10000);
  assert.equal(mod.findSourceMapUrl('https://x.co/a.js', noHeaders, big), null);
});

heading('source maps - paths and frames');
test('bundler prefixes and climbs are stripped from source paths', () => {
  assert.equal(mod.cleanSourcePath('webpack://_N_E/./src/app/page.tsx'), 'src/app/page.tsx');
  assert.equal(mod.cleanSourcePath('webpack:///./src/x.ts'), 'src/x.ts');
  assert.equal(mod.cleanSourcePath('../../src/lib/a.ts'), 'src/lib/a.ts');
  assert.equal(mod.cleanSourcePath('lib/a.ts', '../src/'), 'src/lib/a.ts');
  assert.equal(mod.cleanSourcePath('node_modules/react/index.js'), 'node_modules/react/index.js');
});
test('only http(s) url:line:col is a frame', () => {
  assert.deepEqual(mod.parseFrame('https://x.co/a.js?v=2:12:34'), { url: 'https://x.co/a.js?v=2', line: 12, column: 34 });
  assert.equal(mod.parseFrame('chrome-extension://abc/x.js:1:1'), null);
  assert.equal(mod.parseFrame('just text'), null);
});
test('a frame prints its verdict either way', () => {
  assert.equal(mod.formatFrame('https://x.co/static/chunk-8f3a.js:1:48213', null), 'https://x.co/static/chunk-8f3a.js:1:48213 (no source map)');
  assert.equal(
    mod.formatFrame('https://x.co/static/chunk-8f3a.js?v=9:1:48213', { file: 'src/EventForm.tsx', line: 84, column: 12 }),
    'src/EventForm.tsx:84:12 (mapped from chunk-8f3a.js:1:48213)',
  );
});

heading('source maps - the pass over a page record');
const SCRIPT_URL = 'https://preview.example.com/_next/static/chunks/chunk-8f3a.js';
const makeFetch = (log) => async (url) => {
  log.push(url);
  if (url === SCRIPT_URL) return { ok: true, headers: noHeaders, text: async () => chunkJs + '\n//# sourceMappingURL=chunk-8f3a.js.map\n' };
  if (url === SCRIPT_URL + '.map') return { ok: true, headers: noHeaders, text: async () => chunkMap };
  return { ok: false, headers: noHeaders, text: async () => '' };
};
const throwAt = (() => {
  const at = chunkJs.indexOf('Error(');
  const before = chunkJs.slice(0, at);
  return `${SCRIPT_URL}:${before.split('\n').length}:${at - before.lastIndexOf('\n')}`;
})();
const PAGE = (sources) => ({
  meta: { url: 'https://preview.example.com/events', title: 'Events', viewport: { width: 1, height: 1 }, userAgent: 'UA' },
  console: [
    { level: 'error', message: `Uncaught Error: boom\n    at save (${throwAt})\n    at https://cdn.other.com/lib.js:3:4`, source: throwAt, timestamp: 1 },
    { level: 'warn', message: 'plain warning', source: 'chrome-extension://abc/x.js:1:1', timestamp: 2 },
  ],
  network: [{ method: 'GET', url: `${SCRIPT_URL}:1:1`, status: 404, durationMs: 1, timestamp: 3 }],
});
await atest('call sites and stack lines are mapped, tagged and counted; one fetch per script', async () => {
  const log = [];
  const out = await mod.mapPageSources(PAGE(), new mod.FrameMapper({ fetch: makeFetch(log) }));
  assert.equal(out.frames, 3);
  assert.equal(out.mappedFrames, 2);
  assert.match(out.console[0].source, /^src\/components\/EventForm\.tsx:3:\d+ \(mapped from chunk-8f3a\.js:\d+:\d+\)$/);
  assert.match(out.console[0].message, /at save \(src\/components\/EventForm\.tsx:3:\d+ \(mapped from chunk-8f3a\.js:\d+:\d+\)\)/);
  assert.match(out.console[0].message, /at https:\/\/cdn\.other\.com\/lib\.js:3:4 \(no source map\)/);
  assert.equal(out.console[1].source, 'chrome-extension://abc/x.js:1:1');
  assert.equal(out.console[1].message, 'plain warning');
  assert.deepEqual(out.network, PAGE().network);
  assert.equal(log.filter((u) => u === SCRIPT_URL).length, 1, 'script fetched once');
  assert.equal(log.filter((u) => u === SCRIPT_URL + '.map').length, 1, 'map fetched once');
});
await atest('a fetch that throws leaves every frame raw and the capture alive', async () => {
  const mapper = new mod.FrameMapper({ fetch: async () => { throw new Error('offline'); } });
  const out = await mod.mapPageSources(PAGE(), mapper);
  assert.equal(out.frames, 3);
  assert.equal(out.mappedFrames, 0);
  assert.equal(out.console[0].source, `${throwAt} (no source map)`);
});
await atest('the script cap leaves later scripts raw', async () => {
  const mapper = new mod.FrameMapper({ fetch: makeFetch([]), maxScripts: 0 });
  const out = await mod.mapPageSources(PAGE(), mapper);
  assert.equal(out.mappedFrames, 0);
});
await atest('the input record is not modified', async () => {
  const page = PAGE();
  const before = JSON.stringify(page);
  await mod.mapPageSources(page, new mod.FrameMapper({ fetch: makeFetch([]) }));
  assert.equal(JSON.stringify(page), before);
});

heading('source maps - the report line');
test('no frames, no line; otherwise the count and what happened to the rest', () => {
  assert.equal(mod.sourceMapLabel(0, 0), null);
  assert.match(mod.sourceMapLabel(3, 0), /^none of 3 frames had a source map/);
  assert.match(mod.sourceMapLabel(1, 1), /^all 1 frame mapped to the original file and line\.$/);
  assert.match(mod.sourceMapLabel(3, 3), /^all 3 frames mapped/);
  assert.match(mod.sourceMapLabel(5, 2), /^2 of 5 frames mapped to the original file and line; the rest/);
});
test('the context block prints it after Redacted, and only when there were frames', () => {
  const withFrames = mod.buildBundleMarkdown({ ...BUNDLE_INPUT, redacted: 0, sourceMaps: { frames: 2, mapped: 1 } }).split('\n');
  const r = withFrames.findIndex((l) => l.startsWith('- **Redacted:**'));
  assert.match(withFrames[r + 1], /^- \*\*Source maps:\*\* 1 of 2 frames mapped/);
  assert.ok(!mod.buildBundleMarkdown({ ...BUNDLE_INPUT, sourceMaps: { frames: 0, mapped: 0 } }).includes('**Source maps:**'));
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
