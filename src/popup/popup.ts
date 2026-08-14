import type {
  BufferStats,
  CaptureResponse,
  LastBundle,
  LastError,
  SweepResponse,
} from '../lib/messages';
import { getSettings, setImageOnlyPng } from '../lib/settings';

const statusEl = document.getElementById('status') as HTMLParagraphElement;
const statsEl = document.getElementById('stats') as HTMLParagraphElement;
const capturePageBtn = document.getElementById('capture-page') as HTMLButtonElement;
const captureBundleBtn = document.getElementById('capture-bundle') as HTMLButtonElement;
const responsiveSweepBtn = document.getElementById('responsive-sweep') as HTMLButtonElement;
const imageOnlyPngInput = document.getElementById('image-only-png') as HTMLInputElement;
const copyLastBtn = document.getElementById('copy-last') as HTMLButtonElement;

function setStatus(text: string, kind: '' | 'ok' | 'error' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function setBusy(busy: boolean): void {
  for (const button of [capturePageBtn, captureBundleBtn, responsiveSweepBtn, copyLastBtn]) {
    button.disabled = busy;
  }
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

function showRecorderInactive(): void {
  statsEl.textContent =
    'Recorder not active — reload this tab to record console/network data.';
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
    const consoleWord = stats.consoleCount === 1 ? 'entry' : 'entries';
    const networkWord = stats.networkCount === 1 ? 'failure' : 'failures';
    statsEl.className = 'stats';
    statsEl.textContent = `${stats.consoleCount} console ${consoleWord}, ${stats.networkCount} network ${networkWord} recorded on this page.`;
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
    setStatus('capturing…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_BUNDLE',
    })) as CaptureResponse;
    if (response.ok) {
      const copied = response.markdown ? await copyToClipboard(response.markdown) : false;
      // Name the format actually written — this used to always say PNG.
      const imageKind = response.imageFilename.endsWith('.png') ? 'PNG' : 'JPEG';
      setStatus(
        copied
          ? `Done — ${imageKind} + report downloaded, report copied.`
          : `Done — ${imageKind} + report downloaded.`,
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
    setStatus('capturing…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_PAGE',
      png: imageOnlyPngInput.checked,
    })) as CaptureResponse;
    if (response.ok) {
      setStatus(`Done — saved ${response.imageFilename}.`, 'ok');
    } else {
      setStatus(response.reason, 'error');
    }
    setBusy(false);
  })();
});

responsiveSweepBtn.addEventListener('click', () => {
  void (async () => {
    setBusy(true);
    setStatus('sweeping 375 / 768 / 1440…');
    const response = (await chrome.runtime.sendMessage({
      type: 'CAPTURE_SWEEP',
    })) as SweepResponse;
    if (response.ok) {
      if (response.failed.length === 0) {
        setStatus(`Done — ${response.saved.length} widths saved.`, 'ok');
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
      setStatus('No report captured yet this browser session.', 'error');
      return;
    }
    const copied = await copyToClipboard(lastBundle.markdown);
    setStatus(
      copied
        ? `Copied report from ${new Date(lastBundle.at).toLocaleTimeString()}.`
        : 'Clipboard write failed.',
      copied ? 'ok' : 'error',
    );
  })();
});

imageOnlyPngInput.addEventListener('change', () => {
  void setImageOnlyPng(imageOnlyPngInput.checked);
});

void (async () => {
  imageOnlyPngInput.checked = (await getSettings()).imageOnlyPng;
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
