// Shared fixture for the drawer investigation. Diagnostic only — not part of
// the extension, not part of the build.
//
// The shape being reproduced, from the studio evidence:
//   - the document itself does not scroll (docBarelyScrolls -> true)
//   - a dominant inner scroller holds the content (the Notion shape, so
//     detectInnerScroll selects InnerScrollExpansionStrategy)
//   - a drawer that is closed on screen, concealed ONLY by a clip on an
//     ancestor it shares with the scroller
//
// The drawer is a saturated pink that appears nowhere else on the page, so a
// pixel inspector can say "the drawer is on disk" without ambiguity.

export const DRAWER_RGB = { r: 194, g: 24, b: 91 }; // #c2185b
export const DRAWER_WIDTH = 452;

// The expansion sentinel, for leak 1 (NOBC-82). A leak-only check would pass
// just as well against a "fix" that stopped expanding altogether: no expansion,
// no un-clip, no drawer, green. This block sits at the very bottom of the
// scroller, far below the fold, so it paints only if expansion reached the end
// of the scroller's content. Counting it alongside the drawer asks both
// questions at once - did the drawer stay out, and did the content come in.
//
// Cyan, and more than 40 per channel - the inspector's tolerance - away from
// every other colour any fixture here paints: the drawer #c2185b, the lazy
// block #0a7d34, F's children #7b1fa2 / #00838f / #ef6c00, H's sections
// #4527a0 / #827717 / #b71c1c, the row greys #e4e4e8 / #f2f2f4, and studio's
// header #123a6b.
export const SENTINEL_RGB = { r: 0x00, g: 0xe5, b: 0xff }; // #00e5ff

// Rows are height:120 + padding:8, so each one occupies 136px. The sentinel is
// built to occupy exactly two of them and two rows are dropped to pay for it,
// which keeps the scroller's content height byte-identical to the pre-sentinel
// fixture. That matters: in A and B the drawer is height:100% of #shell, so
// once #shell grows to the expanded content the drawer's height - and its
// pixel count - is the content height. Changing the total would move the
// pre-fix leak number and there would be nothing left to compare against.
const ROW_HEIGHT = 120;
const ROW_PADDING = 8;
const ROW_BOX = ROW_HEIGHT + ROW_PADDING * 2;
const SENTINEL_ROWS = 2;
const SENTINEL_HEIGHT = SENTINEL_ROWS * ROW_BOX - ROW_PADDING * 2;
const ROW_COUNT = 60 - SENTINEL_ROWS;

// Variant F's three block children, each a colour that appears nowhere else in
// any fixture here. F is the hole-1 case: the drawer is position:fixed, so the
// flat scan skipped the drawer itself but marked every child, because
// visibility inherits and each child computed visibility:hidden with
// position:static. The drawer box stayed transparent while its contents
// painted - so counting the drawer's own colour would have reported a clean
// capture. These colours are what actually leaked.
export const F_CHILD_RGB = [
  { r: 0x7b, g: 0x1f, b: 0xa2 }, // #7b1fa2
  { r: 0x00, g: 0x83, b: 0x8f }, // #00838f
  { r: 0xef, g: 0x6c, b: 0x00 }, // #ef6c00
];

// Variant H's three lazy sections. H is the positive control: nothing about
// them is closed, so the fix must leave every one of them revealed. Same
// separation rule as above - each is more than the inspector's 40-per-channel
// tolerance away from every other colour in these fixtures.
export const H_SECTION_RGB = [
  { r: 0x45, g: 0x27, b: 0xa0 }, // #4527a0
  { r: 0x82, g: 0x77, b: 0x17 }, // #827717
  { r: 0xb7, g: 0x1c, b: 0x1c }, // #b71c1c
];

export const hex = (c) =>
  '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');

