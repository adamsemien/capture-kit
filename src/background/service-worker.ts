// MV3 service worker: capture orchestration, downloads, error reporting.
//
// Worker-death posture: this worker owns no long-lived state. Ring buffers
// live in the content script (page lifetime); the last bundle and last error
// live in chrome.storage.session; settings live in chrome.storage.sync. A
// capture is one self-contained async invocation whose state is all local
// variables — if the worker dies mid-capture, the capture fails cleanly and
// nothing is corrupted.

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
} from '../lib/bundle/markdown';
import { captureBasename, slugify, timestampForFilename } from '../lib/bundle/filename';
import { buildSessionIndex } from '../lib/session/manifest';
import type { SessionFailure, SessionPage } from '../lib/session/manifest';
import { textToBase64 } from '../lib/base64';
import { getSettings } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { CONSOLE_LOGS_IN_BUNDLE, SESSION_PROGRESS_KEY, SESSION_SUMMARY_KEY } from '../lib/messages';
import type {
  BufferSnapshot,
  CaptureResponse,
  CaptureResultMeta,
  ConsoleEntry,
  FilenameConflict,
  LastBundle,
  LastError,
  NetworkFailure,
  ResultImagePayload,
  RuntimeMessage,
  SessionProgress,
  SessionSummary,
  SessionTab,
  SweepResponse,
} from '../lib/messages';

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

// Tripwire results for the capture in flight. Captures are user-driven and
// sequential, so a single drain point is enough; the result tab renders
// whatever this collects, because a console warning is invisible to a user.
const pendingNameChecks: Promise<FilenameConflict | null>[] = [];

