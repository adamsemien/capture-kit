// Diagnostic only — not part of the extension, not part of the build.
//
//   node scripts/probe-reveal.mjs > /tmp/ck-probe.js
//
// Emits a console probe that runs THE REAL capture pipeline stages against the
// current page and tracks specific elements through them.
//
// Every pipeline script is extracted from source rather than retyped:
//   - the template-literal scripts out of cdp-fullpage.ts, byte-for-byte
//   - innerScrollPage() out of inner-scroll.ts, TS->JS via esbuild
// so the probe cannot drift from the code it probes.
//
// Two corrections over the previous version, both from probe v1/v2 failures:
//
//   1. v2 started at captureAttached. It missed applyInnerScrollExpansion,
//      which runs BEFORE it (InnerScrollExpansionStrategy.capture) and sets
//      overflow:visible on every ancestor of the dominant scroller. On a page
//      that "does not scroll" that stage is selected, and it is the stage that
//      can un-clip off-canvas UI. Stage S1 below.
//
//   2. v2's visible() test asked display/visibility/opacity + a box, so an
//      element parked off-canvas at translateX(100%) counted as visible in the
//      baseline and could never show up as newly-visible later. This version
//      tracks named elements through the stages and asks whether their box
//      lands inside the DOCUMENT box and survives ancestor clipping — the
//      question a full-page capture actually answers.
//
// Stages, in the order the real pipeline runs them:
//   S0  baseline
//   S1  + innerScrollPage('expand')   [only if detect says the page has the shape]
//   S2  + FREEZE_SCRIPT
//   S3  + reveal scroll pass
//   S4  + FORCE_REVEAL_SCRIPT
//   S5  + UNSTICK_SCRIPT
// then restored in reverse with the real RESTICK / UNFORCE / UNFREEZE /
// innerScrollPage('restore').

import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cdpSrc = read('../src/lib/capture-engine/cdp-fullpage.ts');
const innerSrc = read('../src/lib/capture-engine/inner-scroll.ts');

/** Pull `const NAME = ` + backtick template literal out of the source verbatim. */
function extractScript(name) {
  const open = cdpSrc.indexOf('const ' + name + ' = `');
  if (open < 0) throw new Error(`could not find ${name} in cdp-fullpage.ts`);
  const start = cdpSrc.indexOf('`', open) + 1;
  const end = cdpSrc.indexOf('`', start);
  if (end < 0) throw new Error(`unterminated template literal for ${name}`);
  const body = cdpSrc.slice(start, end);
  if (body.includes('${')) throw new Error(`${name} interpolates; extraction is unsafe`);
  return body;
}

/**
 * innerScrollPage is a TS function, not a template literal. Extracted by brace
 * matching and de-typed with esbuild rather than by hand — hand-stripping type
 * annotations is exactly the kind of retyping that produced probe v1.
 */
function extractInnerScrollPage() {
  // De-type the WHOLE file first. Brace-matching the TypeScript directly
  // catches the return-type annotation `: { shouldExpand: boolean }` instead
  // of the function body; in the emitted JS that annotation is gone, so the
  // first `{` after the parameter list really is the body.
  const js = transformSync(innerSrc, { loader: 'ts', format: 'esm' }).code;
  const open = js.indexOf('function innerScrollPage(');
  if (open < 0) throw new Error('could not find innerScrollPage after de-typing');
  let i = js.indexOf('{', js.indexOf(')', open));
  let depth = 0;
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) break;
  }
  const fn = js.slice(open, i + 1);
  // The stylesheet this function injects is the thing under investigation; if
  // it is not in the extracted text, the extraction silently lost the body.
  if (!fn.includes('overflow:visible')) throw new Error('innerScrollPage body did not survive extraction');
  return fn;
}

const FREEZE = extractScript('FREEZE_SCRIPT');
const UNFREEZE = extractScript('UNFREEZE_SCRIPT');
const FORCE_REVEAL = extractScript('FORCE_REVEAL_SCRIPT');
const UNFORCE_REVEAL = extractScript('UNFORCE_REVEAL_SCRIPT');
const UNSTICK = extractScript('UNSTICK_SCRIPT');
const RESTICK = extractScript('RESTICK_SCRIPT');
const INNER_SCROLL_FN = extractInnerScrollPage();

const settle = /const REVEAL_SETTLE_MS = (\d+)/.exec(cdpSrc)?.[1] ?? '90';
const maxSteps = /const MAX_REVEAL_STEPS = (\d+)/.exec(cdpSrc)?.[1] ?? '30';