export const DRAWER_VARIANTS = {
  // Parked past the right edge of its clipping ancestor.
  'A off-canvas-left100': `position:absolute;top:0;left:100%;width:${DRAWER_WIDTH}px;height:100%;`,
  // Same place, reached by transform instead of offset.
  'B off-canvas-transform': `position:absolute;top:0;right:0;width:${DRAWER_WIDTH}px;height:100%;transform:translateX(100%);`,
  'C display-none': `position:absolute;top:0;right:0;width:${DRAWER_WIDTH}px;height:100%;display:none;`,
  'D visibility-hidden': `position:absolute;top:0;right:0;width:${DRAWER_WIDTH}px;height:100%;visibility:hidden;`,
  // Not a drawer: in-flow content inside the scroller, faded out the way a
  // scroll-reveal library leaves it until it enters the viewport.
  'E lazy-content': null,
  // Hole 1, isolated: a fixed drawer hidden by visibility:hidden with three
  // coloured children. The drawer itself was always skipped (position:fixed);
  // the children were not, and they are what painted.
  'F fixed-visibility-hidden': `position:fixed;top:0;right:0;width:${DRAWER_WIDTH}px;height:100%;visibility:hidden;`,
  // Hole 2, isolated: not fixed, so the drawer itself is marked, but the page
  // says outright that it is shut. Wrapped in its own position:relative
  // container so the absolute positioning is anchored somewhere stated.
  'G absolute-aria-hidden': `position:absolute;top:0;right:0;width:${DRAWER_WIDTH}px;height:100%;visibility:hidden;`,
  // The positive control, and the only variant with no drawer at all. Three
  // opacity:0 sections below the first viewport, no marker of any kind - the
  // hero case FORCE_REVEAL exists for. If H stops painting, the fix is wrong.
  'H lazy-sections': null,
  // Leak 1's positive control: the same app shell and the same sentinel, with
  // no drawer at all. It proves the expansion still reaches the bottom of the
  // scroller on its own terms, with nothing for the fix to suppress - so a
  // regression in expansion shows up here even if every drawer variant is
  // clean.
  'I sentinel-no-drawer': null,
  // Studio's actual shape, from the probe on app.thenobadcompany.com/operator
  // /studio: position:fixed, off-canvas right, clipped by overflow:clip on
  // body and html, and NO dominant inner scroller — shouldExpand is false, so
  // the standard strategy runs and inner-scroll.ts never executes. The leak
  // here is UNSTICK's 'fixed' branch: a fixed element contributes nothing to
  // the document's scrollable overflow, an absolutely positioned one does.
  'S studio-fixed-offcanvas': null,
  // Same shape, tall enough to clear the 8192 singleShotCap at DPR 1 so the
  // SEGMENTED path runs and pass 2 of UNSTICK executes under the virtual
  // viewport — the pass where geometry stops discriminating.
  'S2 studio-fixed-offcanvas-tall': null,
};

export const DEFAULT_VARIANT = 'A off-canvas-left100';

/**
 * Per-variant window size. S's offsets are studio's literal numbers, so the
 * viewport has to be studio's too — at 1440 wide, left:916 + translateX(422.4)
 * lands ON canvas and the fixture would silently stop reproducing anything.
 */
export const VIEWPORTS = {
  'S studio-fixed-offcanvas': { width: 1300, height: 929 },
  'S2 studio-fixed-offcanvas-tall': { width: 1300, height: 929 },
};
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
export const viewportFor = (variant) => VIEWPORTS[variant] ?? DEFAULT_VIEWPORT;

// Studio's measured geometry, reproduced literally.
const STUDIO = { left: 916, translateX: 422.4, width: 384 };

/**
 * `reportsResult` wires the page to announce a finished capture through
 * document.title, the way the acceptance harness does — /json/list exposes the
 * title without attaching a second debugger to a tab that a capture (which IS
 * a debugger attach) already owns.
 */
