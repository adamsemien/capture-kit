# capture-kit Phase 2: chosen output directory + agent trigger

NOBC-82. One branch, one PR - both features land on the same service-worker write seam.
Written 2026-08-17 from the evidence in NOBC-82's close-out comment (same date). Base: main @ `03c993b`.

## Proven constraints - do not re-litigate

- `chrome.downloads.download()` writes only under Chrome's download directory. Relative paths only; absolute and `..` rejected.
- The symlink workaround is falsified by live test: Chrome refuses to write through a symlinked subfolder, silently drops the `capture-kit/` prefix, and writes loose at Downloads root.
- Extension keyboard commands (`chrome.commands`) fire only on real browser-level keystrokes. No page-level automation (CDP, AppleScript JS, another extension) can press them.
- The filename tripwire (`verifyDownloadedName`) compares basenames only, so folder loss is invisible to it. Tonight proved that gap.

## Feature 1 - user-chosen output directory (File System Access)

Target behavior: bundles land in a directory the user picks (Adam's: `~/NoBad/_work/capture-kit/`), Downloads stays untouched. No directory chosen = behavior identical to today.

### Design

- **Options page** gains an "Output folder" row: current path (or "Chrome Downloads - default"), a Choose button, a Clear button. Choose calls `showDirectoryPicker({ mode: 'readwrite' })` - window context only; this API does not exist in the service worker. Persist the returned `FileSystemDirectoryHandle` in IndexedDB (db `capture-kit`, store `settings`, key `outputDir`). Handles are structured-cloneable; this is the standard pattern.
- **Service worker write path**: introduce `writeBundleFile(filename, mime, base64, overwrite)` as the single seam. Route:
  1. Handle exists in IDB AND `handle.queryPermission({ mode: 'readwrite' }) === 'granted'` → write via `getFileHandle(name, { create: true })` → `createWritable()` → write → close.
  2. Otherwise → existing `downloadBase64()` path, unchanged, AND surface a one-line notice in the result tab: "Output folder permission lapsed - open Options to re-grant." A capture must never fail because of the folder.
- **Uniquify**: FSA has no `conflictAction`. Replicate Chrome semantics manually: probe existence, on collision insert ` (1)`, ` (2)`... before the extension. `latest.*` always overwrites. Never touch an existing file's name.
- **`downloadLatestPointer`'s** `erase()` dance applies only on the downloads fallback path; on the FSA path there is no shelf entry to hide - skip it.
- **Mirror markdown** `Image:` lines are relative siblings; both files land in the same directory on either path, so no change - but assert this in a test, don't assume it.
- **No migration.** Existing files were moved 2026-08-17 and live in `~/NoBad/_work/capture-kit/`. This PR moves nothing.
- **`minimum_chrome_version`**: currently 116. FSA persistent permissions landed in 122. Bump to whatever the spike proves; state the number and why in the PR.
- **No new manifest permissions expected.** FSA is gated by the picker + permission grant, not a manifest key. If you find you need one, stop and say why before adding it.

### Spike first - 30 minutes, before any feature code

The two real risks are here. Report findings before building; if either fails, the fallback design below is the feature.

1. In an MV3 service worker on current Chrome: load a stored handle from IDB, `queryPermission`, `createWritable`, write a file. Confirm each call works in SW context - `createWritable` availability in service workers is the risk.
2. Full Chrome restart, then capture without touching Options. Confirm the permission survives when the user chose "Allow on every visit" (chrome://settings/content/filesystem). Chrome 122 shipped FSA persistent permissions but the official blog is silent on extension origins - this is exactly the open question. If permission is session-scoped on this build: fallback plan B before degrading to Downloads is the Screenity pattern (shipping prior art: help.screenity.io, "backups") - a pinned extension page holds the directory handle and its permission for the browser session, service worker messages it to write. Only if B is also unacceptable: one-click re-grant in Options + the Downloads fallback notice. Say plainly which world we are in.

Prior art notes (from the 2026-08-17 competitive audit, RESEARCH-competitive-audit-2026-08-17.md): no Chrome screenshot extension ships clean save-anywhere - GoFullPage and Awesome Screenshot document the Downloads-subfolder ceiling as a hard limit; FireShot escapes only via a Windows-only native messaging host. This feature is first-of-its-kind, not housekeeping. The agent trigger also has shipped prior art: FireShot exposes a free in-page JS capture API (getfireshot.com/api.php).

### Tripwire upgrade

`verifyDownloadedName` gets a sibling for the new path and a fix for the old one:
- Downloads path: compare the full relative path (`capture-kit/<name>`), not the basename - the exact failure tonight.
- FSA path: no interception is possible mid-write; instead report the resolved location. The result tab states which path was used, always: `output: <chosen folder> (File System Access)` or `output: Downloads/capture-kit (fallback)`.

## Feature 2 - agent trigger

Target behavior: page-level JavaScript can fire a capture and learn when it finished, so an agent driving the page (Claude in Chrome, AppleScript `execute javascript`) runs captures with zero keystrokes.

### Design

- `recorder-isolated` (already `document_start`, `<all_urls>`) adds a listener: `document.addEventListener('capture-kit:capture', ...)` → `chrome.runtime.sendMessage({ type: 'AGENT_CAPTURE' })`. The service worker handles `AGENT_CAPTURE` exactly like the keyboard command, scoped to `sender.tab`.
- Completion: service worker messages the content script, which dispatches `document` CustomEvent `capture-kit:capture-complete`, detail `{ ok, basename, output: 'chosen' | 'downloads', error? }`. Build detail from JSON-safe primitives only - it crosses the isolated/MAIN world boundary.
- Concurrency: capture already in flight → immediately dispatch complete with `{ ok: false, error: 'busy' }`. No queue.
- Guard: any script on any page can fire this. Acceptable for a personal dev tool; add an Options toggle "Allow in-page trigger," default ON. If this ships freemium later the default flips OFF - leave a comment saying so.
  - **Superseded 2026-08-17, after the feature was built and reviewed.** The toggle ships **default OFF**. "Acceptable for a personal dev tool" understated what the trigger does: it activates a tab, focuses a window and writes a file into the output folder, on behalf of an origin the setting cannot name. Waiting for a freemium launch to flip it meant carrying an unrestricted default for no gain, since the person who wants it can tick a box. The three-mode Site access control (Off / Allowed sites / Any page) that makes "this one site may drive captures" expressible is PR-3; the boolean is the interim.
- Trigger reference (not part of the PR): `document.dispatchEvent(new CustomEvent('capture-kit:capture'))`.

## Acceptance - run all five, paste raw outputs in the PR description

1. Options → choose `~/NoBad/_work/capture-kit` → Cmd+Shift+9 on example.com → file appears there with the standard name; `ls ~/Downloads` gains nothing.
2. Quit Chrome fully, relaunch, capture again without opening Options → same result (persistence proven).
3. From the page console: `document.dispatchEvent(new CustomEvent('capture-kit:capture'))` → capture completes, `capture-kit:capture-complete` fires with `ok: true` and the basename (agent path proven, zero keystrokes).
4. Revoke the folder permission in chrome://settings/content/filesystem → capture still succeeds, lands in `Downloads/capture-kit/`, result tab shows the lapsed-permission notice (fallback proven).
5. Two captures of the same page within one minute → second file gets ` (1)` suffix, first file untouched (uniquify proven).

## Code anchors

- `src/background/service-worker.ts:114` `DOWNLOAD_SUBFOLDER`; `:128` `downloadBase64()` - the seam; every caller moves to `writeBundleFile()`
- `src/background/service-worker.ts:157` `verifyDownloadedName()` - tripwire
- `src/background/service-worker.ts:211` `downloadLatestPointer()` - overwrite + erase, downloads-path-only now
- `src/content/recorder-isolated.*` - existing message plumbing; copy its pattern for the trigger
- `manifest.json` - `minimum_chrome_version`, commands block stays as is

## Out of scope

Moving existing files (done). Session-folder redesign, MCP/CC bridge, inner-scroll capture, responsive sweep - separate punch-list items.

Also explicitly deferred so this PR stays tight (see RESEARCH-competitive-audit-2026-08-17.md for the reasoning):
- **PR-3**: filename template with tokens (%domain, %title, %date, %counter - with a sensitive-data warning on title tokens), format/quality controls (PNG/JPEG/WebP + quality slider), configurable after-capture actions (copy markdown / copy image / save / open result tab, independently toggleable).
- **PR-4**: secret redaction in bundles (API keys, tokens, emails - before the AI paste), capture history page over the output folder, token-budget shaping settings (truncation lengths, failures-only toggles).

Build the options page in this PR knowing those settings are coming - leave room, don't build them.

## Rollback

Behavior is gated on the stored handle: Clear in Options restores stock behavior instantly. Code rollback = revert the squash commit. No data migration exists to undo.

## Branch and prediction

Branch: `adamsemien/nobc-82-output-dir-agent-trigger` (carries `nobc-82` so Linear links the PR).
Prediction to test after merge + extension reload: first capture writes both files to `~/NoBad/_work/capture-kit/` and `~/Downloads` gains zero entries.
