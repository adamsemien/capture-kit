# capture-kit

Chrome extension for full-page captures plus console & network failure reports, built for AI-assisted coding. One click produces a screenshot and a markdown report of everything an agent needs to debug a page — landing in a folder you choose, or in `~/Downloads/capture-kit/` if you choose none.

## What it does

- **True full-page capture** over the Chrome DevTools Protocol — a real one-shot screenshot for normal pages, an automatic scroll-and-stitch segmented capture for oversized ones (sticky headers neutralized, no repeated-banner artifacts).
- **Failure reports** — console errors/warnings/logs and failed network requests recorded since page load, formatted as markdown alongside the screenshot and copied to the clipboard.
- **Inner-scroll expansion** — pages that keep their content inside an `overflow: auto` container (Notion, Linear, Airtable) are detected automatically and expanded before capture, so you get the whole document instead of a cut-off window. The report markdown logs which mode ran and the path taken (e.g. `Capture mode: standard, segmented, 6 segments`).
- **A context block at the top of every report** — URL, whether the page was local or deployed, viewport, page and file dimensions, timestamp, capture path, what triggered the capture, and recorder state, before any console output. An assistant reading the report never has to ask "is this localhost or production?"

## One-click capture

By default, clicking the toolbar icon opens the popup. Turn on **Settings → The toolbar icon → Toolbar icon captures immediately** and one click fires Capture + Report straight away with your current settings — the same path the popup's button takes, result tab and all.

