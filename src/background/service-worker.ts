// MV3 service worker: capture orchestration, downloads, error reporting.
//
// Worker-death posture: this worker owns no long-lived state. Ring buffers
// live in the content script (page lifetime); the last bundle and last error
// live in chrome.storage.session; settings live in chrome.storage.sync. A
// capture is one self-contained async invocation whose state is all local
// variables — if the worker dies mid-capture, the capture fails cleanly and
// nothing is corrupted.

import { clipboardText, copiesFromPage, opensResultTab } from '../lib/clipboard-only';
import { toClipboardPng } from '../lib/clipboard-png';
import { captureFullPage } from '../lib/capture-engine';
import { captureSweep } from '../lib/capture-engine/sweep';
import {
  applyInnerScrollExpansion,
  detectInnerScroll,
  restoreInnerScrollExpansion,
} from '../lib/capture-engine/inner-scroll';
import {
  buildBundleMarkdown,
  buildClipboardMarkdown,
  buildContentsLine,
  buildSweepMarkdown,
  captureModeLabel,
  OUTPUT_README,
  withLatestNotice,
} from '../lib/bundle/markdown';
import { captureBasename, slugify, timestampForFilename } from '../lib/bundle/filename';
import { buildSessionIndex } from '../lib/session/manifest';
import { splitConsoleErrors, splitFailures } from '../lib/net-classify';
import type { SessionFailure, SessionPage } from '../lib/session/manifest';
import { textToBase64 } from '../lib/base64';
import { ICON_MODE_KEY, getSettings } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { outputDirHasFile, outputDirStatus, writeToOutputDir } from '../lib/output-dir';
import { redactPage, redactText } from '../lib/redact';
import type { RedactedPage } from '../lib/redact';
import { FrameMapper, mapPageSources } from '../lib/source-map';
import {
  CAPTURE_PROGRESS_KEY,
  CONSOLE_LOGS_IN_BUNDLE,
  SESSION_PROGRESS_KEY,
  SESSION_SUMMARY_KEY,
} from '../lib/messages';
import type {
  AgentCaptureDetail,
  BufferSnapshot,
  CaptureProgressState,
  CaptureResponse,
  CaptureResultMeta,
  CaptureTrigger,
  ConsoleEntry,
  FilenameConflict,
  LastBundle,
  LastError,
  NetworkFailure,
  OutputInfo,
  ResultImagePayload,
  RuntimeMessage,
  SessionProgress,
  SessionSummary,
  SessionTab,
  SweepResponse,
} from '../lib/messages';
import type { StampRequest } from '../lib/capture-engine/types';

const PROTECTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
];

function protectedPageReason(url: string | undefined): string | null {
  if (!url) return 'This tab has no capturable page.';
  for (const prefix of PROTECTED_PREFIXES) {
    if (url.startsWith(prefix)) {
      return 'Cannot capture this page — Chrome does not allow extensions to access browser-internal pages.';
    }
  }
  if (
    url.startsWith('https://chromewebstore.google.com/') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    return 'Cannot capture this page — the Chrome Web Store blocks extension access.';
  }
  return null;
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) throw new Error('No active tab found.');
  return tab;
}

interface SnapshotLookup {
  snapshot: BufferSnapshot | null;
  recorderActive: boolean;
}

/**
 * Everything a report says about a page, in the order the report needs it:
 * first the frames are mapped back to their original file and line where the
 * site publishes source maps (NOBC-153), then the whole record is scrubbed of
 * passwords, tokens and keys (NOBC-152) before any report, index, clipboard
 * block or result tab is built from it. Mapping runs on the raw record so a
 * script URL with a token in it can still be fetched; the scrub runs last so
 * nothing the mapper adds escapes it. Tab fields fill in only what the
 * recorder could not supply and go through the same scrub.
 */
async function preparedPage(tab: chrome.tabs.Tab, snapshot: BufferSnapshot | null): Promise<PreparedPage> {
  const raw = {
    meta: {
      url: snapshot?.meta.url || tab.url || '',
      title: snapshot?.meta.title || tab.title || '',
      viewport: snapshot?.meta.viewport ?? { width: tab.width ?? 0, height: tab.height ?? 0 },
      userAgent: snapshot?.meta.userAgent ?? navigator.userAgent,
    },
    console: snapshot?.console ?? [],
    network: snapshot?.network ?? [],
  };
  const mapped = await mapPageSources(raw, new FrameMapper({ fetch: fetchForSourceMap }));
  return { ...redactPage(mapped), frames: mapped.frames, mappedFrames: mapped.mappedFrames };
}

interface PreparedPage extends RedactedPage {
  frames: number;
  mappedFrames: number;
}

// Source-map fetches are best effort and must never hold a capture. The
// mapper owns the clock (NOBC-160): one deadline per script covering headers
// and bodies, one budget per capture, and it aborts the signal passed here
// when time runs out. Credentials ride along so a protected preview
// deployment resolves the same as a public site.
async function fetchForSourceMap(url: string, signal?: AbortSignal): Promise<Response | null> {
  try {
    return await fetch(url, { credentials: 'include', signal });
  } catch {
    return null;
  }
}

async function getSnapshot(tabId: number): Promise<SnapshotLookup> {
  try {
    const snapshot = (await chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' })) as BufferSnapshot;
    // The isolated half responding isn't enough — the MAIN-world hello beacon
    // is what proves console/network coverage since page load.
    return { snapshot, recorderActive: snapshot.mainWorldActive };
  } catch {
    // Recorder missing — the page predates install/reload. Inject the
    // buffer/clipboard half so metadata and clipboard still work, and retry
    // once. The MAIN-world hooks can't be retrofitted: page load already
    // happened, so the bundle flags the recorder as inactive.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/recorder-isolated.js'],
      });
      const snapshot = (await chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' })) as BufferSnapshot;
      return { snapshot, recorderActive: false };
    } catch {
      return { snapshot: null, recorderActive: false };
    }
  }
}

// Every download lands in a capture-kit/ subfolder of the user's Downloads
// directory. Stable-name files (latest.*) overwrite so an AI agent can be
// pointed at one path once and always read the newest capture.
const DOWNLOAD_SUBFOLDER = 'capture-kit';

