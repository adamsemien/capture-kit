# Permissions

Every permission Capture Kit requests, and why. The extension makes **no
network requests of its own**: no analytics, no telemetry, no server. What it
captures stays on your machine, in the folder you chose (or your Downloads
folder) and on your clipboard. The one fetch it makes is reading a page's own
source maps, from the same place the page loaded its scripts, so console errors
can point at your original files; that request goes to the site you are
debugging and nowhere else.

These are also the justifications used for the Chrome Web Store listing.

## `debugger`

The core capture mechanism. Capture Kit attaches the Chrome DevTools Protocol
to the tab you are capturing and calls `Page.captureScreenshot` with
`captureBeyondViewport: true`. It is the only Chrome API that takes a true
full-page screenshot, including content below the fold and wider than the
window. The debugger is attached only while a capture you started is running
and is detached straight after, in a `finally` block.

## `activeTab`

Captures target the tab you are looking at, and start from your shortcut press,
toolbar click or popup button.

## `tabCapture` and `offscreen`

Used only by **Record clip**. `chrome.tabCapture.getMediaStreamId` gives a
stream of the current tab for the few seconds you asked to record. A service
worker cannot hold a video stream, so an offscreen document receives it,
samples frames, keeps the ones where something changed and lays them on one
sheet. The offscreen document is created for the clip and closed when it ends.

## `downloads` and `downloads.ui`

Each capture writes its image and report with `chrome.downloads.download`.
This is the default path, and the fallback whenever no output folder is chosen
or its permission has lapsed.

`downloads.ui` lets Capture Kit hide Chrome's download bubble for the second it
takes to write a tall page's slices, so a 20-slice page doesn't flash 20
downloads at you. The image and report still show as normal, and the bubble is
turned back on as soon as the slices are written. It adds no new permission
warning: Chrome shows the same "Manage your downloads" line for both.

## No permission for the chosen output folder

Writing to a folder you choose adds **no manifest permission**. The File System
Access API is gated on you picking a folder in Settings and on Chrome's own
grant. Taken as "allow on every visit", the grant survives restarts; taken for
one visit, it lapses with the browser session. Getting it back always needs a
click in an extension page, so the extension can never quietly regain access to
a folder you revoked.

## `storage`

- `storage.sync` holds your settings: image format, segment size, whether logs
  are included, the `latest.*` pointers, the result tab, clip length, and the
  opt-in switches that are **off by default** - one-click icon, URL stamp,
  automatic copy, and which pages may trigger a capture.
- IndexedDB (no permission needed) holds the chosen output folder's handle,
  which `chrome.storage` cannot store.
- `storage.session` holds the last report (for "Copy last report"), the last
  error, the progress of a capture in flight, and a flag that the download
  bubble is hidden, so a worker that restarts mid-capture can turn it back on.
  It is cleared when the browser closes.

## `clipboardWrite`

A capture copies its report (and, if you choose, its image) to the clipboard so
you can paste it straight into an AI chat.

## `scripting`

If a tab was open before Capture Kit was installed or reloaded, its content
scripts aren't there yet. The worker injects the isolated-world half on demand
so the page's details and the clipboard path still work. The report says
plainly that such a page has no console coverage since it loaded.

## `contextMenus`

Two items on the toolbar icon's own right-click menu: **Record clip**, and
**Open Capture Kit panel** when one-click mode has taken the popup off the
icon. Nothing is ever added to a page's right-click menu.

## `host_permissions: <all_urls>`

The console and network recorder has to run at `document_start` on every page
to catch errors from the first script a page runs - the whole point of "errors
since page load". You can't know ahead of time which pages you'll end up
debugging, so a narrower list would silently miss them. The recorder is
passive: it wraps `console`, `fetch` and `XMLHttpRequest` with transparent
passthrough, prints nothing, changes no page behaviour, and sends nothing
anywhere. What it records is read only when you capture.

## The in-page capture trigger

Not a Chrome permission, but the same kind of decision. An AI agent driving the
browser can dispatch `capture-kit:capture` (or `capture-kit:record`) on a page
to fire a capture without a keystroke. That brings the tab to the front and
writes files, so **Settings → Automation** decides which pages may do it:

- **Off** (default) - no page can. A page that tries is told so on
  `capture-kit:capture-complete`, so an agent can tell "refused" from "broken".
- **Allowed sites** - only the hosts you list. `localhost` and `127.0.0.1` are
  pre-filled. `localhost:3000` allows one port; `*.example.com` allows a domain
  and its subdomains.
- **Any page** - every site you visit, including ones you don't trust.

Profiles from before 0.4.0 that had the old on/off switch turned on are moved to
**Any page**, which is what that switch meant, so a working agent setup doesn't
break on update.
