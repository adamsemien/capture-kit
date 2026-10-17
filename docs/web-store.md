# Chrome Web Store listing kit

Everything the Web Store developer dashboard asks for, ready to paste. Upload
the zip from the matching GitHub release (it is the built `dist/` folder).

## Store listing tab

**Name:** Capture Kit

**Summary** (from `manifest.json`, 117 of 132 characters):

> Full-page screenshots and clips with the console errors and failed requests behind them, ready to paste into your AI.

**Category:** Developer Tools

**Language:** English

**Detailed description:**

```
Show your AI what you're looking at.

Press one key on any page. Capture Kit takes the whole page, top to bottom, writes a short report of what went wrong on it, and puts both on your clipboard. Paste into Claude, ChatGPT, Cursor or any other assistant and ask what's broken.

THE WHOLE PAGE, NOT THE VISIBLE PART
True full-page capture, including pages that scroll inside a panel (Notion, Linear, Airtable) and pages far taller than Chrome can fit in one image.

THE WHY, NOT JUST THE WHAT
Console errors and warnings, and failed network requests, since the page loaded - mapped back through source maps to your original files. Third-party noise (ads, analytics) is separated from your own requests.

MADE FOR AI TO READ
Tall pages are also cut into screen-sized slices so their text stays legible to an assistant, with empty margins trimmed. A context block says whether the page is localhost or production, at what size and zoom.

CLIPS FOR BUGS THAT MOVE
Record a few seconds of a tab. Capture Kit keeps only the frames where something changed, on one sheet, with the console and network timeline alongside.

BUILT FOR AI CODING AGENTS
Pick an output folder and every capture also writes latest.md and latest.jpg, so your agent can read the newest capture from disk. Agents driving the browser can fire a capture themselves on sites you allow.

PRIVATE
No server, no account, no analytics. Everything stays on your computer and your clipboard. Common secret formats (API keys, tokens, auth headers) are blanked out of reports.

Shortcuts: Cmd/Ctrl+Shift+9 to capture, Cmd/Ctrl+Shift+8 to record a clip.

Free and open source: https://github.com/adamsemien/capture-kit
```

**Icon:** `icons/icon128.png` (128 x 128).

**Screenshots** (1280 x 800, in `docs/images/store/`):

1. `1-result.png` - a capture's result tab: screenshot beside its report.
2. `2-welcome.png` - the getting-started page with the two shortcuts.
3. `3-automation.png` - Settings, choosing which pages may trigger a capture.

**Small promo tile** (440 x 280): `docs/images/store/promo-440x280.png`.

**Homepage URL:** https://github.com/adamsemien/capture-kit

**Support URL:** https://github.com/adamsemien/capture-kit/issues

## Privacy tab

**Single purpose:**

```
Capture Kit captures the current web page - as a full-page screenshot or a short clip - together with that page's console errors and failed network requests, and saves them as files and to the clipboard so a developer can hand them to an AI assistant for debugging.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| debugger | Takes the full-page screenshot. Page.captureScreenshot with captureBeyondViewport, over the Chrome DevTools Protocol, is the only Chrome API that captures content below the fold. Attached only while a capture the user started is running, then detached. |
| activeTab | Captures target the tab the user is looking at, started by the user's shortcut, toolbar click or popup button. |
| tabCapture | Records the current tab for the few seconds of a clip the user asked for. |
| offscreen | A service worker can't hold a video stream, so an offscreen document records the clip and picks the frames that changed. Closed when the clip ends. |
| downloads | Saves each screenshot and report to the user's Downloads folder. |
| downloads.ui | Hides the download bubble for the moment it takes to save a tall page's slices, so the user doesn't see 20+ downloads flash past. Turned back on straight after. |
| storage | Stores the user's settings and the last report (for "Copy last report"). |
| clipboardWrite | Copies the report and image to the clipboard so they can be pasted into an AI chat. |
| scripting | Injects the extension's own recorder into tabs that were open before the extension was installed, so those pages can still be captured. |
| contextMenus | Adds "Record clip" and "Open Capture Kit panel" to the toolbar icon's right-click menu. Nothing is added to page menus. |
| Host permission (all URLs) | The console and network recorder must run from the start of every page load to catch errors from the first script a page runs. The user can debug any site, so the sites can't be listed in advance. The recorder sends nothing anywhere. |

**Remote code:** No, I am not using remote code. (All code is bundled in the package.)

**Data usage:** tick nothing - Capture Kit collects none of the listed data types. Then certify all three statements (not sold to third parties, not used for unrelated purposes, not used for creditworthiness).

**Privacy policy URL:** https://github.com/adamsemien/capture-kit/blob/main/PRIVACY.md (works once the repo is public).

## Distribution tab

- **Visibility:** Public.
- **Regions:** All regions.
- **Payment:** Free.

## Before you submit

- The developer account costs a one-time US$5 registration fee (reported by
  [ExtensionBooster](https://extensionbooster.net/blog/chrome-web-store-developer-registration-fee-2026-guide/),
  not checked against Google's own page).
- EU listings ask you to declare whether you publish as a trader (a business)
  or a non-trader (an individual).
- The first review may take longer than usual. Broad permissions like
  `debugger` and access to all sites tend to draw extra scrutiny, which is
  why the justifications above are specific.