// NO onDeterminingFilename listener here, deliberately. An earlier build
// registered one to "re-assert" the filename; measurement showed it was the
// bug, not the fix. Whenever that listener had no matching record — trivially
// reachable, since its queue lived in memory and an MV3 worker can be torn
// down between download() and the event — it called bare suggest(), which
// tells Chrome to use its OWN default. For a data: URL that default is
// literally "download" + an extension from the MIME type, producing
// "download (10).jpeg". The filename passed to downloads.download() is
// honored on its own; the listener could only ever lose (a third-party
// download manager that listens wins by install recency regardless). The
// name check below is the tripwire that makes any such interference visible.
async function downloadBase64(
  filename: string,
  mime: string,
  base64: string,
  overwrite = false,
): Promise<number> {
  const fullPath = `${DOWNLOAD_SUBFOLDER}/${filename}`;
  const conflictAction: 'overwrite' | 'uniquify' = overwrite ? 'overwrite' : 'uniquify';
  let id: number;
  try {
    id = await chrome.downloads.download({
      url: `data:${mime};base64,${base64}`,
      filename: fullPath,
      conflictAction,
    });
  } catch (error) {
    console.error(`[capture-kit] downloads.download rejected "${fullPath}":`, error);
    throw error;
  }
  pendingNameChecks.push(verifyDownloadedName(id, fullPath));
  return id;
}

/** What one write actually did. `downloadId` is null on the chosen-folder path. */
interface WriteResult {
  filename: string;
  downloadId: number | null;
  via: 'chosen' | 'downloads';
}

/**
 * Where the capture in flight put its files. Last write wins, which is right
 * because a capture's files all take the same path — and every capture writes
 * at least once, so this is never stale by the time the result tab reads it.
 */
let currentOutput: OutputInfo | null = null;

const DOWNLOADS_LABEL = `Downloads/${DOWNLOAD_SUBFOLDER}`;

/**
 * The one write seam. Every file the extension produces goes through here.
 *
 * Route: a chosen directory whose permission is granted right now, else
 * Chrome's Downloads folder. A capture must never fail because of the output
 * folder — a lapsed permission degrades to Downloads and says so in the result
 * tab, where one click re-arms it. A restart lapses the permission unless the
 * user told Chrome to allow the folder on every visit. The worker cannot
 * re-arm it itself: requesting the permission needs user activation, which a
 * service worker never has.
 */
async function writeBundleFile(
  path: string,
  mime: string,
  base64: string,
  overwrite = false,
): Promise<WriteResult> {
  const status = await outputDirStatus();
  if (status.state === 'granted') {
    try {
      const written = await writeToOutputDir(path, mime, base64, overwrite);
      currentOutput = { via: 'chosen', label: written.root, lapsed: false };
      return { filename: written.filename, downloadId: null, via: 'chosen' };
    } catch (error) {
      // The permission can lapse between the check and the write, and a folder
      // can be deleted underneath us. Both are Downloads' problem now.
      console.error('[capture-kit] chosen folder write failed, falling back to Downloads:', error);
    }
  }
  const id = await downloadBase64(path, mime, base64, overwrite);
  currentOutput = {
    via: 'downloads',
    label: DOWNLOADS_LABEL,
    lapsed: status.state === 'lapsed',
  };
  return { filename: path.split('/').pop() as string, downloadId: id, via: 'downloads' };
}

function collectOutput(): OutputInfo {
  return currentOutput ?? { via: 'downloads', label: DOWNLOADS_LABEL, lapsed: false };
}

/**
 * Drops a plain-text README into the output folder the first time a bundle
 * lands there, so someone opening the folder in Finder six weeks later can
 * tell latest.jpg from a timestamped original without opening either.
 *
 * Written exactly once, and never over an existing file. Two guards, because
 * the two output paths can be asked different questions:
 *
 *   - Chosen folder: the directory handle can be read, so absence is checked
 *     for real. A README the user wrote themselves is seen and left alone.
 *   - Downloads: an extension cannot look inside the Downloads directory at
 *     all, so a storage.local flag stands in. It is honest about its limit —
 *     a hand-written README.txt there is invisible to us, and the write seam's
 *     uniquify is what still guarantees it is never clobbered (we would create
 *     "README (1).txt" once and then never try again).
 *
 * The tripwire is deliberately left alone: this write's name check is drained
 * and discarded right here, before the capture's own writes queue theirs, so a
 * uniquified README can never surface as a filename-conflict warning about the
 * user's screenshot.
 */
const README_FILENAME = 'README.txt';

async function ensureOutputReadme(): Promise<void> {
  try {
    const status = await outputDirStatus();
    const scope = status.state === 'granted' ? `chosen:${status.name ?? ''}` : 'downloads';
    const flagKey = `readmeWritten:${scope}`;

    const present = await outputDirHasFile(README_FILENAME);
    if (present === true) return;
    if (present === null) {
      const stored = await chrome.storage.local.get(flagKey);
      if (stored[flagKey] === true) return;
    }

    const written = await writeBundleFile(
      README_FILENAME,
      'text/plain',
      textToBase64(OUTPUT_README),
    );
    // Drain this write's tripwire entry so it cannot be reported against the
    // capture that is about to run. This also awaits the download reaching a
    // terminal state, which the landed check below relies on.
    await collectFilenameConflicts();

    // The flag means "verified on disk", not "asked for". Setting it on the
    // request alone was wrong: a download that never completes would burn the
    // one attempt and the folder would stay unexplained forever. Measured
    // 2026-08-23 — a download issued while a native file dialog was open was
    // dropped by Chrome, the flag was set anyway, and no README ever appeared.
    let landed = true;
    if (written.downloadId !== null) {
      const [item] = await chrome.downloads.search({ id: written.downloadId });
      // `exists: false` is Chrome saying the record completed but the file is
      // not on disk — measured in the harness, where a download issued while a
      // native folder dialog was open recorded complete and wrote nothing.
      // Treating that as success would burn the single attempt.
      landed = item?.state === 'complete' && item.exists !== false;
    }
    if (landed) await chrome.storage.local.set({ [flagKey]: true });
  } catch (error) {
    // A folder note is never worth failing a capture over.
    console.error('[capture-kit] could not write the output README:', error);
  }
}

// Tripwire results for the capture in flight. Captures are user-driven and
// sequential, so a single drain point is enough; the result tab renders
// whatever this collects, because a console warning is invisible to a user.
const pendingNameChecks: Promise<FilenameConflict | null>[] = [];

/**
 * Tripwire: report if what landed on disk isn't what we asked for.
 *
 * Compares the whole relative path, not just the basename. The basename-only
 * version was blind to the failure of 2026-08-17: Chrome silently dropped the
 * "capture-kit/" prefix and wrote loose at the Downloads root, and because the
 * basename still matched, nothing reported it. Losing the folder is exactly as
 * bad as losing the name — the file is somewhere the user didn't ask for.
 */
