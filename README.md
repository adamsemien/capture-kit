# capture-kit

Chrome extension for full-page captures plus console & network failure reports, built for AI-assisted coding. One click produces a screenshot and a markdown report of everything an agent needs to debug a page — and every output lands in `~/Downloads/capture-kit/`.

## What it does

- **True full-page capture** over the Chrome DevTools Protocol — a real one-shot screenshot for normal pages, an automatic scroll-and-stitch segmented capture for oversized ones (sticky headers neutralized, no repeated-banner artifacts).
- **Failure reports** — console errors/warnings/logs and failed network requests recorded since page load, formatted as markdown alongside the screenshot and copied to the clipboard.
- **Inner-scroll expansion** — pages that keep their content inside an `overflow: auto` container (Notion, Linear, Airtable) are detected automatically and expanded before capture, so you get the whole document instead of a cut-off window. The report markdown logs which mode ran and the path taken (e.g. `Capture mode: standard, segmented, 6 segments`).

## The buttons

| Button | Output |
|---|---|
| **Capture + Report** | Screenshot (JPEG or PNG per settings) + markdown report, both downloaded; report copied to the clipboard. Also on `Ctrl/Cmd+Shift+9`. |
| **Image only** | Full-page screenshot, no report. JPEG by default; tick the adjacent **PNG** box for lossless (far larger — a tall page runs to tens of MB). |
| **Copy last report** | Re-copies the most recent report markdown to the clipboard. |
| **Capture session (multiple tabs)** | Opens a tab picker, then captures the selected tabs one at a time into `capture-kit/session_{date}_{time}/` with an `index.md` triage manifest. Mirrored to `capture-kit/latest-session/`. |
| **Responsive sweep (3 widths)** | The current page at 375 / 768 / 1440 px widths — three JPEGs plus one `_sweep.md` report listing each width. No clipboard. |

## AI agent bridge

Every report capture also overwrites two stable-name files: `capture-kit/latest.md` (the report markdown, whose `Image:` line names the archived timestamped screenshot) and `capture-kit/latest.jpg` or `latest.png`. Tell your coding agent once — for example: *"When I say 'check my capture', read `~/Downloads/capture-kit/latest.md` and the image file sitting next to it in that folder, then act on what you see."* — and it will always get the newest capture without you pasting anything.

## Session capture

"Capture session" is the multi-tab path: pick tabs across all windows, capture them sequentially, and get one folder plus `index.md` — a **triage** document listing, per page, its URL, its `Contents:` line, and the full text of its console errors and network failures. Warnings, logs and page metadata stay in the per-page report, so a session that emitted 200 third-party deprecation warnings still yields an index you can read. Pages with errors sort first; pages whose recorder never ran sort last and say so.

`capture-kit/latest-session/` mirrors the newest session with numbered files (`01.jpg`, `01.md`, …) plus its own `index.md`, so an assistant can be pointed at one stable path. That folder is overwritten in place and never pruned — its `index.md` states the true page count and tells the reader to ignore higher-numbered leftovers from a longer previous session.

Failures are classified before they reach the index. A request or script error whose host matches the page's registrable domain is **first-party** — the developer's problem — and stays under `Network failures:`. Everything else goes under `Third-party requests (blocked or failed)`, collapsed to one line per repeated request (`13×, 1–17ms`), because an ad blocker cutting the same analytics beacon thirteen times is not thirteen bugs. The header's "N pages with errors" and the page ordering count first-party signal only, so a working page with blocked beacons reads as neither broken nor clean. Each page report lists the hosts it treated as third-party, so a misclassification is visible rather than silent. A console error with no resolvable source stays first-party — an unattributable error should not be hidden.

Two behaviours worth knowing before the first run:

- **The browser visibly switches to each tab in turn.** Chrome does not render a backgrounded tab, so a tab must be in front to capture anything but blank pixels. Nothing is wrong when the window starts flipping.
- **"Reload tabs first" is off by default.** Left off, tabs opened before the extension loaded report console data as unavailable rather than pretending they are clean. Turned on, each tab reloads before capture — which loses unsaved page state.

## Settings

Open the extension options for: segment size (max px per capture segment, 1024–16384), whether log-level console entries are included in reports, report image format (JPEG default, PNG optional), whether the result tab opens after a capture, and whether the `latest.*` pointers are maintained. "Image only" has its own PNG toggle in the popup.

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
npm run build       # esbuild → dist/, load unpacked via chrome://extensions
node scripts/gen-icons.mjs   # regenerate icons/ after changing the glyph geometry
```

No runtime dependencies. See `PERMISSIONS.md` for why each Chrome permission is requested.
