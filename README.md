# capture-kit

Chrome extension for full-page captures plus console & network failure bundles, built for AI-assisted coding. One click produces a screenshot and a markdown report of everything an agent needs to debug a page — and every output lands in `~/Downloads/capture-kit/`.

## What it does

- **True full-page capture** over the Chrome DevTools Protocol — a real one-shot screenshot for normal pages, an automatic scroll-and-stitch segmented capture for oversized ones (sticky headers neutralized, no repeated-banner artifacts).
- **Failure bundles** — console errors/warnings/logs and failed network requests recorded since page load, formatted as markdown alongside the screenshot and copied to the clipboard.
- **Inner-scroll expansion** — pages that keep their content inside an `overflow: auto` container (Notion, Linear, Airtable) are detected automatically and expanded before capture, so you get the whole document instead of a cut-off window. The bundle markdown logs which mode ran (`Capture mode: standard` or `expanded inner scroll`).

## The buttons (three plus one)

| Button | Output |
|---|---|
| **Capture Page** | Full-page screenshot only, always PNG. |
| **Capture Bundle** | Screenshot (JPEG or PNG per settings) + markdown report, both downloaded; markdown copied to the clipboard. Also on `Ctrl/Cmd+Shift+9`. |
| **Responsive Sweep** | The current page at 375 / 768 / 1440 px widths — three JPEGs named `{slug}_{date}_w{width}.jpg`. No markdown, no clipboard. |
| **Copy Last Bundle** | Re-copies the most recent bundle markdown to the clipboard. |

## AI agent bridge

Every bundle capture also overwrites two stable-name files: `capture-kit/latest.md` (the bundle markdown, whose `Image:` line names the archived timestamped screenshot) and `capture-kit/latest.jpg` or `latest.png`. Tell your coding agent once — for example: *"When I say 'check my capture', read `~/Downloads/capture-kit/latest.md` and the image file sitting next to it in that folder, then act on what you see."* — and it will always get the newest capture without you pasting anything.

## Settings

Open the extension options for: segment size (max px per capture segment, 1024–16384), whether log-level console entries are included in bundles, and bundle image format (JPEG default, PNG optional). Capture Page is always PNG regardless.

## Known limitations

- **Virtualized lists** — apps that render only the visible rows (long Notion databases, virtual tables) will show placeholder or empty regions once expanded. The extension does not detect this; it is inherent to virtualization.
- **Canvas-rendered apps** — Figma, Google Sheets, and similar draw to a canvas rather than the DOM; inner-scroll expansion cannot apply and captures show only what is on screen. Out of scope.
- **`vh`-sized elements on segmented captures** — oversized pages are captured under a virtual viewport, so elements sized in viewport units can re-measure and lay out slightly differently than on screen.
- **DevTools open blocks capture** — Chrome allows one debugger per tab; close DevTools (or any other attached debugger) and retry.
- **Protected pages** — `chrome://` pages, other browser-internal surfaces, and the Chrome Web Store refuse extension access and cannot be captured.

## Development

```
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/, load unpacked via chrome://extensions
node scripts/gen-icons.mjs   # regenerate icons/ after changing the glyph geometry
```

No runtime dependencies. See `PERMISSIONS.md` for why each Chrome permission is requested.