async function verifyDownloadedName(
  id: number,
  requested: string,
): Promise<FilenameConflict | null> {
  try {
    await waitForDownloadComplete(id);
    const [item] = await chrome.downloads.search({ id });
    if (!item?.filename) return null;
    // item.filename is absolute; compare its tail against the path we asked
    // for, which is relative to the downloads directory.
    const savedParts = item.filename.split(/[\\/]/).filter(Boolean);
    const expectedParts = requested.split('/').filter(Boolean);
    const saved = savedParts.slice(-expectedParts.length).join('/');
    const expected = expectedParts.join('/');
    if (saved === expected) return null;
    console.warn(
      `[capture-kit] download path was overridden: requested "${expected}", saved as "${saved}". ` +
        'Either another extension is claiming chrome.downloads.onDeterminingFilename, ' +
        'or Chrome refused the subfolder.',
    );
    return { requested: expected, saved };
  } catch {
    // The tripwire must never affect the capture.
    return null;
  }
}

/** Drains the checks for the capture that just finished. */
async function collectFilenameConflicts(): Promise<FilenameConflict[]> {
  const checks = pendingNameChecks.splice(0, pendingNameChecks.length);
  const settled = await Promise.allSettled(checks);
  return settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((c): c is FilenameConflict => c !== null);
}

function waitForDownloadComplete(id: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve();
    };
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') done();
    };
    chrome.downloads.onChanged.addListener(listener);
    // The state may already be terminal by the time the listener registers.
    void chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== 'in_progress') done();
    });
  });
}

// The latest.* pointer files are plumbing, not user downloads — keep them out
// of the shelf and history. erase() only removes the download record; the
// file stays on disk (never removeFile here). Erasing an in-progress
// download would cancel it, so completion is awaited first.
async function downloadLatestPointer(
  filename: string,
  mime: string,
  base64: string,
): Promise<void> {
  const written = await writeBundleFile(filename, mime, base64, true);
  // On the chosen-folder path there is no shelf entry and no download record,
  // so there is nothing to hide — the erase dance is downloads-only.
  if (written.downloadId === null) return;
  await waitForDownloadComplete(written.downloadId);
  try {
    await chrome.downloads.erase({ id: written.downloadId });
  } catch {
    /* record cleanup is best-effort; the file is already written */
  }
}

// Result-tab plumbing. Metadata (small) goes to chrome.storage.session; the
// image pixels (potentially tens of MB of base64 for a 9k-px PNG) stay in
// this in-memory map so they never hit the session-storage quota. If the
// worker dies before the result tab asks — or the tab is reloaded much
// later — the page shows a "preview expired" note and Show in Finder still
// works. Capped so back-to-back captures can't pile up memory.
interface ResultImageData {
  mime: string;
  base64: string;
}
const resultImages = new Map<string, ResultImageData[]>();
const MAX_RESULT_IMAGE_SETS = 4;

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function openResultTab(meta: CaptureResultMeta, images: ResultImageData[]): Promise<void> {
  try {
    const captureId = crypto.randomUUID();
    resultImages.set(captureId, images);
    while (resultImages.size > MAX_RESULT_IMAGE_SETS) {
      const oldest = resultImages.keys().next().value as string;
      resultImages.delete(oldest);
    }
    await chrome.storage.session.set({ [`result:${captureId}`]: meta });
    await chrome.tabs.create({
      url: `${chrome.runtime.getURL('result/result.html')}?id=${captureId}`,
    });
  } catch (error) {
    // The capture itself succeeded — a failed result tab must not fail it.
    console.error('[capture-kit] result tab failed:', error);
  }
}

// -------------------------------------------------------------- indicator --
//
// The capture-started indicator lives entirely in browser chrome: the toolbar
// badge and the action title. That is not a stylistic choice — captureAttached
// runs UNSTICK_SCRIPT, which re-anchors fixed and sticky elements into the
// document so they are photographed where an unscrolled visitor would see
// them. Any in-page overlay would be un-stuck by that same pass and composited
// into the image, once per segment. Browser chrome cannot be photographed by
// the page it sits above, so the "never appears in the captured image"
// constraint holds by construction rather than by timing.
//
// It matters more than it used to: with one-click capture on there is no popup
// open, so the badge is the only sign anything is happening during the ten-odd
// seconds a segmented capture takes.

const BADGE_RUNNING = '#b7791f';
const BADGE_OK = '#1e8449';
const BADGE_ERROR = '#b03a2e';

async function setBadge(text: string, color: string, title?: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    if (title !== undefined) await chrome.action.setTitle({ title });
  } catch {
    /* badge is best-effort */
  }
}

async function setCaptureProgress(state: CaptureProgressState): Promise<void> {
  try {
    await chrome.storage.session.set({ [CAPTURE_PROGRESS_KEY]: state });
  } catch {
    /* the popup simply shows its own static "Capturing…" */
  }
}

/** Amber dot the moment a capture starts, before the grid size is known. */
async function beginIndicator(): Promise<void> {
  await setBadge('•••', BADGE_RUNNING, 'capture-kit — capturing…');
  await setCaptureProgress({ state: 'running', done: 0, total: 0, startedAt: Date.now() });
}

/** Called per segment. `total` of 1 means a single-shot; nothing to count. */
async function reportProgress(done: number, total: number): Promise<void> {
  if (total > 1) {
    await setBadge(`${done}/${total}`, BADGE_RUNNING, `capture-kit — segment ${done} of ${total}`);
  }
  await setCaptureProgress({ state: 'running', done, total, startedAt: Date.now() });
}

/**
 * Always runs, success or failure, so a capture that dies mid-segment can
 * never leave a stuck counter on the icon. `announce` is false for the popup
 * path, which has its own status line and had no badge before this change.
 */
async function endIndicator(ok: boolean, announce: boolean): Promise<void> {
  await setCaptureProgress({ state: 'idle', done: 0, total: 0, startedAt: Date.now() });
  if (!announce) {
    await setBadge('', BADGE_OK, 'capture-kit');
    return;
  }
  await setBadge(ok ? 'OK' : '!', ok ? BADGE_OK : BADGE_ERROR, 'capture-kit');
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
  }, 5000);
}