export function fixture(variant, { reportsResult = false, manual = false } = {}) {
  if (/^S\d* /.test(variant)) return studioFixture(variant, { reportsResult, manual });
  if (variant.startsWith('H ')) return lazySectionsFixture(variant, { reportsResult, manual });
  const drawerStyle = DRAWER_VARIANTS[variant];
  const rows = Array.from(
    { length: ROW_COUNT },
    (_, i) =>
      `<div style="height:${ROW_HEIGHT}px;background:${i % 2 ? '#e4e4e8' : '#f2f2f4'};padding:${ROW_PADDING}px;font:16px sans-serif">row ${i}</div>`,
  ).join('');
  // Last child of the scroller, thousands of pixels below the fold.
  const sentinel =
    `<div id="sentinel" style="height:${SENTINEL_HEIGHT}px;padding:${ROW_PADDING}px;` +
    `background:${hex(SENTINEL_RGB)};color:#002b33;font:20px sans-serif">` +
    `expansion sentinel - paints only if the scroller expanded to its end</div>`;
  // The over-correction control: opacity:0, no closed-marker of any kind, the
  // exact thing FORCE_REVEAL exists to rescue.
  const lazy =
    `<div id="lazy" style="opacity:0;height:300px;background:#0a7d34;color:#fff;` +
    `font:20px sans-serif;padding:12px">lazy scroll-reveal block — SHOULD be revealed</div>`;
  // F is the only variant whose children carry their own colours; every other
  // variant's drawer is a single coloured box, so counting the drawer colour
  // is the whole test there.
  const drawerChildren = variant.startsWith('F ')
    ? F_CHILD_RGB.map(
        (c, i) =>
          `<div style="height:160px;background:${hex(c)};color:#fff;font:18px sans-serif;` +
          `padding:8px">drawer child ${i} - must not paint</div>`,
      ).join('')
    : '';
  const aside = drawerStyle
    ? `<aside id="drawer" aria-hidden="true" style="${drawerStyle}background:#c2185b;color:#fff;` +
      `font:20px sans-serif;padding:16px;z-index:50">CHAT DRAWER — closed on screen${drawerChildren}</aside>`
    : '';
  // G's own containing block, stated rather than inherited from #shell, so the
  // variant is readable on its own terms.
  const drawer =
    aside && variant.startsWith('G ')
      ? `<div id="g-wrap" style="position:relative;width:0;height:100%">${aside}</div>`
      : aside;
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{height:100%;margin:0;overflow:hidden}
  /* The app shell: fixed height, clips its own children. This is the element
     whose overflow:hidden is the drawer's only concealment in A and B. */
  #shell{position:relative;height:100%;overflow:hidden;display:flex}
  #main{flex:1;overflow-y:auto}
</style></head>
<body>
  <div id="shell">
    <div id="main"><h1>repro: ${variant}</h1>${rows}${lazy}${sentinel}</div>
    ${drawer}
  </div>
  ${reporter}
</body></html>`;
}

/**
 * Studio's shape. Deliberately NOT the app-shell/scroller shape used by A–E:
 *
 *   - no element with overflow:auto|scroll, and the document is more than two
 *     viewports tall, so `docBarelyScrolls` is false and `shouldExpand` is
 *     false twice over. The standard strategy runs; inner-scroll.ts does not
 *     execute at all, which is what studio's "standard, segmented" capture-mode
 *     line reports and what makes leak 1's fix irrelevant here.
 *   - the drawer is position:FIXED. A fixed element contributes nothing to the
 *     document's scrollable overflow no matter where it sits, which is why the
 *     page measures 1300 wide with a drawer parked past 1338.
 *   - overflow:clip on html and body, as measured on studio.
 *   - transform:translateX() on the drawer, which is what drives UNSTICK's
 *     `distorts()` to true and routes it down the 'fixed' branch — a bare
 *     position:absolute with every offset left untouched.
 */
function studioFixture(variant, { reportsResult = false, manual = false } = {}) {
  // 100 rows x 120px clears the 8192 single-shot cap and forces segmentation;
  // 20 rows stays under it and takes the single-shot path.
  const rows = Array.from(
    { length: variant.startsWith('S2 ') ? 100 : 20 },
    (_, i) =>
      `<div style="height:120px;background:${i % 2 ? '#e4e4e8' : '#f2f2f4'};padding:8px;font:16px sans-serif">row ${i}</div>`,
  ).join('');
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;overflow:clip}
  /* A sticky header: legitimate fixed chrome that the 'fixed' branch exists to
     serve. Any fix for leak 3 must leave this in the capture. */
  #topbar{position:fixed;top:0;left:0;right:0;height:56px;background:#123a6b;color:#fff;
          font:16px sans-serif;padding:16px;z-index:10}
  #content{padding-top:72px}
  /* The closed chat drawer, studio's literal geometry. */
  /* border-box so the computed width is studio's 384 exactly; with the
     default content-box the 16px padding makes it 416 and the document widens
     to 1754 instead of the 1722 measured on studio. */
  #drawer{box-sizing:border-box;position:fixed;top:0;left:${STUDIO.left}px;width:${STUDIO.width}px;height:100%;
          transform:translateX(${STUDIO.translateX}px);background:#c2185b;color:#fff;
          font:20px sans-serif;padding:16px;z-index:50}
</style></head>
<body>
  <div id="topbar">LEGITIMATE FIXED HEADER — must survive any fix</div>
  <div id="content"><h1>repro: ${variant}</h1>${rows}</div>
  <aside id="drawer" aria-hidden="true">CHAT DRAWER — closed on screen</aside>
  ${reporter}
</body></html>`;
}


