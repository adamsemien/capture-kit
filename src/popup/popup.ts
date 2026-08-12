import type { BufferStats, CaptureResponse, LastBundle, LastError } from '../lib/messages';

const statusEl = document.getElementById('status') as HTMLParagraphElement;
const statsEl = document.getElementById('stats') as HTMLParagraphElement;
const capturePageBtn = document.getElementById('capture-page') as HTMLButtonElement;
const captureBundleBtn = document.getElementById('capture-bundle') as HTMLButtonElement;
const copyLastBtn = document.getElementById('copy-last') as HTMLButtonElement;

function setStatus(text: string, kind: '' | 'ok' | 'error' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function setBusy(busy: boolean): void {
  for (const button of [capturePageBtn, captureBundleBtn, copyLastBtn]) {
    button.disabled = busy;
  }
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function refreshStats(): Promise<void> {
  try {
    const tabId = await activeTabId();
    if (tabId === null) throw new Error('no tab');
    const stats = (await chrome.tabs.sendMessage(tabId, { type: 'GET_STATS' })) as BufferStats;
    const consoleWord = stats.consoleCount === 1 ? 'entry' : 'entries';
    const networkWord = stats.networkCount === 1 ? 'failure' : 'failures';
    statsEl.textContent = `${stats.consoleCount} console ${consoleWord}, ${stats.networkCount} network ${networkWord} recorded on this page.`;
  } catch {
    statsEl.textContent = 'Recorder not active on this page.';
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
      setStatus(
        copied
          ? 'Done — PNG + markdown downloaded, markdown copied.'
          : 'Done — PNG + markdown downloaded.',
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
    const response = (await chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE' })) as CaptureResponse;
    if (response.ok) {
      setStatus(`Done — saved ${response.pngFilename}.`, 'ok');
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
      setStatus('No bundle captured yet this browser session.', 'error');
      return;
    }
    const copied = await copyToClipboard(lastBundle.markdown);
    setStatus(
      copied
        ? `Copied bundle from ${new Date(lastBundle.at).toLocaleTimeString()}.`
        : 'Clipboard write failed.',
      copied ? 'ok' : 'error',
    );
  })();
});

void (async () => {
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