async function recordError(reason: string, announce: boolean): Promise<void> {
  const lastError: LastError = { reason, at: Date.now() };
  try {
    await chrome.storage.session.set({ lastError });
  } catch {
    /* best-effort */
  }
  await endIndicator(false, announce);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Another debugger is already attached')) {
    return 'Another debugger (usually DevTools) is attached to this tab — close it and retry.';
  }
  if (message.includes('Cannot access') || message.includes('Cannot attach')) {
    return 'Chrome blocked debugger access to this page.';
  }
  return message;
}

/**
 * One page report: capture, build markdown, write both files. Shared by the
 * single-page button and the session runner, which is why the tab and the
 * output folder are parameters rather than "whatever is active".
 */
interface ReportArtifacts {
  capturedAt: Date;
  basename: string;
  imageFilename: string;
  markdownFilename: string;
  markdown: string;
  /**
   * Same report with its Image: line pointing at the numbered sibling, for
   * the latest-session mirror. Every path inside that folder has to resolve
   * inside that folder — the mirror is the one directory an assistant is
   * pointed at, and a reference out of it fails silently.
   */
  mirrorMarkdown: string | null;
  /** Numbered image name the mirror markdown points at, e.g. "01.jpg". */
  mirrorImageFilename: string | null;
  clipboardMarkdown: string;
  contents: string;
  /** First-party (and unattributable) console errors — what the index counts. */
  errors: ConsoleEntry[];
  thirdPartyErrors: ConsoleEntry[];
  /** First-party network failures only. */
  networkFailures: NetworkFailure[];
  thirdPartyFailures: NetworkFailure[];
  warningCount: number;
  recorderActive: boolean;
  /** Values scrubbed from this page's report. */
  redacted: number;
  imageMime: string;
  /** Null when the image went to the chosen folder — no download record exists. */
  imageDownloadId: number | null;
  result: Awaited<ReturnType<typeof captureFullPage>>;
  title: string;
  url: string;
}

/**
 * The footer's inputs, or undefined when the setting is off. Built here rather
 * than inside the engine so the URL stamped on the image is exactly the URL
 * the report prints — one source, no chance of the two disagreeing.
 */
function stampRequest(
  settings: Settings,
  url: string,
  capturedAt: Date,
): StampRequest | undefined {
  return settings.stampUrlOnImage ? { url, capturedAt } : undefined;
}

/** `folder` is a path inside capture-kit/, e.g. "session_2026-08-14_10-35/". */
async function captureReport(
  tab: chrome.tabs.Tab,
  settings: Settings,
  trigger: CaptureTrigger,
  folder = '',
  /** Ordinal for the mirror copy ("01"); the extension follows the real format. */
  mirrorBasename?: string,
): Promise<ReportArtifacts> {
  const tabId = tab.id as number;
  const { snapshot, recorderActive } = await getSnapshot(tabId);
  const page = await preparedPage(tab, snapshot);
  // The timestamp is taken before the capture so the footer and the report's
  // "Captured at" are the same instant — a segmented capture takes seconds,
  // and two clocks a few seconds apart in one bundle reads as a bug.
  const capturedAt = new Date();
  const result = await captureFullPage({
    tabId,
    segmentSize: settings.segmentSize,
    format: settings.bundleFormat,
    stamp: stampRequest(settings, page.meta.url, capturedAt),
    onProgress: (done, total) => void reportProgress(done, total),
  });

  const basename = captureBasename(page.meta.title, page.meta.url, capturedAt);
  const isJpeg = result.format === 'jpeg';
  const imageFilename = `${basename}.${isJpeg ? 'jpg' : 'png'}`;
  const markdownFilename = `${basename}.md`;
  const meta = page.meta;
  const consoleEntries = page.console;
  const networkFailures = page.network;

  const markdownInput = {
    meta,
    contentSize: result.contentSize,
    fullSize: result.fullSize,
    truncated: result.truncated,
    consoleEntries,
    networkFailures,
    recorderActive,
    redacted: page.redacted,
    sourceMaps: { frames: page.frames, mapped: page.mappedFrames },
    includeLogs: settings.includeConsoleLogs,
    capturedAt,
    imageFilename,
    captureMode: result.mode,
    revealForced: result.revealForced,
    heightHeld: result.heightHeld,
    innerScrollers: result.innerScrollers,
    framesHeld: result.framesHeld,
    segments: result.segments,
    imageSize: result.imageSize,
    trigger,
    stamp: result.stamp,
    naturalSize: result.naturalSize,
    browserZoom: result.browserZoom,
  };
  const mirrorImageFilename = mirrorBasename
    ? `${mirrorBasename}.${isJpeg ? 'jpg' : 'png'}`
    : null;
  const mirrorMarkdown = mirrorImageFilename
    ? buildBundleMarkdown({ ...markdownInput, imageFilename: mirrorImageFilename })
    : null;

  const allErrors = consoleEntries.filter((e) => e.level === 'error');
  const pageUrl = meta.url;
  // The manifest counts and orders on first-party signal only: a page whose
  // only failures are blocked analytics beacons is not a page with errors.
  const errorSplit = splitConsoleErrors(allErrors, pageUrl);
  const failureSplit = splitFailures(networkFailures, pageUrl);
  const errors = errorSplit.firstParty;
  const warningCount = consoleEntries.filter((e) => e.level === 'warn').length;
  const logCount = consoleEntries.filter((e) => e.level === 'log').length;
  const imageMime = isJpeg ? 'image/jpeg' : 'image/png';
  // Both files go through the same seam in the same order, so they always land
  // in the same directory — the mirror markdown's relative "Image:" line
  // depends on that on either path.
  const imageWrite = await writeBundleFile(
    `${folder}${imageFilename}`,
    imageMime,
    result.imageBase64,
  );
  // The report is written after the image and names the file that actually
  // landed. A collision renames the new image to "… (1).jpg", and a report
  // still pointing at "….jpg" would send its reader to the PREVIOUS capture's
  // picture — a wrong screenshot is worse than a missing one.
  const markdown = buildBundleMarkdown({ ...markdownInput, imageFilename: imageWrite.filename });
  const markdownWrite = await writeBundleFile(
    `${folder}${markdownFilename}`,
    'text/markdown',
    textToBase64(markdown),
  );

  return {
    capturedAt,
    basename,
    // The names as written, suffixes and all — everything downstream (result
    // tab, clipboard block, the agent's completion event) has to point at the
    // files that exist rather than the ones that were requested.
    imageFilename: imageWrite.filename,
    markdownFilename: markdownWrite.filename,
    markdown,
    mirrorMarkdown,
    mirrorImageFilename,
    clipboardMarkdown: buildClipboardMarkdown(markdown, imageWrite.filename),
    contents: buildContentsLine({
      truncated: result.truncated,
      fullSize: result.fullSize,
      contentSize: result.contentSize,
      recorderActive,
      errors: errors.length,
      warnings: warningCount,
      logs: settings.includeConsoleLogs ? Math.min(logCount, CONSOLE_LOGS_IN_BUNDLE) : 0,
      networkFailures: failureSplit.firstParty.length,
      thirdPartyErrors: errorSplit.thirdParty.length,
      thirdPartyFailures: failureSplit.thirdParty.length,
    }),
    errors,
    thirdPartyErrors: errorSplit.thirdParty,
    networkFailures: failureSplit.firstParty,
    thirdPartyFailures: failureSplit.thirdParty,
    warningCount,
    recorderActive,
    redacted: page.redacted,
    imageMime,
    imageDownloadId: imageWrite.downloadId,
    result,
    title: meta.title,
    url: meta.url,
  };
}

