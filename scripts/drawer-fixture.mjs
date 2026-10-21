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
//
// A distinct flat colour is not enough on a JPEG. The encoder rings at every
// sharp edge, and the ring sweeps past the colour on the far side of that edge
// - so what has to be separated is not just the block's own colour but every
// colour it can be made to pass through. Two measurements, both on the
// origin/main build, both variant F, both the sentinel and not the drawer:
//
//   - dark label (#002b33): 214 stray child1 pixels at x 8..752. The
//     cyan-to-#002b33 blend line runs almost exactly through F's child colour
//     #00838f, and glyph antialiasing walks the whole line.
//   - white label, cyan block flush to the edge of #main: 136 stray child1
//     pixels at x 748..752 - the last two sampled columns, which is the
//     block's own right edge ringing against the image boundary.
//
// So the label is white AND the block is inset in white on every side. Both
// are load-bearing. Against white, cyan differs in essentially one channel
// (red 0 vs 255; green 229 vs 255, blue 255 vs 255), so a ring at that edge
// moves red and leaves green near 229. Every colour counted in any fixture
// here has a green channel of 131 or less, so nothing on a cyan-white edge can
// come within the inspector's 40-per-channel tolerance of any of them.
export const SENTINEL_RGB = { r: 0x00, g: 0xe5, b: 0xff }; // #00e5ff
const SENTINEL_LABEL_COLOUR = '#ffffff';
// White gutter around the cyan block, wide enough that a ring cannot reach
// across it - a JPEG MCU is 8 or 16 px, so 32 is at least two clear of it.
const SENTINEL_INSET = 32;

// Rows are height:120 + padding:8, so each one occupies 136px. The sentinel
// wrapper is built to occupy exactly three of them and three rows are dropped
// to pay for it, which keeps the scroller's content height byte-identical to
// the pre-sentinel fixture. That matters: in A and B the drawer is height:100%
// of #shell, so once #shell grows to the expanded content the drawer's height
// - and its pixel count - is the content height. Changing the total would move
// the pre-fix leak number and there would be nothing left to compare against.
const ROW_HEIGHT = 120;
const ROW_PADDING = 8;
const ROW_BOX = ROW_HEIGHT + ROW_PADDING * 2;
const SENTINEL_ROWS = 3;
// wrapper box = inset*2 + block padding*2 + block height, and must equal
// SENTINEL_ROWS whole rows.
const SENTINEL_HEIGHT =
  SENTINEL_ROWS * ROW_BOX - SENTINEL_INSET * 2 - ROW_PADDING * 2;
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

// Variant K, status.sentry.io's shape (2026-10-20). Each colour is unique to
// one layer the page keeps hidden, so "did it paint" is a colour count.
export const K_RGB = {
  overlay: { r: 0x7b, g: 0x1f, b: 0xa2 }, // #7b1fa2 - fixed full-viewport layer inside the parked challenge
  badge: { r: 0xff, g: 0x6f, b: 0x00 }, // #ff6f00 - fixed badge, half past the right edge, visibility:hidden
  icon: { r: 0x00, g: 0x69, b: 0x5c }, // #00695c - in-flow icon the page hides with class="hidden"
  lazy: { r: 0x45, g: 0x27, b: 0xa0 }, // #4527a0 - an opacity:0 section that MUST still be revealed
};

// Variant V, Vercel's environment-variables list (2026-10-19): rows drawn only
// near the viewport. The first 20 rows carry one colour, the rest another, so
// "did the whole list draw" is whether the second colour is in the image.
export const V_RGB = {
  top: { r: 0x1b, g: 0x5e, b: 0x20 }, // #1b5e20 - rows 1-20, on screen at load
  rest: { r: 0xe6, g: 0x51, b: 0x00 }, // #e65100 - rows 21-120, only drawn when scrolled to
};
export const V_ROWS = 120;

