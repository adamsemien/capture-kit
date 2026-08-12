# capture-kit — Phase 1 Plan

Manifest V3 Chrome extension: one-shot full-page capture via CDP + console/network error recording, packaged into a paste-ready markdown bundle for AI coding assistants.

Status: **awaiting approval — no code written yet.**

---

## 1. Proposed file tree

```
capture-kit/
├── manifest.json                  # source of truth, copied to dist/ by build
├── package.json                   # devDeps only: typescript, esbuild, @types/chrome
├── tsconfig.json                  # strict, noEmit for typecheck; esbuild does emit
├── build.mjs                      # esbuild script: bundles each entry to dist/, copies static files
├── PERMISSIONS.md                 # justification for every permission (store review)
├── .gitignore                     # dist/, node_modules/
└── src/
    ├── background/
    │   └── service-worker.ts      # message router, capture orchestration, downloads, session storage
    ├── content/
    │   ├── recorder-main.ts       # MAIN world: wraps console/fetch/XHR, error listeners → CustomEvent
    │   └── recorder-isolated.ts   # ISOLATED world: ring buffers, chrome.runtime messaging, clipboard fallback
    ├── popup/
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.ts               # 3 buttons, status line, buffer stats
    ├── options/
    │   ├── options.html
    │   ├── options.css
    │   └── options.ts             # segment cap + include-logs toggle (chrome.storage.sync)
    └── lib/
        ├── messages.ts            # typed message protocol (discriminated unions) shared by all contexts
        ├── settings.ts            # storage.sync read/write + defaults
        ├── capture-engine/
        │   ├── types.ts           # CaptureStrategy interface, CaptureRequest/CaptureResult
        │   ├── index.ts           # engine facade — picks strategy (Phase 2 adds inner-scroll strategy here)
        │   ├── cdp-fullpage.ts    # the one Phase-1 strategy: attach → getLayoutMetrics → screenshot(s) → detach
        │   └── segments.ts        # pure segment math + OffscreenCanvas join
        └── bundle/
            ├── markdown.ts        # markdown assembly from buffers + metadata
            └── filename.ts        # title slugify + YYYY-MM-DD_HH-mm timestamp
```

Zero runtime dependencies. esbuild bundles five entry points (`service-worker`, `recorder-main`, `recorder-isolated`, `popup`, `options`) into `dist/`, plus static HTML/CSS/manifest copy. `dist/` is what loads unpacked.

## 2. manifest.json draft

```json
{
  "manifest_version": 3,
  "name": "capture-kit",
  "version": "0.1.0",
  "description": "One-shot full-page capture plus console & network failure bundles for AI-assisted coding.",
  "minimum_chrome_version": "116",
  "permissions": ["debugger", "activeTab", "downloads", "storage", "clipboardWrite", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/recorder-main.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content/recorder-isolated.js"],
      "run_at": "document_start"
    }
  ],
  "action": { "default_popup": "popup/popup.html", "default_title": "capture-kit" },
  "options_page": "options/options.html",
  "commands": {
    "capture-bundle": {
      "suggested_key": { "default": "Ctrl+Shift+9", "mac": "Command+Shift+9" },
      "description": "Capture Bundle (PNG + markdown, copied to clipboard)"
    }
  }
}
```

Notes:
- `world: "MAIN"` in declarative content_scripts needs Chrome ≥111; `minimum_chrome_version: 116` gives comfortable margin and OffscreenCanvas-in-worker support.
- No icons in Phase 1 (Chrome falls back to a default glyph; zero manifest errors). Decision, not oversight.
- `scripting` is reserved for the graceful-degradation path (programmatic re-injection when the recorder is missing, e.g. extension installed after page load) — documented in PERMISSIONS.md.

## 3. Message-passing flow (bundle capture — the MV3-tricky part)

Actors: **P** = popup, **SW** = service worker, **ISO** = isolated-world content script, **MAIN** = MAIN-world recorder.

### Continuous recording (since page load, independent of any capture)

```
MAIN (document_start):
  wraps console.error/warn/log, fetch, XMLHttpRequest; listens window 'error' + 'unhandledrejection'
  every event → document.dispatchEvent(CustomEvent('__capture_kit__', {detail}))   [fire-and-forget]
ISO (document_start):
  listens for '__capture_kit__' → validates shape → pushes into ring buffers held in ISO memory
  consoleBuffer cap 500, networkBuffer cap 200, oldest evicted
```

MAIN never touches chrome.* APIs (it has none); ISO never touches page globals. If MAIN's wrapping throws (frozen/proxied globals), it silently keeps only the window error/rejection listeners — ISO still receives those. Zero console output from either script.

### Bundle capture sequence