/**
 * `trigger` replaced a bare `viaCommand: boolean`. The badge announcement it
 * used to gate is now `trigger !== 'popup'` — identical behaviour, since the
 * popup shows its own status and is the only path that never flashed a badge.
 */
/**
 * Re-encode the capture as PNG here (the clipboard takes image/png only) and
 * hand it to the captured tab's content script to write, report alongside.
 * False on any failure - no recorder in the tab, the page lost focus, a
 * permissions policy that blocks the clipboard - and the caller opens the
 * result tab instead, so a capture never ends with nothing to paste.
 */
async function copyImageThroughPage(
  tabId: number,
  mime: string,
  base64: string,
  text: string | undefined,
): Promise<boolean> {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const png = await toClipboardPng(new Blob([bytes], { type: mime }));
    const pngBytes = new Uint8Array(await png.arrayBuffer());
    let pngBinary = '';
    for (let i = 0; i < pngBytes.length; i += 0x8000) {
      pngBinary += String.fromCharCode(...pngBytes.subarray(i, i + 0x8000));
    }
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'COPY_IMAGE',
      pngBase64: btoa(pngBinary),
      text,
    })) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch (error) {
    console.error('[capture-kit] clipboard copy through the page failed:', error);
    return false;
  }
}

async function captureBundle(trigger: CaptureTrigger): Promise<CaptureResponse> {
  const announce = trigger !== 'popup';
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, announce);
      return { ok: false, reason: blocked };
    }
    const tabId = tab.id as number;
    const settings = await getSettings();

    // Before the capture's own writes, so its tripwire entry can be drained
    // without touching theirs.
    await ensureOutputReadme();

    await beginIndicator();
    const report = await captureReport(tab, settings, trigger);
    const {
      capturedAt, imageFilename, markdown, clipboardMarkdown,
      imageMime, imageDownloadId, result,
    } = report;
    const isJpeg = result.format === 'jpeg';

    if (settings.maintainLatest) {
      // Stable pointers for the AI-agent bridge; the Image: line in the
      // markdown keeps them referencing the archived timestamped copy.
      await downloadLatestPointer(
        `latest.${isJpeg ? 'jpg' : 'png'}`,
        imageMime,
        result.imageBase64,
      );
      // The rolling copy says so in the file itself. An assistant handed
      // latest.md otherwise cannot tell it from the timestamped original, nor
      // that what it read a minute ago has since been replaced.
      await downloadLatestPointer(
        'latest.md',
        'text/markdown',
        textToBase64(withLatestNotice(markdown)),
      );
    }

    const lastBundle: LastBundle = {
      markdown: clipboardMarkdown,
      imageFilename,
      at: capturedAt.getTime(),
    };
    try {
      await chrome.storage.session.set({ lastBundle });
    } catch {
      /* best-effort */
    }

    // "Copy to clipboard after capture" with no result tab: image and report
    // go straight to the clipboard through the page that was just captured -
    // the image alone when "Image only" is on.
    let copied = false;
    if (copiesFromPage(settings, trigger)) {
      copied = await copyImageThroughPage(
        tabId,
        imageMime,
        result.imageBase64,
        clipboardText(settings, clipboardMarkdown),
      );
    } else {
      // Best-effort page-side clipboard write. On the keyboard-shortcut path
      // the page is the focused document, so this is the write that lands;
      // when the popup is open instead, this quietly fails and the popup
      // (which has focus) writes the clipboard from the response below.
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'COPY_TEXT', text: clipboardMarkdown });
      } catch {
        /* no recorder to copy through */
      }
    }

    if (opensResultTab(settings, copied)) {
      await openResultTab(
        {
          kind: 'bundle',
          captureModeLabel: captureModeLabel(
            result.mode,
            result.revealForced,
            result.segments,
            result.heightHeld,
            result.innerScrollers,
            result.framesHeld,
          ),
          filenameConflicts: await collectFilenameConflicts(),
          output: collectOutput(),
          images: [
            {
              filename: imageFilename,
              // The file's dimensions, footer included — what the result tab
              // shows has to match what a reader measures in an image viewer.
              width: result.imageSize.width,
              height: result.imageSize.height,
              bytes: base64Bytes(result.imageBase64),
              downloadId: imageDownloadId,
            },
          ],
          markdown,
          autoCopyImage: settings.autoCopyImage,
          clipboardImageOnly: settings.clipboardImageOnly,
          createdAt: capturedAt.getTime(),
        },
        [{ mime: imageMime, base64: result.imageBase64 }],
      );
    }

    await endIndicator(true, announce);
    return { ok: true, imageFilename, markdown: clipboardMarkdown, copied };
  } catch (error) {
    const reason = describeError(error);
    console.error('[capture-kit] bundle capture failed:', error);
    await recordError(reason, announce);
    return { ok: false, reason };
  }
}

