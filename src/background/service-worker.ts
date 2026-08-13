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
import { buildBundleMarkdown, buildClipboardMarkdown } from '../lib/bundle/markdown';
import { captureBasename } from '../lib/bundle/filename';
import { textToBase64 } from '../lib/base64';
import { getSettings } from '../lib/settings';
import type {
  BufferSnapshot,
  CaptureResponse,
  LastBundle,
  LastError,
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

// Re-assert our intended filename during Chrome's filename-determination
// phase. Third-party extensions (download managers) that listen to
// onDeterminingFilename override the filename passed to downloads.download(),
// which is how every capture ends up as "download (1)". Among competing
// listeners Chrome lets the most recently installed extension win — for an
// unpacked extension that is us. Our downloads are initiated sequentially
// (each awaited), so a FIFO of intended names maps onto event order.
interface IntendedDownload {
  filename: string;
  conflictAction: 'overwrite' | 'uniquify';
}
const intendedDownloads: IntendedDownload[] = [];

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }
  const intended = intendedDownloads.shift();
  if (intended) {
    suggest({ filename: intended.filename, conflictAction: intended.conflictAction });
  } else {
    suggest();
  }
});

async function downloadBase64(
  filename: string,
  mime: string,
  base64: string,
  overwrite = false,
): Promise<number> {
  const fullPath = `${DOWNLOAD_SUBFOLDER}/${filename}`;
  const conflictAction: 'overwrite' | 'uniquify' = overwrite ? 'overwrite' : 'uniquify';
  console.log(`[capture-kit] download filename: "${fullPath}" (${conflictAction})`);
  intendedDownloads.push({ filename: fullPath, conflictAction });
  try {
    return await chrome.downloads.download({
      url: `data:${mime};base64,${base64}`,
      filename: fullPath,
      conflictAction,
    });
  } catch (error) {
    // Keep the FIFO in sync — a rejected call never reaches the determiner.
    const index = intendedDownloads.findIndex((d) => d.filename === fullPath);
    if (index !== -1) intendedDownloads.splice(index, 1);
    console.error(`[capture-kit] downloads.download rejected "${fullPath}":`, error);
    throw error;
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
    });
    const clipboardMarkdown = buildClipboardMarkdown(markdown, imageFilename);

    const imageMime = isJpeg ? 'image/jpeg' : 'image/png';
    await downloadBase64(imageFilename, imageMime, result.imageBase64);
    await downloadBase64(`${basename}.md`, 'text/markdown', textToBase64(markdown));
    // Stable pointers for the AI-agent bridge; the Image: line in the
    // markdown keeps them referencing the archived timestamped copy.
    await downloadBase64(`latest.${isJpeg ? 'jpg' : 'png'}`, imageMime, result.imageBase64, true);
    await downloadBase64('latest.md', 'text/markdown', textToBase64(markdown), true);

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
    await downloadBase64(imageFilename, 'image/png', result.imageBase64);
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
    for (const capture of outcome.captures) {
      await downloadBase64(
        `${basename}_w${capture.width}.jpg`,
        'image/jpeg',
        capture.result.imageBase64,
      );
    }

    if (outcome.captures.length === 0) {
      const reason = outcome.failures[0]?.reason ?? 'Sweep produced no captures.';
      await recordError(reason, false);
      return { ok: false, reason };
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
  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-bundle') void captureBundle(true);
});
