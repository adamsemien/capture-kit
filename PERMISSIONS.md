# Permissions

Every permission capture-kit requests, and why. The extension makes **zero
remote calls** — no analytics, no telemetry, no network requests of its own.
Everything it captures stays on the user's machine (the folder the user chose,
or the downloads folder, and the clipboard).

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

Each capture writes an image (and, for bundles, a sibling markdown file) via
`chrome.downloads.download` — the default path, and the fallback whenever no
output folder has been chosen or its permission has lapsed.

## No permission for the chosen output folder

Writing to a user-chosen directory adds **no manifest permission**. The File
System Access API is gated on the user picking a folder in the options page and
Chrome's own permission grant, not on a manifest key, so the extension's
declared permissions are unchanged by that feature. The grant is Chrome's to
give: taken as "allow on every visit" it survives restarts, taken for one visit
it lapses with the browser session. Re-arming it always requires a click in an
extension page — a service worker has no user activation and cannot fake one,
so the extension can never silently regain access to a folder you revoked.

## `storage`

- `storage.sync` holds the user settings (segment size cap, include-logs
  toggle, image format, result tab, `latest.*` pointers, and whether a page may
  trigger a capture — **off by default**, see below).
- IndexedDB (no permission required) holds the chosen output directory handle,
  which `chrome.storage` cannot store because it JSON-serializes its values.
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

## The in-page capture trigger

Not a Chrome permission, but the same kind of decision, so it belongs here.
With **Settings → Automation** enabled, a page can dispatch
`capture-kit:capture` and cause a capture: that activates the tab, focuses its
window, and writes files to the output folder. The setting carries no origin
restriction, so enabling it enables it for every site visited. **It therefore
defaults to off**, and a page that fires the event while it is off gets an
explicit refusal rather than silence. A three-mode site-access control (Off /
Allowed sites / Any page) replaces the boolean in the next release.

## `host_permissions: <all_urls>`

The console/network recorder must run at `document_start` on every page to
catch errors from the very first script the page executes — the entire point
of "errors since page load." URLs can't be known ahead of time, so a narrower
host list would silently miss the pages the user ends up debugging. The
recorder is passive: it wraps `console`/`fetch`/`XMLHttpRequest` with
transparent passthrough, produces no console output, changes no page
behavior, and sends nothing anywhere.