async function capturePage(asPng: boolean): Promise<CaptureResponse> {
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, false);
      return { ok: false, reason: blocked };
    }
    const settings = await getSettings();
    // JPEG by default: a tall page as PNG runs to tens of MB for no benefit
    // on a screenshot. PNG is an explicit, sticky opt-in from the popup.
    const format = asPng ? 'png' : 'jpeg';
    const capturedAt = new Date();
    await beginIndicator();
    const result = await captureFullPage({
      tabId: tab.id as number,
      segmentSize: settings.segmentSize,
      format,
      // The footer is text Capture Kit draws, so it is scrubbed like the report.
      stamp: stampRequest(settings, redactText(tab.url ?? '').text, capturedAt),
      onProgress: (done, total) => void reportProgress(done, total),
    });
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const imageFilename = `${captureBasename(tab.title || '', tab.url, capturedAt)}.${
      format === 'png' ? 'png' : 'jpg'
    }`;
    const written = await writeBundleFile(imageFilename, mime, result.imageBase64);
    if (settings.openResult) {
      await openResultTab(
        {
          kind: 'page',
          captureModeLabel: captureModeLabel(
            result.mode,
            result.revealForced,
            result.segments,
            result.heightHeld,
            result.innerScrollers,
            result.framesHeld,
          ),
          filenameConflicts: await collectFilenameConflicts(),
          output: collectOutput(),
          images: [
            {
              filename: written.filename,
              width: result.imageSize.width,
              height: result.imageSize.height,
              bytes: base64Bytes(result.imageBase64),
              downloadId: written.downloadId,
            },
          ],
          autoCopyImage: settings.autoCopyImage,
          createdAt: capturedAt.getTime(),
        },
        [{ mime, base64: result.imageBase64 }],
      );
    }
    await endIndicator(true, false);
    return { ok: true, imageFilename: written.filename };
  } catch (error) {
    const reason = describeError(error);
    console.error('[capture-kit] page capture failed:', error);
    await recordError(reason, false);
    return { ok: false, reason };
  }
}

async function captureResponsiveSweep(): Promise<SweepResponse> {
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, false);
      return { ok: false, reason: blocked };
    }
    const tabId = tab.id as number;
    const settings = await getSettings();
    // A sweep is one page at three widths, so console/network state is read
    // once and stated once in the report.
    const { snapshot, recorderActive } = await getSnapshot(tabId);
    const page = await preparedPage(tab, snapshot);

    // Inner-scroll expansion applies once for the whole sweep, restored at
    // the end — same detection the single captures run.
    const expanded = await detectInnerScroll(tabId);
    if (expanded) await applyInnerScrollExpansion(tabId);
    const capturedAt = new Date();
    const sweepUrl = page.meta.url;
    await beginIndicator();
    let outcome;
    try {
      outcome = await captureSweep(
        tabId,
        settings.segmentSize,
        stampRequest(settings, sweepUrl, capturedAt),
      );
    } finally {
      if (expanded) await restoreInnerScrollExpansion(tabId);
    }

    const basename = captureBasename(page.meta.title, page.meta.url, capturedAt);
    const downloadIds: (number | null)[] = [];
    // The name each image actually landed under. writeBundleFile uniquifies a
    // taken name (" (1)"), so the requested name is not evidence of the file:
    // a second sweep of the same page in the same minute used to point its
    // report and result tab at the FIRST sweep's images. Same fix the bundle
    // and page paths already have.
    const writtenNames: string[] = [];
    for (const capture of outcome.captures) {
      const written = await writeBundleFile(
        `${basename}_w${capture.width}.jpg`,
        'image/jpeg',
        capture.result.imageBase64,
      );
      downloadIds.push(written.downloadId);
      writtenNames.push(written.filename);
    }

    if (outcome.captures.length === 0) {
      const reason = outcome.failures[0]?.reason ?? 'Sweep produced no captures.';
      await recordError(reason, false);
      return { ok: false, reason };
    }

    // A sweep is a one-page session: it writes a report alongside the images.
    const sweepMeta = page.meta;
    const sweepMarkdown = buildSweepMarkdown({
      meta: sweepMeta,
      capturedAt,
      viewport: sweepMeta.viewport,
      stamp: outcome.captures[0]?.result.stamp,
      widths: outcome.captures.map((capture, index) => ({
        width: capture.width,
        filename: writtenNames[index],
        fullSize: capture.result.fullSize,
        contentSize: capture.result.contentSize,
        imageSize: capture.result.imageSize,
        truncated: capture.result.truncated,
        captureMode: capture.result.mode,
        revealForced: capture.result.revealForced,
        heightHeld: capture.result.heightHeld,
        segments: capture.result.segments,
      })),
      failures: outcome.failures,
      consoleEntries: page.console,
      networkFailures: page.network,
      recorderActive,
      redacted: page.redacted,
      sourceMaps: { frames: page.frames, mapped: page.mappedFrames },
      includeLogs: settings.includeConsoleLogs,
    });
    await writeBundleFile(`${basename}_sweep.md`, 'text/markdown', textToBase64(sweepMarkdown));

    if (settings.openResult) {
      const first = outcome.captures[0].result;
      await openResultTab(
        {
          kind: 'sweep',
          captureModeLabel: captureModeLabel(first.mode, first.revealForced, first.segments, first.heightHeld),
          filenameConflicts: await collectFilenameConflicts(),
          output: collectOutput(),
          images: outcome.captures.map((capture, index) => ({
            filename: writtenNames[index],
            label: `${capture.width} px`,
            width: capture.result.imageSize.width,
            height: capture.result.imageSize.height,
            bytes: base64Bytes(capture.result.imageBase64),
            downloadId: downloadIds[index],
          })),
          markdown: sweepMarkdown,
          createdAt: capturedAt.getTime(),
        },
        outcome.captures.map((capture) => ({
          mime: 'image/jpeg',
          base64: capture.result.imageBase64,
        })),
      );
    }
    await endIndicator(true, false);
    return {
      ok: true,
      saved: outcome.captures.map((c) => c.width),
      failed: outcome.failures,
    };
  } catch (error) {
    const reason = describeError(error);
    console.error('[capture-kit] responsive sweep failed:', error);
    await recordError(reason, false);
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------- session --
//
// Capture several tabs into one folder with a triage manifest. Two hard
// constraints shape this: the debugger attaches to one tab at a time, and
// Chrome does not paint a backgrounded tab — so tabs are captured strictly
// sequentially, each one activated first. The visible tab-flipping is
// unavoidable and is announced in the picker UI before the run starts.

const SESSION_POINTER_FOLDER = 'latest-session';
let sessionCancelled = false;
let sessionRunning = false;

function sessionTabReason(tab: chrome.tabs.Tab): string | null {
  // Without the "tabs" permission Chrome withholds url/title for pages we
  // hold no host permission for — which is exactly the set we cannot capture.
  if (!tab.url) {
    return 'Restricted browser page — Chrome hides its address from extensions.';
  }
  const protectedReason = protectedPageReason(tab.url);
  if (protectedReason) return protectedReason;
  if (/\.pdf($|[?#])/i.test(tab.url)) {
    return "Chrome's PDF viewer has no page to capture.";
  }
  return null;
}

async function listSessionTabs(): Promise<SessionTab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => ({
      id: tab.id as number,
      title: tab.title ?? '',
      url: tab.url ?? '',
      favIconUrl: tab.favIconUrl ?? null,
      active: tab.active === true,
      windowId: tab.windowId,
      blockedReason: sessionTabReason(tab),
    }));
}

async function setSessionProgress(progress: SessionProgress): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_PROGRESS_KEY]: progress });
  } catch {
    /* progress display is best-effort */
  }
}