/**
 * Variant H. The positive control, and deliberately the plainest page here:
 * ordinary document scroll, no inner scroller, no drawer, no closed marker
 * anywhere, and no IntersectionObserver - so nothing but FORCE_REVEAL can
 * bring these sections back. Three position:static blocks sit below the first
 * viewport at opacity:0, which is the shape a scroll-reveal library leaves
 * behind and the exact case the flat scan existed to rescue.
 *
 * If a fix that vetoes closed subtrees also stops these painting, the fix has
 * over-corrected and H is what says so.
 */
function lazySectionsFixture(variant, { reportsResult = false, manual = false } = {}) {
  const sections = H_SECTION_RGB.map(
    (c, i) =>
      `<section id="lazy${i}" style="position:static;opacity:0;height:400px;background:${hex(c)};` +
      `color:#fff;font:24px sans-serif;padding:16px">lazy section ${i} - SHOULD be revealed</section>`,
  ).join('');
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0}
  /* One full viewport of ordinary content, so every lazy section below it is
     genuinely out of the first viewport rather than merely faded. */
  #hero{height:100vh;background:#f2f2f4;font:20px sans-serif;padding:16px}
</style></head>
<body>
  <div id="hero"><h1>repro: ${variant}</h1><p>hero content, always visible</p></div>
  ${sections}
  ${reporter}
</body></html>`;
}

/**
 * `manual` suppresses the auto-fire so the harness can snapshot the page
 * BEFORE the capture starts. Restoration is only meaningful as post == pre;
 * asserting absolute values instead gets it wrong in both directions — fixture
 * S's drawer is supposed to still be off-canvas and un-hittable afterwards,
 * because that is how it started.
 */
function reporterScript(reportsResult, manual) {
  if (!reportsResult) return '';
  return `<script>
        document.addEventListener('capture-kit:capture-complete', (e) => {
          document.title = 'RESULT ' + JSON.stringify(e.detail);
        });
        window.__ckFire = () => document.dispatchEvent(new CustomEvent('capture-kit:capture'));
        ${manual ? '' : `addEventListener('load', () => setTimeout(() => window.__ckFire(), 900));`}
      </script>`;
}