// Scroll-and-stitch fixtures (W, X, Y). Each band colour exists in one place
// only, so "did that part of the content make it into the image" is a count.
export const W_RGB = {
  a: { r: 0xd8, g: 0x1b, b: 0x60 }, // #d81b60 - canvas rows 0-999
  b: { r: 0x1e, g: 0x88, b: 0xe5 }, // #1e88e5 - canvas rows 1000-1999
  c: { r: 0x43, g: 0xa0, b: 0x47 }, // #43a047 - canvas rows 2000-2999
};
export const X_RGB = {
  d: { r: 0xf4, g: 0x51, b: 0x1e }, // #f4511e - panel content top
  e: { r: 0x5e, g: 0x35, b: 0xb1 }, // #5e35b1 - panel content middle
  f: { r: 0x00, g: 0x89, b: 0x7b }, // #00897b - panel content bottom
};
// Variant R: the X panel mostly below the window, its content ending in a
// strip that only a capture reaching the panel's last rows can contain.
export const R_RGB = { ...X_RGB, tail: { r: 0xfd, g: 0xd8, b: 0x35 } }; // #fdd835
export const Y_RGB = {
  header: { r: 0x37, g: 0x47, b: 0x4f }, // #37474f - sticky header, must appear once
  end: { r: 0xfd, g: 0xd8, b: 0x35 }, // #fdd835 - last block on the page
};

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
  // NOBC-166, the Google Cloud console's shape: the content column is a
  // position:absolute; top:0; bottom:0 panel pinned inside a position:relative
  // container, under an overflow:hidden wrapper, beside a nav. Releasing the
  // container's height collapses it to zero - the absolute panel is out of
  // flow - and the overflow:hidden wrapper then clips the whole content area.
  // Before the fix this captured as a header over a blank page.
  'J pinned-panel-shell': null,
  // status.sentry.io's shape: Google's reCAPTCHA keeps its challenge parked in
  // an absolute box at top:-10000px (opacity 0, visibility hidden) holding
  // position:fixed full-viewport overlays, plus a fixed badge half past the
  // right edge, and the page hides an icon per row with class="hidden".
  // Before the fix the overlay washed out the first screen, the badge
  // widened the image, and the icon painted as a stray mark.
  'K parked-hidden-layers': null,
  // Vercel's environment-variables shape: a window-scroll virtualized list
  // short enough (120 rows x 52px) for the single-shot path, which captured
  // the rows drawn at load and a blank spacer below them.
  'V virtualized-short': null,
  // A canvas app: the page does not scroll, a panel does, and a sticky canvas
  // inside it repaints only the rows on screen. Rendering tall leaves blank
  // canvas below the first screen; only scrolling gets bands b and c drawn.
  'W canvas-app': null,
  // A normal scrolling page holding a 300px panel that scrolls on its own.
  // Scroll capture with the pointer over the panel must stitch the panel.
  'X pointer-panel': null,
  // The same panel 1500px down the page, captured with the page scrolled to it
  // and the pointer gone (the popup button): the panel must still be the
  // target, and the page and the panel must be left where they were.
  'Q low-panel': null,
  // The panel starts 120px above the bottom of the window, so most of it is
  // off screen when the pointer is put on it.
  'R clipped-panel': null,
  // A panel inside another scrolling container that is scrolled to it: the
  // inner panel must be stitched whole and the outer one left where it was.
  'N nested-panel': null,
  // A long page with a sticky header. Stitched, the header must appear once.
  'Y sticky-header-page': null,
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
  if (variant.startsWith('J ')) return pinnedPanelFixture(variant, { reportsResult, manual });
  if (variant.startsWith('K ')) return parkedLayersFixture(variant, { reportsResult, manual });
  if (variant.startsWith('V ')) return virtualizedFixture(variant, { reportsResult, manual });
  if (variant.startsWith('W ')) return canvasAppFixture(variant, { reportsResult, manual });
  if (variant.startsWith('X ')) return pointerPanelFixture(variant, { reportsResult, manual });
  if (variant.startsWith('Q ')) return pointerPanelFixture(variant, { reportsResult, manual, spacer: 1500 });
  if (variant.startsWith('N ')) return nestedPanelFixture(variant, { reportsResult, manual });
  if (variant.startsWith('R ')) return pointerPanelFixture(variant, { reportsResult, manual, spacer: 'calc(100vh - 120px)', tail: true });
  if (variant.startsWith('Y ')) return stickyHeaderFixture(variant, { reportsResult, manual });
  const drawerStyle = DRAWER_VARIANTS[variant];
  const rows = Array.from(
    { length: ROW_COUNT },
    (_, i) =>
      `<div style="height:${ROW_HEIGHT}px;background:${i % 2 ? '#e4e4e8' : '#f2f2f4'};padding:${ROW_PADDING}px;font:16px sans-serif">row ${i}</div>`,
  ).join('');
  // Last child of the scroller, thousands of pixels below the fold. The white
  // wrapper is the gutter described above: it keeps every edge of the cyan
  // block a cyan-to-white edge, including the one that would otherwise sit on
  // the image boundary.
  const sentinel =
    `<div id="sentinel-frame" style="background:#ffffff;padding:${SENTINEL_INSET}px">` +
    `<div id="sentinel" style="height:${SENTINEL_HEIGHT}px;padding:${ROW_PADDING}px;` +
    `background:${hex(SENTINEL_RGB)};color:${SENTINEL_LABEL_COLOUR};font:20px sans-serif">` +
    `expansion sentinel - paints only if the scroller expanded to its end</div></div>`;
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

