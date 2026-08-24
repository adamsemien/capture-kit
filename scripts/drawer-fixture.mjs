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
  const drawerStyle = DRAWER_VARIANTS[variant];
  const rows = Array.from(
    { length: 60 },
    (_, i) =>
      `<div style="height:120px;background:${i % 2 ? '#e4e4e8' : '#f2f2f4'};padding:8px;font:16px sans-serif">row ${i}</div>`,
  ).join('');
  // The over-correction control: opacity:0, no closed-marker of any kind, the
  // exact thing FORCE_REVEAL exists to rescue.
  const lazy =
    `<div id="lazy" style="opacity:0;height:300px;background:#0a7d34;color:#fff;` +
    `font:20px sans-serif;padding:12px">lazy scroll-reveal block — SHOULD be revealed</div>`;
  const drawer = drawerStyle
    ? `<aside id="drawer" aria-hidden="true" style="${drawerStyle}background:#c2185b;color:#fff;` +
      `font:20px sans-serif;padding:16px;z-index:50">CHAT DRAWER — closed on screen</aside>`
    : '';
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
    <div id="main"><h1>repro: ${variant}</h1>${rows}${lazy}</div>
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
