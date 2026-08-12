# Permissions

Every permission capture-kit requests, and why. The extension makes **zero
remote calls** — no analytics, no telemetry, no network requests of its own.
Everything it captures stays on the user's machine (downloads folder and
clipboard).

## `debugger`

The core capture mechanism. The capture engine attaches the Chrome DevTools
Protocol to the active tab and calls `Page.captureScreenshot` with
`captureBeyondViewport: true` — the only Chrome API that produces a true
one-shot full-page screenshot (full scroll height *and* scroll width) without
scroll-and-stitch. The debugger is attached only for the duration of a
user-initiated capture and detached immediately after, in a `finally` block.

## `activeTab`

Captures always target the tab the user is looking at, and are always
user-initiated (toolbar button or keyboard shortcut).

## `downloads`

Each capture writes a PNG (and, for bundles, a sibling markdown file) to the
user's downloads folder via `chrome.downloads.download`.

## `storage`

- `storage.sync` holds the two user settings (segment size cap, include-logs
  toggle).
- `storage.session` holds the last captured bundle (for the "Copy Last
  Bundle" button) and the last error (so shortcut-triggered failures can be
  shown next time the popup opens). Session storage survives service-worker
  death — required because MV3 workers are killed at will — and is cleared
  when the browser closes.

## `clipboardWrite`

Bundle captures copy the markdown report to the clipboard so it can be pasted
straight into an AI chat. Written from the popup when the popup triggered the
capture, or from the content script when the keyboard shortcut did (the
focused document differs between the two paths).

## `scripting`

Fallback injection: if a page was loaded before the extension was installed
or reloaded, the declared content scripts aren't present. The worker injects
the isolated-world half (`content/recorder-isolated.js`) on demand so page
metadata and the clipboard path still work. The bundle explicitly flags such
pages as having no recorder coverage since load.

## `host_permissions: <all_urls>`

The console/network recorder must run at `document_start` on every page to
catch errors from the very first script the page executes — the entire point
of "errors since page load." URLs can't be known ahead of time, so a narrower
host list would silently miss the pages the user ends up debugging. The
recorder is passive: it wraps `console`/`fetch`/`XMLHttpRequest` with
transparent passthrough, produces no console output, changes no page
behavior, and sends nothing anywhere.