/** The nav column beside the pinned panel - must still paint, on the left. */
export const NAV_RGB = { r: 0x2e, g: 0x7d, b: 0x32 }; // #2e7d32
export const NAV_WIDTH = 240;

function pinnedPanelFixture(variant, { reportsResult = false, manual = false } = {}) {
  const rows = Array.from(
    { length: ROW_COUNT },
    (_, i) =>
      `<div style="height:${ROW_HEIGHT}px;background:${i % 2 ? '#e4e4e8' : '#f2f2f4'};padding:${ROW_PADDING}px;font:16px sans-serif">row ${i}</div>`,
  ).join('');
  const sentinel =
    `<div id="sentinel-frame" style="background:#ffffff;padding:${SENTINEL_INSET}px">` +
    `<div id="sentinel" style="height:${SENTINEL_HEIGHT}px;padding:${ROW_PADDING}px;` +
    `background:${hex(SENTINEL_RGB)};color:${SENTINEL_LABEL_COLOUR};font:20px sans-serif">` +
    `expansion sentinel - paints only if the scroller expanded to its end</div></div>`;
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{height:100%;margin:0;overflow:hidden}
  #page{height:100%;display:flex;flex-direction:column}
  #topbar{height:56px;flex:none;background:#123a6b;color:#fff;font:16px sans-serif;padding:16px;box-sizing:border-box}
  /* The wrapper whose overflow:hidden did the clipping. */
  #area{flex:1;min-height:0;display:flex;overflow:hidden}
  #nav{width:${NAV_WIDTH}px;flex:none;background:${hex(NAV_RGB)};color:#fff;font:16px sans-serif;padding:12px;box-sizing:border-box}
  /* The relative container and its pinned panel. */
  #holder{position:relative;flex:1}
  #pinned{position:absolute;top:0;bottom:0;left:0;right:0;display:flex;flex-direction:column}
  #clip{flex:1;min-height:0;display:flex;overflow:hidden}
  #main{flex:1;overflow-y:auto}
</style></head>
<body>
  <div id="page">
    <div id="topbar">repro: ${variant}</div>
    <div id="area">
      <nav id="nav">nav column - must paint at the left</nav>
      <div id="holder"><div id="pinned"><div id="clip">
        <div id="main"><h1>pinned panel</h1>${rows}${sentinel}</div>
      </div></div></div>
    </div>
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

function canvasAppFixture(variant, { reportsResult = false, manual = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;font:14px sans-serif}
  #shell{display:flex;height:100vh}
  nav{width:160px;background:#eceff1;padding:12px;box-sizing:border-box}
  #scroller{flex:1;overflow:auto;position:relative}
  #c{position:sticky;top:0;display:block;width:100%;height:100vh}
</style></head>
<body>
  <div id="shell"><nav>repro: ${variant}</nav><div id="scroller"><canvas id="c"></canvas><div id="spacer"></div></div></div>
  <script>
    const TOTAL = 3000;
    const BANDS = [['${hex(W_RGB.a)}', 0, 1000], ['${hex(W_RGB.b)}', 1000, 2000], ['${hex(W_RGB.c)}', 2000, 3000]];
    const sc = document.getElementById('scroller');
    const c = document.getElementById('c');
    const spacer = document.getElementById('spacer');
    function layout() { spacer.style.height = Math.max(0, TOTAL - sc.clientHeight) + 'px'; }
    function draw() {
      c.width = c.clientWidth; c.height = c.clientHeight;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      const top = sc.scrollTop;
      for (const [colour, from, to] of BANDS) {
        const y0 = Math.max(from, top) - top, y1 = Math.min(to, top + c.height) - top;
        if (y1 > y0) { ctx.fillStyle = colour; ctx.fillRect(0, y0, c.width, y1 - y0); }
      }
    }
    layout(); draw();
    sc.addEventListener('scroll', draw, { passive: true });
    addEventListener('resize', () => { layout(); draw(); });
  </script>
  ${reporter}
</body></html>`;
}

function nestedPanelFixture(variant, { reportsResult = false, manual = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  const blocks = [X_RGB.d, X_RGB.e, X_RGB.f]
    .map((c) => `<div style="height:500px;background:${hex(c)}"></div>`)
    .join('') + `<div style="height:60px;background:${hex(R_RGB.tail)}"></div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;font:16px sans-serif;background:#fafafa}
  header{padding:16px}
  #outer{height:320px;overflow:auto;margin:16px;border:1px solid #999;background:#eee}
  #panel{height:260px;overflow:auto;margin:0 16px;border:1px solid #ccc;background:#fff}
</style></head>
<body>
  <header>repro: ${variant}</header>
  <div id="outer"><div style="height:500px"></div><div id="panel">${blocks}</div><div style="height:500px"></div></div>
  ${reporter}
</body></html>`;
}

function pointerPanelFixture(variant, { reportsResult = false, manual = false, spacer = 0, tail = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  const blocks = [X_RGB.d, X_RGB.e, X_RGB.f]
    .map((c) => `<div style="height:800px;background:${hex(c)}"></div>`)
    .join('') + (tail ? `<div style="height:60px;background:${hex(R_RGB.tail)}"></div>` : '');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;font:16px sans-serif;background:#fafafa}
  header{padding:16px}
  #panel{height:300px;overflow:auto;margin:16px;border:1px solid #ccc;background:#fff}
  #below{height:1600px}
</style></head>
<body>
  <header>repro: ${variant}</header>
  ${spacer ? `<div id="spacer" style="height:${typeof spacer === 'number' ? `${spacer}px` : spacer}"></div>` : ''}
  <div id="panel">${blocks}</div>
  <div id="below"></div>
  ${reporter}
</body></html>`;
}

function stickyHeaderFixture(variant, { reportsResult = false, manual = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  const rows = Array.from({ length: 40 }, (_, i) =>
    `<div style="height:100px;background:${i % 2 ? '#ffffff' : '#eeeeee'};padding:8px;box-sizing:border-box">row ${i + 1}</div>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;font:16px sans-serif}
  header{position:sticky;top:0;height:60px;background:${hex(Y_RGB.header)};color:#fff;z-index:2}
</style></head>
<body>
  <header>repro: ${variant}</header>
  ${rows}
  <div style="height:200px;background:${hex(Y_RGB.end)}"></div>
  ${reporter}
</body></html>`;
}

/**
 * Variant V. A list that keeps a full-height spacer and renders only the rows
 * within a few rows of the viewport, re-rendering on scroll and resize - the
 * way react-window, TanStack Virtual and Vercel's dashboard behave.
 */
function virtualizedFixture(variant, { reportsResult = false, manual = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0;font:14px sans-serif;background:#fafafa}
  header{padding:14px 24px;background:#222;color:#fff}
  #list{position:relative;margin:24px;background:#fff;border:1px solid #ddd}
  .row{position:absolute;left:0;right:0;height:52px;display:flex;align-items:center;gap:16px;padding:0 16px;box-sizing:border-box;border-bottom:1px solid #eee}
  .swatch{width:200px;height:32px}
</style></head>
<body>
  <header>repro: ${variant}</header>
  <div id="list"></div>
  <script>
    const N = ${V_ROWS}, H = 52, list = document.getElementById('list');
    list.style.height = N * H + 'px';
    function render() {
      const top = list.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor(-top / H) - 3);
      const last = Math.min(N, Math.ceil((innerHeight - top) / H) + 3);
      list.textContent = '';
      for (let i = first; i < last; i++) {
        const r = document.createElement('div');
        r.className = 'row';
        r.style.top = i * H + 'px';
        r.innerHTML = '<span class="swatch" style="background:' + (i < 20 ? '${hex(V_RGB.top)}' : '${hex(V_RGB.rest)}') +
          '"></span>VARIABLE_' + String(i + 1).padStart(3, '0');
        list.appendChild(r);
      }
    }
    addEventListener('scroll', render, { passive: true });
    addEventListener('resize', render);
    render();
  </script>
  ${reporter}
</body></html>`;
}

/**
 * Variant K. Three layers the page keeps hidden and one it does not:
 *   - the parked challenge: an absolute box at top:-10000px, opacity 0 and
 *     visibility hidden, holding a position:fixed full-viewport overlay;
 *   - a fixed visibility:hidden badge sitting half past the right edge;
 *   - an in-flow icon hidden with class="hidden" (visibility:hidden);
 *   - the positive control, an opacity:0 section below the fold that must
 *     still be revealed, so a fix that simply reveals less fails here.
 */
function parkedLayersFixture(variant, { reportsResult = false, manual = false } = {}) {
  const reporter = reporterScript(reportsResult, manual);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${reportsResult ? 'ready' : `repro ${variant}`}</title>
<style>
  html,body{margin:0}
  #hero{height:100vh;background:#f2f2f4;font:20px sans-serif;padding:16px;box-sizing:border-box}
  .hidden{visibility:hidden}
  .row{font:18px sans-serif;padding:12px 16px;border-bottom:1px solid #ddd;background:#fff}
</style></head>
<body>
  <div id="hero"><h1>repro: ${variant}</h1>
    <div class="row">Dashboard <i class="hidden" style="display:inline-block;width:60px;height:60px;background:${hex(K_RGB.icon)}"></i></div>
  </div>
  <section id="lazy" style="position:static;opacity:0;height:400px;background:${hex(K_RGB.lazy)}">lazy - SHOULD be revealed</section>
  <div style="height:600px;background:#fff"></div>
  <div class="badge" style="position:fixed;bottom:14px;right:-186px;width:256px;height:60px;visibility:hidden;background:${hex(K_RGB.badge)}"></div>
  <div style="visibility:hidden;position:absolute;width:100%;top:-10000px;left:0;right:0;opacity:0">
    <div style="width:100%;height:100%;position:fixed;top:0;left:0;background:${hex(K_RGB.overlay)};opacity:0.9"></div>
  </div>
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