```
Trigger A: P button click ──chrome.runtime.sendMessage({type:'CAPTURE_BUNDLE'})──▶ SW
Trigger B: chrome.commands.onCommand('capture-bundle') ─────────────────────────▶ SW
                                    │
SW (single async function; ALL state is local variables inside this one
    invocation — nothing stored in worker globals across awaits):
 1. tabs.query({active, lastFocusedWindow}) → tab
 2. guard: url starts with chrome://, chrome-extension://, edge://, about:, devtools://,
    view-source:, or is chromewebstore.google.com → abort with PROTECTED_PAGE error
 3. tabs.sendMessage(tab.id, {type:'GET_SNAPSHOT'}) ──▶ ISO
    ◀── {console: [...], network: [...], meta: {url, title, viewport, userAgent}}
    (sendMessage throws if no receiver → treat as "recorder not present",
     bundle proceeds with empty buffers + a note; screenshot still works)
 4. settings ← storage.sync (segmentSize, includeLogs)
 5. capture-engine: attach debugger → Page.getLayoutMetrics → contentSize (W×H)
 6. single shot (W≤cap ∧ H≤cap): Page.captureScreenshot{png, captureBeyondViewport:true,
    clip:{0,0,W,H,scale:1}} ; else segmented capture (math below), sequential
 7. debugger.detach immediately (finally-block — detaches even on error)
 8. segments joined on OffscreenCanvas in SW → blob → base64
 9. filename.ts → {slug}_{YYYY-MM-DD_HH-mm}
10. downloads.download(data:image/png;base64,…)  → {basename}.png
    downloads.download(data:text/markdown;base64,…) → {basename}.md
    (data: URLs because MV3 workers have no URL.createObjectURL)
11. markdown assembled by lib/bundle (clipboard variant gets PNG-filename line at top)
12. storage.session.set({lastBundle: {markdown, pngFilename, at}})   ← survives worker death
13. clipboard — split path, this is the subtle bit:
      Trigger A (popup open → popup has focus, page does NOT):
        SW returns {ok, markdown} to P → P writes navigator.clipboard in its own
        focused document. P shows "done".
      Trigger B (command → page has focus, no popup):
        SW → ISO {type:'COPY_TEXT', markdown} → ISO navigator.clipboard.writeText,
        fallback hidden-textarea + execCommand('copy').
14. errors at any step → {ok:false, reason} back to P (shown in status line);
    command path with no popup: badge "!" for 5s + reason stored in storage.session
    (popup shows it on next open)
```

"Copy Last Bundle": P reads `storage.session.lastBundle` → copies in popup. No SW round-trip needed.
"Capture Page": same flow minus steps 3, 11, 13 — PNG download only.
Buffer stats on popup open: P → `tabs.sendMessage(tab.id, {type:'GET_STATS'})` → ISO replies counts.

MV3 worker-death posture: the worker owns no long-lived state. Buffers live in ISO (page lifetime), last bundle + last error live in `chrome.storage.session`, settings in `chrome.storage.sync`. A capture is one self-contained async invocation; if the worker is killed mid-capture the capture fails cleanly and nothing is corrupted.

## 4. Segment-capture math

Let `W×H` = `cssContentSize` from `Page.getLayoutMetrics`, `S` = segment cap (default **8192**, user-configurable).

- Single-shot when `W ≤ S && H ≤ S`.
- Else: `cols = ceil(W/S)`, `rows = ceil(H/S)`, total `rows×cols` segments, captured **sequentially** (bounded memory).
- Segment `(r,c)`: `x = c·S`, `y = r·S`, `w = min(S, W−x)`, `h = min(S, H−y)`; captured with `clip:{x,y,w,h,scale:1}` + `captureBeyondViewport:true`.
- Join: `OffscreenCanvas(W,H)`; each segment base64 → Blob → `createImageBitmap` → `drawImage(bmp, x, y)` → `bitmap.close()`. Coarse rectangle placement at exact grid offsets — no overlap, no stitching heuristics.
- `scale:1` locks output to CSS pixels, so segment offsets are exact and DPR never skews the grid.
- **Canvas guard:** Chrome caps canvas dimensions at 32,767px and area at ~2^28 px². If `W > 32767` → clamp W; if `H > min(32767, floor(2^28/W))` → clamp H. Clamping is recorded in the bundle markdown as an explicit truncation note (absence of the bottom of a 60k-px page is information too).
- Options page validates `S` into `[1024, 16384]`.

Example: 9000×30000 page, S=8192 → cols=2, rows=4 → 8 segments; last column w=808, last row h=5424.

## 5. Bundle markdown shape

```markdown
> Screenshot: {basename}.png            ← clipboard variant only
# Capture — {title}
- URL / Title / Captured at
- Viewport {w}×{h} / Full page {W}×{H} / User agent
## Console
### Errors   (fenced blocks w/ source:line)   — or "No console errors captured since page load."
### Warnings                                   — or explicit "none" line
### Logs (last 20)                             — only if includeLogs setting on
## Network Failures
| Method | Status | URL | Duration |          — or "No failed requests captured since page load."
## Notes
(empty, for the user)
```

## 6. Settings (chrome.storage.sync)

`{ segmentSize: 8192, includeConsoleLogs: true }` — exactly the two the spec allows.

## 7. Commit plan (after approval)

1. `chore: scaffold — manifest, tsconfig, esbuild, gitignore`
2. `feat: typed message protocol + settings lib`
3. `feat: MAIN-world recorder + isolated-world ring buffers`
4. `feat: CDP capture engine with strategy interface + segment join`
5. `feat: bundle markdown assembly + filename slug`
6. `feat: service worker orchestration + downloads`
7. `feat: popup UI (3 buttons, status, buffer stats)`
8. `feat: options page`
9. `docs: PERMISSIONS.md`

Verification gate: `npx tsc --noEmit` exit 0, `node build.mjs` clean, `dist/` loads unpacked with zero manifest errors.

## Decisions made that the spec didn't specify

- No icons in Phase 1 (Chrome default glyph; avoids asset busywork).
- Clipboard split path (popup writes when popup-triggered; content script writes when command-triggered) — forced by document-focus rules.
- `data:` URLs for downloads — MV3 workers lack `URL.createObjectURL`.
- MAIN→ISO transport is a `CustomEvent` on `document` with a fixed name; a hostile page could spoof entries into its own capture buffer — acceptable for a personal dev tool, noted here.
- Canvas dimension/area clamp with explicit truncation note in the markdown.
- Command-path errors surface as a temporary badge + stored reason (no popup exists to show status).
