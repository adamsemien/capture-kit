import type {
  BufferStats,
  CaptureResponse,
  LastBundle,
  LastError,
  SweepResponse,
} from '../lib/messages';
import { CAPTURE_PROGRESS_KEY, SESSION_SEED_TAB_KEY } from '../lib/messages';
import type { CaptureProgressState } from '../lib/messages';
import { getSettings, setImageOnlyPng } from '../lib/settings';

const statusEl = document.getElementById('status') as HTMLParagraphElement;
const statsEl = document.getElementById('stats') as HTMLParagraphElement;
const statsTextEl = document.getElementById('stats-text') as HTMLSpanElement;
const capturePageBtn = document.getElementById('capture-page') as HTMLButtonElement;
const captureBundleBtn = document.getElementById('capture-bundle') as HTMLButtonElement;
const responsiveSweepBtn = document.getElementById('responsive-sweep') as HTMLButtonElement;
const imageOnlyPngInput = document.getElementById('image-only-png') as HTMLInputElement;
const captureSessionBtn = document.getElementById('capture-session') as HTMLButtonElement;
const copyLastBtn = document.getElementById('copy-last') as HTMLButtonElement;

function setStatus(text: string, kind: '' | 'ok' | 'error' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function setBusy(busy: boolean): void {
  for (const button of [
    capturePageBtn,
    captureBundleBtn,
    responsiveSweepBtn,
    copyLastBtn,
    captureSessionBtn,
  ]) {
    button.disabled = busy;
  }
}

/**
 * Segment counts while a capture runs. The worker publishes them to
 * chrome.storage.session, so this follows a capture the popup did not start —
 * open the popup mid one-click capture and it says where the capture is up to
 * instead of looking idle.
 */
function watchCaptureProgress(): void {
  const render = (progress: CaptureProgressState | undefined) => {
    if (!progress || progress.state !== 'running') return;
    if (progress.total > 1) {
      setStatus(`Capturing — segment ${progress.done} of ${progress.total}…`);
    } else {
      setStatus('Capturing…');
    }
  };
  void chrome.storage.session
    .get(CAPTURE_PROGRESS_KEY)
    .then((stored) => render(stored[CAPTURE_PROGRESS_KEY] as CaptureProgressState | undefined));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !(CAPTURE_PROGRESS_KEY in changes)) return;
    render(changes[CAPTURE_PROGRESS_KEY].newValue as CaptureProgressState | undefined);
  });
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

function showRecorderInactive(): void {
  statsTextEl.textContent = "Not listening yet — reload this tab and I'll catch the console";
  statsEl.className = 'stats warn';
}

async function refreshStats(): Promise<void> {
  try {
    const tabId = await activeTabId();
    if (tabId === null) throw new Error('no tab');
    const stats = (await chrome.tabs.sendMessage(tabId, { type: 'GET_STATS' })) as BufferStats;
    if (!stats.mainWorldActive) {
      showRecorderInactive();
      return;
    }
    statsEl.className = 'stats';
    const parts: string[] = [];
    if (stats.consoleCount) {
      parts.push(`${stats.consoleCount} console ${stats.consoleCount === 1 ? 'entry' : 'entries'}`);
    }
    if (stats.networkCount) {
      parts.push(
        `${stats.networkCount} network ${stats.networkCount === 1 ? 'failure' : 'failures'}`,
      );
    }
    statsTextEl.textContent = parts.length
      ? `Listening — ${parts.join(', ')} buffered`
      : 'Listening — nothing to report yet';
  } catch {
    showRecorderInactive();
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

captureBundleBtn.addEventListener('click', () => {
  void (async () => {
    setBusy(true);
    setStatus('Capturing…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_BUNDLE',
    })) as CaptureResponse;
    if (response.ok) {
      const copied = response.markdown ? await copyToClipboard(response.markdown) : false;
      // Name the format actually written — this used to always say PNG.
      const imageKind = response.imageFilename.endsWith('.png') ? 'PNG' : 'JPEG';
      setStatus(
        copied
          ? `Saved the ${imageKind} and report — report is on your clipboard.`
          : `Saved the ${imageKind} and report.`,
        'ok',
      );
    } else {
      setStatus(response.reason, 'error');
    }
    setBusy(false);
    void refreshStats();
  })();
});

capturePageBtn.addEventListener('click', () => {
  void (async () => {
    setBusy(true);
    setStatus('Capturing…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_PAGE',
      png: imageOnlyPngInput.checked,
    })) as CaptureResponse;
    if (response.ok) {
      setStatus(`Saved ${response.imageFilename}.`, 'ok');
    } else {
      setStatus(response.reason, 'error');
    }
    setBusy(false);
  })();
});

responsiveSweepBtn.addEventListener('click', () => {
  void (async () => {
    setBusy(true);
    setStatus('Capturing 375, 768 and 1440…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_SWEEP',
    })) as SweepResponse;
    if (response.ok) {
      if (response.failed.length === 0) {
        setStatus(`Saved all ${response.saved.length} widths.`, 'ok');
      } else {
        const savedText = response.saved.map((w) => `w${w}`).join(', ');
        const failedText = response.failed
          .map((f) => `w${f.width} failed: ${f.reason}`)
          .join('; ');
        setStatus(`Saved ${savedText} — ${failedText}`, 'ok');
      }
    } else {
      setStatus(response.reason, 'error');
    }
    setBusy(false);
  })();
});

copyLastBtn.addEventListener('click', () => {
  void (async () => {
    const { lastBundle } = (await chrome.storage.session.get('lastBundle')) as {
      lastBundle?: LastBundle;
    };
    if (!lastBundle) {
      setStatus('Nothing captured yet in this browser session.', 'error');
      return;
    }
    const copied = await copyToClipboard(lastBundle.markdown);
    setStatus(
      copied
        ? `Copied report from ${new Date(lastBundle.at).toLocaleTimeString()}.`
        : 'Could not reach the clipboard.',
      copied ? 'ok' : 'error',
    );
  })();
});

captureSessionBtn.addEventListener('click', () => {
  void (async () => {
    // Hand the picker the tab the user was actually looking at — opening the
    // picker makes the picker active, so it cannot work that out itself.
    const seedTabId = await activeTabId();
    try {
      await chrome.storage.session.set({ [SESSION_SEED_TAB_KEY]: seedTabId });
    } catch {
      /* the picker simply starts with nothing pre-checked */
    }
    // The picker runs as a page, not in here: the popup closes the moment the
    // run switches tabs, and a session capture must outlive that.
    await chrome.tabs.create({ url: chrome.runtime.getURL('session/session.html') });
    window.close();
  })();
});

imageOnlyPngInput.addEventListener('change', () => {
  void setImageOnlyPng(imageOnlyPngInput.checked);
});

void (async () => {
  imageOnlyPngInput.checked = (await getSettings()).imageOnlyPng;
  watchCaptureProgress();
  await refreshStats();
  // Surface the most recent shortcut-triggered failure (there was no popup
  // open to show it at the time).
  const { lastError } = (await chrome.storage.session.get('lastError')) as {
    lastError?: LastError;
  };
  if (lastError && Date.now() - lastError.at < 30_000 && !statusEl.textContent) {
    setStatus(lastError.reason, 'error');
  }
})();