const probe = `// capture-kit pipeline probe — generated from source, do not hand-edit.
// Paste into the DevTools console on the affected page, drawer CLOSED.
// Optionally pin the element first:  window.__ckDrawer = '<css selector>'
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (src) => (0, eval)(src);
  const scroll0 = { x: window.scrollX, y: window.scrollY };
  ${INNER_SCROLL_FN}

  const label = (el) => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    ((el.className + '').trim() ? '.' + (el.className + '').trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const num = (n) => Math.round(n);
  const docBox = () => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  });
  // Document coordinates — what a full-page capture paints in.
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
  };

  // The effective clip an element inherits from ancestors that do not overflow
  // visibly. Intersected in document coordinates. This is the test v2 lacked.
  const clipOf = (el) => {
    let box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    const clippers = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      let cs; try { cs = getComputedStyle(n); } catch { break; }
      const clips = cs.overflow !== 'visible' || cs.clipPath !== 'none' ||
        /paint|strict|content/.test(cs.contain || '');
      if (!clips) continue;
      const r = docRect(n);
      clippers.push({ el: label(n), overflow: cs.overflow, clipPath: cs.clipPath, contain: cs.contain || '',
        box: num(r.width) + 'x' + num(r.height) + ' @' + num(r.left) + ',' + num(r.top) });
      box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top),
              r: Math.min(box.r, r.left + r.width), b: Math.min(box.b, r.top + r.height) };
    }
    return { box, clippers };
  };

  /** Would this element paint, and where, in a full-page capture right now? */
  const paintState = (el) => {
    let cs; try { cs = getComputedStyle(el); } catch { return { error: 'no computed style' }; }
    const r = docRect(el);
    const { box, clippers } = clipOf(el);
    const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
    const hasBox = r.width > 0 && r.height > 0;
    const d = docBox();
    const clippedW = Math.max(0, Math.min(r.left + r.width, box.r, d.w) - Math.max(r.left, box.l, 0));
    const clippedH = Math.max(0, Math.min(r.top + r.height, box.b, d.h) - Math.max(r.top, box.t, 0));
    return {
      painted: vis && hasBox && clippedW > 4 && clippedH > 4,
      visibleProps: vis,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 44),
      docRect: num(r.width) + 'x' + num(r.height) + ' @' + num(r.left) + ',' + num(r.top),
      paintedArea: num(clippedW) + 'x' + num(clippedH),
      offCanvasRight: r.left >= d.w - 4,
      position: cs.position,
      transform: cs.transform === 'none' ? 'none' : cs.transform.slice(0, 32),
      translate: cs.translate || 'none',
      inset: [cs.top, cs.right, cs.bottom, cs.left].join(' '),
      size: [cs.width, cs.height, cs.maxWidth, cs.maxHeight].join(' / '),
      overflow: cs.overflow,
      zIndex: cs.zIndex,
      closedMarker: (() => {
        const m = (n) => n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden') ||
          n.hasAttribute('inert') || (n.tagName === 'DIALOG' && !n.hasAttribute('open'));
        for (let n = el; n; n = n.parentElement) if (m(n)) return n === el ? 'self' : 'ancestor ' + label(n);
        for (const c of document.querySelectorAll('[aria-controls][aria-expanded="false"]'))
          for (const id of (c.getAttribute('aria-controls') || '').split(/\\s+/)) {
            const t = id && document.getElementById(id);
            if (t && (t === el || t.contains(el))) return 'aria-expanded via ' + label(c);
          }
        return 'NONE';
      })(),
      forceRevealMarked: el.hasAttribute('data-capture-kit-force-reveal'),
      unstickKind: el.getAttribute('data-capture-kit-position') || '',
      expandAttr: el.getAttribute('data-capture-kit-expand') || '',
      clippers,
    };
  };

  // ---- candidate identification -----------------------------------------
  // "Concealed" is the paint test, not a geometry guess: the element has a
  // box but nothing of it survives clipping, or its own properties hide it.
  //
  // The split below matters. Content scrolled out of view INSIDE the dominant
  // scroller is concealed at baseline too, and expansion revealing it is the
  // whole point of the strategy — not a defect. Tracking it floods the list
  // (measured: 8 anonymous rows, drawer crowded out entirely). So the
  // side-effect arm excludes scroller descendants, and a second arm catches
  // property-hidden elements anywhere, which is where a lazy/faded block
  // lives.
  //
  // Identifying the scroller needs a dry expand/restore, since only the
  // expanded DOM carries the marker.
  let scrollerEl = null;
  {
    const dry = innerScrollPage('detect');
    if (dry.shouldExpand) {
      innerScrollPage('expand');
      scrollerEl = document.querySelector('[data-capture-kit-expand="scroller"]');
      innerScrollPage('restore');
    }
  }
  const insideScroller = (el) => Boolean(scrollerEl && scrollerEl !== el && scrollerEl.contains(el));

  const NAMED = '[role=dialog],[role=complementary],[aria-modal],[data-state],' +
    '[class*=drawer i],[class*=Drawer],[class*=panel i],[class*=Panel],' +
    '[class*=chat i],[class*=Chat],[class*=sheet i],[class*=Sheet],[aria-label*=chat i]';

  const big = [...document.querySelectorAll('*')].filter((el) => {
    const r = docRect(el);
    return r.width >= 120 && r.height >= 120;
  });
  const area = (el) => { const r = docRect(el); return r.width * r.height; };
  const concealed = new Map(big.map((el) => [el, paintState(el)]));
  const isRoot = (el, set) => !set.has(el.parentElement);

  // Arm 1 — UI outside the scroller that does not paint. The side-effect arm.
  const outside = big.filter((el) => !concealed.get(el).painted && !insideScroller(el));
  const outsideSet = new Set(outside);
  const armSideEffect = outside.filter((el) => isRoot(el, outsideSet))
    .sort((a, b) => area(b) - area(a)).slice(0, 6);

  // Arm 2 — hidden by its own properties, anywhere, including inside the
  // scroller. The over-correction control (a faded lazy block) lands here.
  const propHidden = big.filter((el) => !concealed.get(el).visibleProps);
  const propSet = new Set(propHidden);
  const armPropHidden = propHidden.filter((el) => isRoot(el, propSet))
    .sort((a, b) => area(b) - area(a)).slice(0, 4);

  const pinned = window.__ckDrawer ? [...document.querySelectorAll(window.__ckDrawer)] : [];
  const named = [...document.querySelectorAll(NAMED)].filter((el) => {
    const r = docRect(el);
    return r.width >= 200 && r.height >= 200 && !concealed.get(el)?.painted;
  });
  const seen = new Set();
  const tracked = [...pinned, ...armSideEffect, ...armPropHidden, ...named]
    .filter((el) => !seen.has(el) && seen.add(el))
    .slice(0, 10);

  const stages = [];
  const snap = (name, extra) => {
    stages.push({
      stage: name,
      doc: docBox().w + 'x' + docBox().h,
      ...(extra !== undefined ? { returned: extra } : {}),
      tracked: tracked.map((el) => ({ el: label(el), ...paintState(el) })),
    });
  };

  snap('S0 baseline');

  const detect = innerScrollPage('detect');
  const expanded = detect.shouldExpand;
  if (expanded) innerScrollPage('expand');
  await sleep(200);
  snap('S1 innerScroll expand', JSON.stringify(detect));

  run(${JSON.stringify(FREEZE)});
  await sleep(150);
  snap('S2 freeze');

  const vp = window.innerHeight || 800;
  const maxY = Math.max(0, document.documentElement.scrollHeight - vp);
  let steps = 0;
  if (maxY > 0) {
    const stepCount = Math.min(${maxSteps}, Math.ceil(maxY / vp) + 1);
    const stride = maxY / Math.max(1, stepCount - 1);
    for (let i = 0; i < stepCount; i++) {
      window.scrollTo({ left: 0, top: Math.round(i * stride), behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await sleep(${settle});
      steps++;
    }
  }
  snap('S3 reveal scroll pass', steps + ' steps');

  const forced = run(${JSON.stringify(FORCE_REVEAL)});
  await sleep(150);
  snap('S4 FORCE_REVEAL', forced);

  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  await sleep(120);
  const unstuck = run(${JSON.stringify(UNSTICK)});
  await sleep(150);
  snap('S5 unstick', unstuck);

  // First stage at which each tracked element starts painting.
  const firstPaint = tracked.map((el, i) => {
    const seq = stages.map((s) => s.tracked[i].painted);
    const idx = seq.findIndex(Boolean);
    return {
      el: label(el),
      paintedAtBaseline: seq[0],
      becomesPaintedAt: idx > 0 ? stages[idx].stage : (idx === 0 ? 'S0 (already)' : 'never'),
      sequence: stages.map((s, j) => s.stage.split(' ')[0] + '=' + (seq[j] ? 'paint' : '-')).join(' '),
    };
  });

  const out = {
    url: location.pathname,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    innerScrollStrategySelected: expanded,
    forceRevealCount: forced,
    unstickTargets: unstuck,
    docBoxByStage: stages.map((s) => s.stage + ' -> ' + s.doc),
    firstPaint,
    stages,
  };

  // Restore, real scripts, reverse order.
  run(${JSON.stringify(RESTICK)});
  run(${JSON.stringify(UNFORCE_REVEAL)});
  run(${JSON.stringify(UNFREEZE)});
  if (expanded) innerScrollPage('restore');
  window.scrollTo(scroll0.x, scroll0.y);

  console.log(JSON.stringify(out, null, 2));
  try { copy(JSON.stringify(out, null, 2)); console.log('(copied to clipboard)'); } catch {}
  return out;
})()
`;

process.stdout.write(probe);