/** Tripwire: report if what landed on disk isn't what we asked for. */
async function verifyDownloadedName(
  id: number,
  requested: string,
): Promise<FilenameConflict | null> {
  try {
    await waitForDownloadComplete(id);
    const [item] = await chrome.downloads.search({ id });
    if (!item?.filename) return null;
    const saved = item.filename.split(/[\\/]/).pop() ?? '';
    const expected = requested.split('/').pop() ?? '';
    if (saved === expected) return null;
    console.warn(
      `[capture-kit] filename was overridden: requested "${expected}", saved as "${saved}". ` +
        'Another extension is claiming chrome.downloads.onDeterminingFilename.',
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
  const id = await downloadBase64(filename, mime, base64, true);
  await waitForDownloadComplete(id);
  try {
    await chrome.downloads.erase({ id });
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

async function flashBadge(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
    }, 5000);
  } catch {
    /* badge is best-effort */
  }
}

async function recordError(reason: string, viaCommand: boolean): Promise<void> {
  const lastError: LastError = { reason, at: Date.now() };
  try {
    await chrome.storage.session.set({ lastError });
  } catch {
    /* best-effort */
  }
  if (viaCommand) await flashBadge('!', '#b03a2e');
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
  errors: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  warningCount: number;
  recorderActive: boolean;
  imageMime: string;
  imageDownloadId: number;
  result: Awaited<ReturnType<typeof captureFullPage>>;
  title: string;
  url: string;
}

/** `folder` is a path inside capture-kit/, e.g. "session_2026-08-14_10-35/". */
async function captureReport(
  tab: chrome.tabs.Tab,
  settings: Settings,
  folder = '',
  /** Ordinal for the mirror copy ("01"); the extension follows the real format. */
  mirrorBasename?: string,
): Promise<ReportArtifacts> {
  const tabId = tab.id as number;
  const { snapshot, recorderActive } = await getSnapshot(tabId);
  const result = await captureFullPage({
    tabId,
    segmentSize: settings.segmentSize,
    format: settings.bundleFormat,
  });

  const capturedAt = new Date();
  const basename = captureBasename(
    snapshot?.meta.title || tab.title || '',
    snapshot?.meta.url || tab.url,
    capturedAt,
  );
  const isJpeg = result.format === 'jpeg';
  const imageFilename = `${basename}.${isJpeg ? 'jpg' : 'png'}`;
  const markdownFilename = `${basename}.md`;
  const meta = snapshot?.meta ?? {
    url: tab.url ?? '',
    title: tab.title ?? '',
    viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    userAgent: navigator.userAgent,
  };
  const consoleEntries = snapshot?.console ?? [];
  const networkFailures = snapshot?.network ?? [];

  const markdownInput = {
    meta,
    contentSize: result.contentSize,
    fullSize: result.fullSize,
    truncated: result.truncated,
    consoleEntries,
    networkFailures,
    recorderActive,
    includeLogs: settings.includeConsoleLogs,
    capturedAt,
    imageFilename,
    captureMode: result.mode,
    revealForced: result.revealForced,
    segments: result.segments,
  };
  const markdown = buildBundleMarkdown(markdownInput);
  const mirrorImageFilename = mirrorBasename
    ? `${mirrorBasename}.${isJpeg ? 'jpg' : 'png'}`
    : null;
  const mirrorMarkdown = mirrorImageFilename
    ? buildBundleMarkdown({ ...markdownInput, imageFilename: mirrorImageFilename })
    : null;

  const errors = consoleEntries.filter((e) => e.level === 'error');
  const warningCount = consoleEntries.filter((e) => e.level === 'warn').length;
  const logCount = consoleEntries.filter((e) => e.level === 'log').length;
  const imageMime = isJpeg ? 'image/jpeg' : 'image/png';
  const imageDownloadId = await downloadBase64(
    `${folder}${imageFilename}`,
    imageMime,
    result.imageBase64,
  );
  await downloadBase64(`${folder}${markdownFilename}`, 'text/markdown', textToBase64(markdown));

  return {
    capturedAt,
    basename,
    imageFilename,
    markdownFilename,
    markdown,
    mirrorMarkdown,
    mirrorImageFilename,
    clipboardMarkdown: buildClipboardMarkdown(markdown, imageFilename),
    contents: buildContentsLine({
      truncated: result.truncated,
      fullSize: result.fullSize,
      contentSize: result.contentSize,
      recorderActive,
      errors: errors.length,
      warnings: warningCount,
      logs: settings.includeConsoleLogs ? Math.min(logCount, CONSOLE_LOGS_IN_BUNDLE) : 0,
      networkFailures: networkFailures.length,
    }),
    errors,
    networkFailures,
    warningCount,
    recorderActive,
    imageMime,
    imageDownloadId,
    result,
    title: meta.title || tab.title || '',
    url: meta.url || tab.url || '',
  };
}

async function captureBundle(viaCommand: boolean): Promise<CaptureResponse> {
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, viaCommand);
      return { ok: false, reason: blocked };
    }
    const tabId = tab.id as number;
    const settings = await getSettings();

    const report = await captureReport(tab, settings);
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
      await downloadLatestPointer('latest.md', 'text/markdown', textToBase64(markdown));
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

    // Best-effort page-side clipboard write. On the keyboard-shortcut path
    // the page is the focused document, so this is the write that lands; when
    // the popup is open instead, this quietly fails and the popup (which has
    // focus) writes the clipboard from the response below.
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'COPY_TEXT', text: clipboardMarkdown });
    } catch {
      /* no recorder to copy through */
    }

    if (settings.openResult) {
      await openResultTab(
        {
          kind: 'bundle',
          captureModeLabel: captureModeLabel(result.mode, result.revealForced, result.segments),
          filenameConflicts: await collectFilenameConflicts(),
          images: [
            {
              filename: imageFilename,
              width: result.fullSize.width,
              height: result.fullSize.height,
              bytes: base64Bytes(result.imageBase64),
              downloadId: imageDownloadId,
            },
          ],
          markdown,
          createdAt: capturedAt.getTime(),
        },
        [{ mime: imageMime, base64: result.imageBase64 }],
      );
    }

    if (viaCommand) await flashBadge('OK', '#1e8449');
    return { ok: true, imageFilename, markdown: clipboardMarkdown };
  } catch (error) {
    const reason = describeError(error);
    console.error('[capture-kit] bundle capture failed:', error);
    await recordError(reason, viaCommand);
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
    const result = await captureFullPage({
      tabId: tab.id as number,
      segmentSize: settings.segmentSize,
      format,
    });
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const imageFilename = `${captureBasename(tab.title || '', tab.url, new Date())}.${
      format === 'png' ? 'png' : 'jpg'
    }`;
    const downloadId = await downloadBase64(imageFilename, mime, result.imageBase64);
    if (settings.openResult) {
      await openResultTab(
        {
          kind: 'page',
          captureModeLabel: captureModeLabel(result.mode, result.revealForced, result.segments),
          filenameConflicts: await collectFilenameConflicts(),
          images: [
            {
              filename: imageFilename,
              width: result.fullSize.width,
              height: result.fullSize.height,
              bytes: base64Bytes(result.imageBase64),
              downloadId,
            },
          ],
          createdAt: Date.now(),
        },
        [{ mime, base64: result.imageBase64 }],
      );
    }
    return { ok: true, imageFilename };
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

    // Inner-scroll expansion applies once for the whole sweep, restored at
    // the end — same detection the single captures run.
    const expanded = await detectInnerScroll(tabId);
    if (expanded) await applyInnerScrollExpansion(tabId);
    let outcome;
    try {
      outcome = await captureSweep(tabId, settings.segmentSize);
    } finally {
      if (expanded) await restoreInnerScrollExpansion(tabId);
    }

    const basename = captureBasename(tab.title || '', tab.url, new Date());
    const downloadIds: number[] = [];
    for (const capture of outcome.captures) {
      downloadIds.push(
        await downloadBase64(
          `${basename}_w${capture.width}.jpg`,
          'image/jpeg',
          capture.result.imageBase64,
        ),
      );
    }

    if (outcome.captures.length === 0) {
      const reason = outcome.failures[0]?.reason ?? 'Sweep produced no captures.';
      await recordError(reason, false);
      return { ok: false, reason };
    }

    // A sweep is a one-page session: it writes a report alongside the images.
    const sweepMarkdown = buildSweepMarkdown({
      meta: snapshot?.meta ?? {
        url: tab.url ?? '',
        title: tab.title ?? '',
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
        userAgent: navigator.userAgent,
      },
      capturedAt: new Date(),
      widths: outcome.captures.map((capture) => ({
        width: capture.width,
        filename: `${basename}_w${capture.width}.jpg`,
        fullSize: capture.result.fullSize,
        contentSize: capture.result.contentSize,
        truncated: capture.result.truncated,
        captureMode: capture.result.mode,
        revealForced: capture.result.revealForced,
        segments: capture.result.segments,
      })),
      failures: outcome.failures,
      consoleEntries: snapshot?.console ?? [],
      networkFailures: snapshot?.network ?? [],
      recorderActive,
      includeLogs: settings.includeConsoleLogs,
    });
    await downloadBase64(`${basename}_sweep.md`, 'text/markdown', textToBase64(sweepMarkdown));

    if (settings.openResult) {
      const first = outcome.captures[0].result;
      await openResultTab(
        {
          kind: 'sweep',
          captureModeLabel: captureModeLabel(first.mode, first.revealForced, first.segments),
          filenameConflicts: await collectFilenameConflicts(),
          images: outcome.captures.map((capture, index) => ({
            filename: `${basename}_w${capture.width}.jpg`,
            label: `${capture.width} px`,
            width: capture.result.fullSize.width,
            height: capture.result.fullSize.height,
            bytes: base64Bytes(capture.result.imageBase64),
            downloadId: downloadIds[index],
          })),
          markdown: sweepMarkdown,
          createdAt: Date.now(),
        },
        outcome.captures.map((capture) => ({
          mime: 'image/jpeg',
          base64: capture.result.imageBase64,
        })),
      );
    }
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
        title = tab.title ?? '';
        url = tab.url ?? '';
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
        const report = await captureReport(fresh, settings, folder, ordinal);
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
          networkFailures: report.networkFailures,
          warningCount: report.warningCount,
          recorderActive: report.recorderActive,
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
    const indexDownloadId = await downloadBase64(
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

    const summary: SessionSummary = {
      folder: `capture-kit/${folderName}`,
      pointerFolder: `capture-kit/${SESSION_POINTER_FOLDER}`,
      pages: pages.length,
      withIssues: pages.filter((p) => p.errors.length || p.networkFailures.length).length,
      failures: failures.map((f) => ({ title: f.title || f.url, reason: f.reason })),
      timings,
      totalMs,
      cancelled: sessionCancelled,
      indexDownloadId,
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
  const id = await downloadBase64(filename, mime, base64, true);
  await waitForDownloadComplete(id);
  try {
    await chrome.downloads.erase({ id });
  } catch {
    /* record cleanup is best-effort; the file is already written */
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.type === 'CAPTURE_BUNDLE') {
    void captureBundle(false).then(sendResponse);
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
  if (command === 'capture-bundle') void captureBundle(true);
});
