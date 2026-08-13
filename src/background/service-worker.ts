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
import { buildBundleMarkdown, buildClipboardMarkdown, captureModeLabel } from '../lib/bundle/markdown';
import { captureBasename } from '../lib/bundle/filename';
import { textToBase64 } from '../lib/base64';
import { getSettings } from '../lib/settings';
import type {
  BufferSnapshot,
  CaptureResponse,
  CaptureResultMeta,
  LastBundle,
  LastError,
  ResultImagePayload,
  RuntimeMessage,
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
  void verifyDownloadedName(id, fullPath);
  return id;
}

/** Tripwire: warn if what landed on disk isn't what we asked for. */
async function verifyDownloadedName(id: number, requested: string): Promise<void> {
  try {
    await waitForDownloadComplete(id);
    const [item] = await chrome.downloads.search({ id });
    if (!item?.filename) return;
    const actual = item.filename.split(/[\\/]/).pop() ?? '';
    const expected = requested.split('/').pop() ?? '';
    if (actual !== expected) {
      console.warn(
        `[capture-kit] filename was overridden: requested "${expected}", saved as "${actual}". ` +
          'Another extension is claiming chrome.downloads.onDeterminingFilename.',
      );
    }
  } catch {
    /* the tripwire must never affect the capture */
  }
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

async function captureBundle(viaCommand: boolean): Promise<CaptureResponse> {
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, viaCommand);
      return { ok: false, reason: blocked };
    }
    const tabId = tab.id as number;

    const { snapshot, recorderActive } = await getSnapshot(tabId);
    const settings = await getSettings();
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

    const markdown = buildBundleMarkdown({
      meta: snapshot?.meta ?? {
        url: tab.url ?? '',
        title: tab.title ?? '',
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
        userAgent: navigator.userAgent,
      },
      contentSize: result.contentSize,
      fullSize: result.fullSize,
      truncated: result.truncated,
      consoleEntries: snapshot?.console ?? [],
      networkFailures: snapshot?.network ?? [],
      recorderActive,
      includeLogs: settings.includeConsoleLogs,
      capturedAt,
      imageFilename,
      captureMode: result.mode,
      revealForced: result.revealForced,
      segments: result.segments,
    });
    const clipboardMarkdown = buildClipboardMarkdown(markdown, imageFilename);

    const imageMime = isJpeg ? 'image/jpeg' : 'image/png';
    const imageDownloadId = await downloadBase64(imageFilename, imageMime, result.imageBase64);
    await downloadBase64(`${basename}.md`, 'text/markdown', textToBase64(markdown));
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

async function capturePage(): Promise<CaptureResponse> {
  try {
    const tab = await activeTab();
    const blocked = protectedPageReason(tab.url);
    if (blocked) {
      await recordError(blocked, false);
      return { ok: false, reason: blocked };
    }
    const settings = await getSettings();
    // The Capture Page button is PNG-only by contract.
    const result = await captureFullPage({
      tabId: tab.id as number,
      segmentSize: settings.segmentSize,
      format: 'png',
    });
    const imageFilename = `${captureBasename(tab.title || '', tab.url, new Date())}.png`;
    const downloadId = await downloadBase64(imageFilename, 'image/png', result.imageBase64);
    if (settings.openResult) {
      await openResultTab(
        {
          kind: 'page',
          captureModeLabel: captureModeLabel(result.mode, result.revealForced, result.segments),
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
        [{ mime: 'image/png', base64: result.imageBase64 }],
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

    if (settings.openResult) {
      const first = outcome.captures[0].result;
      await openResultTab(
        {
          kind: 'sweep',
          captureModeLabel: captureModeLabel(first.mode, first.revealForced, first.segments),
          images: outcome.captures.map((capture, index) => ({
            filename: `${basename}_w${capture.width}.jpg`,
            label: `${capture.width} px`,
            width: capture.result.fullSize.width,
            height: capture.result.fullSize.height,
            bytes: base64Bytes(capture.result.imageBase64),
            downloadId: downloadIds[index],
          })),
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

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.type === 'CAPTURE_BUNDLE') {
    void captureBundle(false).then(sendResponse);
    return true;
  }
  if (message?.type === 'CAPTURE_PAGE') {
    void capturePage().then(sendResponse);
    return true;
  }
  if (message?.type === 'CAPTURE_SWEEP') {
    void captureResponsiveSweep().then(sendResponse);
    return true;
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