/** Reload and wait for the load to finish, so the recorder covers page load. */
async function reloadAndSettle(tabId: number, timeoutMs = 20000): Promise<void> {
  await chrome.tabs.reload(tabId);
  const startedAt = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return; // tab closed mid-run; the capture below will report it
    }
    if (tab.status === 'complete') break;
    if (Date.now() - startedAt > timeoutMs) break;
  }
  // Let post-load scripts run and log before the snapshot is taken.
  await new Promise((r) => setTimeout(r, 1200));
}

async function runSession(tabIds: number[], reload: boolean): Promise<SessionSummary> {
  sessionCancelled = false;
  sessionRunning = true;
  const startedAt = Date.now();
  const settings = await getSettings();
  const stamp = new Date();
  const folderName = `session_${timestampForFilename(stamp)}`;
  const folder = `${folderName}/`;
  const pointer = `${SESSION_POINTER_FOLDER}/`;

  const restoreTabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  const pages: SessionPage[] = [];
  const failures: SessionFailure[] = [];
  const timings: { title: string; ms: number }[] = [];

  try {
    for (let index = 0; index < tabIds.length; index++) {
      if (sessionCancelled) break;
      const tabId = tabIds[index];
      const tabStartedAt = Date.now();
      let title = '';
      let url = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        // A tab that fails still gets a line in index.md, so its title and
        // URL are scrubbed like every other report field.
        title = redactText(tab.title ?? '').text;
        url = redactText(tab.url ?? '').text;
        await setSessionProgress({
          state: 'running',
          current: index + 1,
          total: tabIds.length,
          title: title || url,
          startedAt,
        });

        const blocked = sessionTabReason(tab);
        if (blocked) throw new Error(blocked);

        // Chrome does not render a backgrounded tab, so it must be focused
        // for the capture to contain pixels.
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await new Promise((r) => setTimeout(r, 250));
        if (reload) await reloadAndSettle(tabId);

        const fresh = await chrome.tabs.get(tabId);
        // The mirror name is known before the capture, so the report can be
        // rendered twice — once naming the timestamped image for the session
        // folder, once naming its numbered sibling for the mirror.
        const ordinal = String(pages.length + 1).padStart(2, '0');
        const report = await captureReport(fresh, settings, 'session', folder, ordinal);
        const mirrorImage = report.mirrorImageFilename as string;

        // Mirror into the stable pointer folder immediately, while the bytes
        // are still in hand — numbered so overwrite is deterministic.
        await downloadPointerFile(
          `${pointer}${mirrorImage}`,
          report.imageMime,
          report.result.imageBase64,
        );
        await downloadPointerFile(
          `${pointer}${ordinal}.md`,
          'text/markdown',
          textToBase64(report.mirrorMarkdown ?? report.markdown),
        );

        pages.push({
          title: report.title,
          url: report.url,
          contents: report.contents,
          imageFilename: report.imageFilename,
          markdownFilename: report.markdownFilename,
          mirrorImageFilename: mirrorImage,
          mirrorMarkdownFilename: `${ordinal}.md`,
          errors: report.errors,
          thirdPartyErrors: report.thirdPartyErrors,
          networkFailures: report.networkFailures,
          thirdPartyFailures: report.thirdPartyFailures,
          warningCount: report.warningCount,
          recorderActive: report.recorderActive,
          redacted: report.redacted,
        });
      } catch (error) {
        const reason = describeError(error);
        console.error(`[capture-kit] session: tab ${tabId} failed:`, error);
        failures.push({ title, url, reason });
      }
      timings.push({ title: title || `tab ${tabId}`, ms: Date.now() - tabStartedAt });
    }

    const totalMs = Date.now() - startedAt;
    const indexInput = {
      capturedAt: stamp,
      pages,
      failures,
      timings,
      totalMs,
      cancelled: sessionCancelled,
    };
    const indexMarkdown = buildSessionIndex(indexInput);
    const indexWrite = await writeBundleFile(
      `${folder}index.md`,
      'text/markdown',
      textToBase64(indexMarkdown),
    );
    await downloadPointerFile(
      `${pointer}index.md`,
      'text/markdown',
      textToBase64(buildSessionIndex({ ...indexInput, pointerFolder: true })),
    );

    if (restoreTabId !== undefined) {
      try {
        await chrome.tabs.update(restoreTabId, { active: true });
      } catch {
        /* the original tab may be gone */
      }
    }

    // Name the real destination: with a chosen folder these are not in
    // Downloads at all, and a summary that says otherwise sends the user
    // looking in the wrong place.
    const outputLabel = collectOutput().label;
    const summary: SessionSummary = {
      folder: `${outputLabel}/${folderName}`,
      pointerFolder: `${outputLabel}/${SESSION_POINTER_FOLDER}`,
      pages: pages.length,
      withIssues: pages.filter((p) => p.errors.length || p.networkFailures.length).length,
      failures: failures.map((f) => ({ title: f.title || f.url, reason: f.reason })),
      timings,
      totalMs,
      cancelled: sessionCancelled,
      indexDownloadId: indexWrite.downloadId,
    };
    try {
      await chrome.storage.session.set({ [SESSION_SUMMARY_KEY]: summary });
    } catch {
      /* best-effort */
    }
    await setSessionProgress({
      state: sessionCancelled ? 'cancelled' : 'done',
      current: pages.length,
      total: tabIds.length,
      title: '',
      startedAt,
    });
    return summary;
  } finally {
    sessionRunning = false;
  }
}

/** Pointer-folder writes are plumbing: same erase-the-record treatment as latest.*. */
async function downloadPointerFile(
  filename: string,
  mime: string,
  base64: string,
): Promise<void> {
  await downloadLatestPointer(filename, mime, base64);
}