The popup does not go away: **right-click the icon → Open capture-kit panel** and you get it, with Image only, session capture, the responsive sweep and Copy last report. (Chrome's own right-click menu still carries Options, so settings are reachable either way.) Turn the setting back off and the left-click popup returns immediately, in the same browser session.

While a capture runs, the toolbar badge shows an amber `•••`, then live segment counts (`3/7`) on long stitched pages, then green `OK` or red `!`. That signal lives in browser chrome, never on the page, so it can never end up inside the screenshot.

## URL stamp on images

**Settings → What goes in the report → Stamp URL on image** (off by default) composites a thin dark footer across the bottom of the finished image carrying the full URL and the capture time. It runs after the capture completes and after the debugger detaches, operating on the encoded image inside the service worker — it never touches the page, so it cannot appear part-way down a stitched capture. Reported image dimensions everywhere (report, result tab) describe the file including the footer; `Full page:` keeps meaning the page's own geometry. Adding it re-encodes the image once, which costs a JPEG one generation of quality.

If a page is already at Chrome's canvas ceiling, the footer is drawn over the bottom of the image instead of extending it, and the report says `overlaid` rather than `appended` — growing the canvas there would fail the allocation and hand back blank output.

## The buttons

| Button | Output |
|---|---|
| **Capture + Report** | Screenshot (JPEG or PNG per settings) + markdown report, both downloaded; report copied to the clipboard. Also on `Ctrl/Cmd+Shift+9`. |
| **Image only** | Full-page screenshot, no report. JPEG by default; tick the adjacent **PNG** box for lossless (far larger — a tall page runs to tens of MB). |
| **Copy last report** | Re-copies the most recent report markdown to the clipboard. |
| **Capture session (multiple tabs)** | Opens a tab picker, then captures the selected tabs one at a time into `capture-kit/session_{date}_{time}/` with an `index.md` triage manifest. Mirrored to `capture-kit/latest-session/`. |
| **Responsive sweep (3 widths)** | The current page at 375 / 768 / 1440 px widths — three JPEGs plus one `_sweep.md` report listing each width. No clipboard. |

The result tab that opens after a capture carries three copy buttons: **Copy image** (the picture alone), **Copy report** (the markdown alone), and **Copy image + report** (both on the clipboard at once, `Cmd/Ctrl+Shift+C`). The last one is the AI-chat path, and its tooltip is honest about the catch: some chats keep only the image, and when that happens you paste the report separately with Copy report.

## Output folder

Chrome's downloads API writes inside the Downloads directory and nowhere else — relative paths only, absolute paths rejected, and a symlinked subfolder makes Chrome silently drop the folder and write loose at the Downloads root (measured, 2026-08-17). So the escape is the File System Access API: **Settings → Output folder → Choose…** picks any directory, and captures are written there directly. Pick nothing and behaviour is exactly as before.

One thing to know about permissions: Chrome grants folder access to the page you clicked in, not to the extension forever. **Take "allow on every visit" when Chrome offers it** and the folder keeps working across restarts (verified on Chrome 151: quit, relaunch, capture — straight into the chosen folder). Grant it for one visit instead and the next restart lapses it.

A lapse breaks nothing. The capture falls back to `Downloads/capture-kit/` and the result tab says so with a **Reconnect the folder** button; one click restores it — you never re-pick the folder, and the grant then covers the whole browser session, not just that tab. Every capture's result tab states which path it took.

## AI agent bridge

A page can also fire a capture itself, which is what lets an assistant driving the browser capture with zero keystrokes (extension keyboard shortcuts are browser chrome — no page script, CDP call or AppleScript can press them). **This is off by default**; turn it on at **Settings → Automation**:

```js
document.addEventListener('capture-kit:capture-complete', (e) => console.log(e.detail));
document.dispatchEvent(new CustomEvent('capture-kit:capture'));
// → { ok: true, basename: "example-domain_2026-08-17_12-11", output: "chosen" }
```

The completion event always fires. With the setting off you get `{ ok: false, error: 'in-page trigger is turned off in Settings' }`, so a page can tell the difference between "refused" and "broken"; while a capture is already running, `{ ok: false, error: 'busy' }`; and an error string if the page is one Chrome protects.

The setting is currently all-or-nothing: on means **any** site you visit can fire a capture, activate its own tab and write into your output folder. That is why it ships off. A three-mode site-access control (Off / Allowed sites / Any page), matching Chrome's own vocabulary, lands in the next release; leave this off until then unless you are the one driving the browser.

Every report capture also overwrites two stable-name files: `capture-kit/latest.md` (the report markdown, whose `Image:` line names the archived timestamped screenshot) and `capture-kit/latest.jpg` or `latest.png`. Tell your coding agent once — for example: *"When I say 'check my capture', read `~/Downloads/capture-kit/latest.md` and the image file sitting next to it in that folder, then act on what you see."* — and it will always get the newest capture without you pasting anything.

## Session capture

"Capture session" is the multi-tab path: pick tabs across all windows, capture them sequentially, and get one folder plus `index.md` — a **triage** document listing, per page, its URL, its `Contents:` line, and the full text of its console errors and network failures. Warnings, logs and page metadata stay in the per-page report, so a session that emitted 200 third-party deprecation warnings still yields an index you can read. Pages with errors sort first; pages whose recorder never ran sort last and say so.

`capture-kit/latest-session/` mirrors the newest session with numbered files (`01.jpg`, `01.md`, …) plus its own `index.md`, so an assistant can be pointed at one stable path. That folder is overwritten in place and never pruned — its `index.md` states the true page count and tells the reader to ignore higher-numbered leftovers from a longer previous session.

Failures are classified before they reach the index. A request is **first-party** only when both signals agree: it shares the page's registrable domain **and** does not look like telemetry — path segments `log`, `logs`, `collect`, `beacon`, `track`, `tracking`, `telemetry`, `metrics`, `analytics`, `pixel`, `gen_204`, `/e/`, or host prefixes `analytics.`, `metrics.`, `telemetry.`, `logs.`, `log.`, `beacon.`, `stats.`, `tracking.`. Domain alone was not enough — `calendar.google.com` and `play.google.com/log` share `google.com`, and large platforms serve telemetry from sibling subdomains. A request passing both checks is the developer's problem and stays under `Network failures:`; console errors classify on domain alone, since a script's name is weaker evidence than an endpoint's path. Everything else goes under `Third-party requests (blocked or failed)`, collapsed to one line per repeated request (`13×, 1–17ms`), because an ad blocker cutting the same analytics beacon thirteen times is not thirteen bugs. The header's "N pages with errors" and the page ordering count first-party signal only, so a working page with blocked beacons reads as neither broken nor clean. Each page report lists the hosts it treated as third-party **and why** — `doubleclick.net (other domain)` versus `play.google.com (telemetry path — same domain as the page)` — so the demotions most likely to be wrong announce themselves rather than passing as obvious third parties. A console error with no resolvable source stays first-party — an unattributable error should not be hidden.

Two behaviours worth knowing before the first run:

- **The browser visibly switches to each tab in turn.** Chrome does not render a backgrounded tab, so a tab must be in front to capture anything but blank pixels. Nothing is wrong when the window starts flipping.
- **"Reload tabs first" is off by default.** Left off, tabs opened before the extension loaded report console data as unavailable rather than pretending they are clean. Turned on, each tab reloads before capture — which loses unsaved page state.

## Settings

Open the extension options for: the output folder, whether the toolbar icon captures immediately (off by default), whether the URL is stamped onto images (off by default), whether a page may trigger a capture (off by default), segment size (max px per capture segment, 1024–16384), whether log-level console entries are included in reports, report image format (JPEG default, PNG optional), whether the result tab opens after a capture, and whether the `latest.*` pointers are maintained. "Image only" has its own PNG toggle in the popup.

## Known limitations

- **Virtualized lists** — apps that render only the visible rows (long Notion databases, virtual tables) will show placeholder or empty regions once expanded. The extension does not detect this; it is inherent to virtualization.
- **Canvas-rendered apps** — Figma, Google Sheets, and similar draw to a canvas rather than the DOM; inner-scroll expansion cannot apply and captures show only what is on screen. Out of scope.
- **`vh`-sized elements on segmented captures** — oversized pages are captured under a virtual viewport, so elements sized in viewport units can re-measure and lay out slightly differently than on screen.
- **DevTools open blocks capture** — Chrome allows one debugger per tab; close DevTools (or any other attached debugger) and retry.
- **Protected pages** — `chrome://` pages, other browser-internal surfaces, and the Chrome Web Store refuse extension access and cannot be captured.
- **Download-manager extensions can rename your files** — an extension that claims `chrome.downloads.onDeterminingFilename` overrides the name capture-kit asks for, and files land as `download (1)`. Chrome exposes no API naming the claimant, so capture-kit detects the rename and reports it in the result tab; the fix is to disable the conflicting extension.

## Development

```
npm install
npm run typecheck   # tsc --noEmit
npm test            # pure-function checks (environment marker, footer geometry, report block)
npm run build       # esbuild → dist/, load unpacked via chrome://extensions
node scripts/gen-icons.mjs   # regenerate icons/ after changing the glyph geometry
node scripts/acceptance.mjs  # end-to-end, drives Chrome for Testing (headless; --headed to watch, --fresh to wipe scratch dirs)
```

No runtime dependencies. See `PERMISSIONS.md` for why each Chrome permission is requested.
