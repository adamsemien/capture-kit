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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'ck-unit-'));

const ENTRY = `
export { classifyEnvironment } from '${ROOT}/src/lib/env-marker.ts';
export { bandHeight, stampLabel } from '${ROOT}/src/lib/capture-engine/stamp.ts';
export { contextBlock, buildBundleMarkdown } from '${ROOT}/src/lib/bundle/markdown.ts';
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

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
