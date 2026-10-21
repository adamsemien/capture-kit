# Privacy policy

_Capture Kit Chrome extension. Last updated 21 October 2026._

**Capture Kit does not collect, transmit, sell or share any data.** It has no
server, no account, no analytics and no telemetry.

## What it handles, and where it goes

When you take a capture, Capture Kit reads the current tab's pixels, the
page's address and title, and the console messages and failed network requests
it recorded on that page. From those it makes a screenshot (or a clip sheet)
and a text report, and writes them to:

- the folder you chose in Settings, or your Downloads folder if you chose none;
- your clipboard, so you can paste them.

That is the only place they go. Nothing is uploaded.

To point console errors at your original source files, Capture Kit may fetch
the source maps of the page you are capturing, from the same site that served
the page's scripts. That request goes to the site you are already on and is
not sent anywhere else.

## Agent bridge (off unless you turn it on)

If you turn on **Agent bridge** in Settings and run the bridge helper on your
computer, Capture Kit also hands each report and its images to that helper,
over a connection to `127.0.0.1` - your own computer, never the network. The
helper keeps the newest 20 captures in `~/.capture-kit/captures/`, readable by
you only, so your AI tools can read them. If you also allow **Agent captures**,
the helper can ask Capture Kit to capture a tab on a site you allowed; it is
told the titles and addresses of those tabs only. The pairing code that links
the two is kept in this browser's local extension storage and is not synced.

## Stored on your computer

- Your settings, in Chrome's extension storage (synced by Chrome to your other
  devices if you have Chrome sync turned on, like any extension's settings).
- The output folder you chose, stored locally so captures can keep writing
  there.
- The last report, kept until the browser closes so "Copy last report" works.

## Secrets in reports

Common secret formats that show up in console messages or request URLs (API
keys, access tokens, auth headers) are replaced with `[REDACTED]` in the report
text before it is saved. Screenshots show whatever was on screen, so check them
before sharing.

## Contact

Questions or issues: open an issue at
https://github.com/adamsemien/capture-kit/issues.