// ---------------------------------------------------------- agent trigger --
//
// Extension keyboard commands are browser chrome: no page-level automation can
// press Cmd+Shift+9, which is what kept an agent driving the browser from
// capturing anything. A page event can reach the content script, and the
// content script can reach this worker — so that is the path.
//
// The setting gating it defaults OFF. The trigger carries real authority: it
// activates a tab, focuses a window, and writes a file, and this boolean has no
// notion of which origin asked. PR-3 replaces it with a three-mode site-access
// control (Off / Allowed sites / Any page), which is where "allow this one site
// to drive captures" becomes expressible; until then the honest default is off.

/** One capture at a time; a second trigger is refused, never queued. */
let agentCaptureRunning = false;

async function tellPage(tabId: number, detail: AgentCaptureDetail): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AGENT_CAPTURE_COMPLETE', detail });
  } catch {
    // The tab may be gone or navigated; the capture still happened.
  }
}

async function agentCapture(tabId: number): Promise<void> {
  if (agentCaptureRunning) {
    await tellPage(tabId, { ok: false, error: 'busy' });
    return;
  }
  agentCaptureRunning = true;
  try {
    // The capture is scoped to the tab that fired the event, and Chrome does
    // not paint a backgrounded tab — so that tab is focused first, exactly as
    // the session runner does it.
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 250));
    }
    // Same path as the keyboard command, so an agent gets exactly what a
    // keystroke gets — including the badge flash.
    const response = await captureBundle('agent');
    await tellPage(
      tabId,
      response.ok
        ? {
            ok: true,
            // The basename is the shared stem of both files; the page asked
            // for a capture, so it is told what to look for.
            basename: response.imageFilename.replace(/\.[^.]+$/, ''),
            output: collectOutput().via,
          }
        : { ok: false, error: response.reason },
    );
  } catch (error) {
    await tellPage(tabId, { ok: false, error: describeError(error) });
  } finally {
    agentCaptureRunning = false;
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type === 'AGENT_CAPTURE') {
    const tabId = sender.tab?.id;
    // Scoped to the sender's tab: an agent captures the page it is driving,
    // not whatever happens to be focused.
    if (tabId === undefined) {
      sendResponse({ ok: false });
      return false;
    }
    void getSettings().then((settings) => {
      if (!settings.allowInPageTrigger) {
        void tellPage(tabId, { ok: false, error: 'in-page trigger is turned off in Settings' });
        return;
      }
      void agentCapture(tabId);
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'CAPTURE_BUNDLE') {
    void captureBundle('popup').then(sendResponse);
    return true;
  }
  if (message?.type === 'CAPTURE_PAGE') {
    void capturePage(message.png === true).then(sendResponse);
    return true;
  }
  if (message?.type === 'CAPTURE_SWEEP') {
    void captureResponsiveSweep().then(sendResponse);
    return true;
  }
  if (message?.type === 'SESSION_LIST_TABS') {
    void listSessionTabs().then(sendResponse);
    return true;
  }
  if (message?.type === 'SESSION_START') {
    if (sessionRunning) {
      sendResponse({ ok: false, reason: 'A session capture is already running.' });
      return false;
    }
    void runSession(message.tabIds, message.reload)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) => sendResponse({ ok: false, reason: describeError(error) }));
    return true;
  }
  if (message?.type === 'SESSION_CANCEL') {
    sessionCancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'GET_RESULT_IMAGE') {
    const images = resultImages.get(message.captureId);
    const payload: ResultImagePayload = images?.[message.index] ?? null;
    sendResponse(payload);
    return false;
  }
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-bundle') void captureBundle('shortcut');
});

// ------------------------------------------------------- one-click capture --
//
// With "Toolbar icon captures immediately" on, the icon loses its popup and
// becomes the capture button. chrome.action.onClicked only fires when the
// popup is the empty string, so the OFF state needs no guard in the handler —
// the listener is simply unreachable, which is what makes ON → OFF → ON in a
// single session exact rather than approximately restored.
//
// The popup override is per-browser-session, not persisted, so it is asserted
// from three places: install (new/updated/reloaded extension), startup (a new
// browser session), and worker top-level evaluation (every wake in between).
// Cheap, idempotent, and there is no state where the icon disagrees with the
// setting.

const POPUP_PAGE = 'popup/popup.html';
const PANEL_MENU_ID = 'capture-kit-open-panel';

async function applyActionPopup(oneClick: boolean): Promise<void> {
  try {
    await chrome.action.setPopup({ popup: oneClick ? '' : POPUP_PAGE });
    await chrome.action.setTitle({
      title: oneClick ? 'capture-kit — click to capture' : 'capture-kit',
    });
  } catch (error) {
    console.error('[capture-kit] could not set the action popup:', error);
  }
  try {
    // The menu item only earns its place in the icon's right-click menu while
    // the popup is unreachable by clicking. Chrome already puts "Options"
    // there, so settings are never stranded either way.
    await chrome.contextMenus.update(PANEL_MENU_ID, { visible: oneClick });
  } catch {
    /* the item may not exist yet on the very first run; onInstalled creates it */
  }
}

async function syncActionMode(): Promise<void> {
  const settings = await getSettings();
  await applyActionPopup(settings.iconCapturesImmediately);
}

/**
 * The popup surface, reached from the icon's right-click menu.
 *
 * chrome.action.openPopup() is the real answer but it is Chrome 127+, and
 * minimum_chrome_version here is 116. Rather than raise the floor for one menu
 * item, it is feature-detected and falls back to opening the same document as
 * a small window — the pattern the session picker already uses for the same
 * reason (a popup cannot outlive the click that opened it).
 */
async function openPanel(): Promise<void> {
  try {
    if (typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return;
    }
  } catch {
    /* no user activation, or the icon is not visible — fall through */
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(POPUP_PAGE),
      type: 'popup',
      width: 380,
      height: 560,
    });
  } catch (error) {
    console.error('[capture-kit] could not open the panel:', error);
  }
}

chrome.action.onClicked.addListener(() => {
  void captureBundle('icon');
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === PANEL_MENU_ID) void openPanel();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      // removeAll first: onInstalled fires on every reload of an unpacked
      // extension, and create() on a duplicate id throws.
      await chrome.contextMenus.removeAll();
      chrome.contextMenus.create({
        id: PANEL_MENU_ID,
        title: 'Open capture-kit panel',
        contexts: ['action'],
        visible: false,
      });
    } catch (error) {
      console.error('[capture-kit] could not create the icon menu:', error);
    }
    await syncActionMode();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void syncActionMode();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && ICON_MODE_KEY in changes) void syncActionMode();
});

// Every worker wake. Covers the gap between onInstalled and onStartup — an
// idle worker torn down and revived mid-session.
void syncActionMode();
