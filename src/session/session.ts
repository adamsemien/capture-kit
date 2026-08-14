import type { SessionProgress, SessionSummary, SessionTab } from '../lib/messages';
import {
  SESSION_PROGRESS_KEY,
  SESSION_SEED_TAB_KEY,
  SESSION_SUMMARY_KEY,
} from '../lib/messages';

const setupEl = document.getElementById('setup') as HTMLElement;
const progressEl = document.getElementById('progress') as HTMLElement;
const summaryEl = document.getElementById('summary') as HTMLElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const selectionCountEl = document.getElementById('selection-count') as HTMLSpanElement;
const reloadInput = document.getElementById('reload-first') as HTMLInputElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const selectAllBtn = document.getElementById('select-all') as HTMLButtonElement;
const selectNoneBtn = document.getElementById('select-none') as HTMLButtonElement;
const setupStatusEl = document.getElementById('setup-status') as HTMLSpanElement;
const progressLineEl = document.getElementById('progress-line') as HTMLParagraphElement;
const progressCountEl = document.getElementById('progress-count') as HTMLParagraphElement;
const barFillEl = document.getElementById('bar-fill') as HTMLDivElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const summaryHeadEl = document.getElementById('summary-head') as HTMLHeadingElement;
const tallyPagesEl = document.getElementById('tally-pages') as HTMLSpanElement;
const tallyIssuesEl = document.getElementById('tally-issues') as HTMLSpanElement;
const tallyTimeEl = document.getElementById('tally-time') as HTMLSpanElement;
const summaryFolderEl = document.getElementById('summary-folder') as HTMLSpanElement;
const handoffEl = document.getElementById('handoff') as HTMLDivElement;
const handoffTextEl = document.getElementById('handoff-text') as HTMLPreElement;
const copyInstructionBtn = document.getElementById('copy-instruction') as HTMLButtonElement;
const showFolderBtn = document.getElementById('show-folder') as HTMLButtonElement;
const summaryStatusEl = document.getElementById('summary-status') as HTMLSpanElement;
const summaryFailuresEl = document.getElementById('summary-failures') as HTMLDivElement;

const checkboxes = new Map<number, HTMLInputElement>();

function updateSelectionCount(): void {
  const selected = [...checkboxes.values()].filter((c) => c.checked).length;
  const tabWord = checkboxes.size === 1 ? 'tab' : 'tabs';
  selectionCountEl.textContent = `${selected} of ${checkboxes.size} ${tabWord} selected`;
  startBtn.disabled = selected === 0;
}

function renderTabs(tabs: SessionTab[], seedTabId: number | undefined): void {
  tabsEl.replaceChildren();
  checkboxes.clear();
  for (const tab of tabs) {
    const row = document.createElement('label');
    row.className = tab.blockedReason ? 'tab-row blocked' : 'tab-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    if (tab.blockedReason) {
      checkbox.disabled = true;
    } else {
      checkbox.checked = seedTabId === undefined ? tab.active : tab.id === seedTabId;
      checkbox.addEventListener('change', updateSelectionCount);
      checkboxes.set(tab.id, checkbox);
    }
    row.appendChild(checkbox);

    if (tab.favIconUrl) {
      const icon = document.createElement('img');
      icon.src = tab.favIconUrl;
      icon.alt = '';
      // A broken favicon must not leave a broken-image glyph in the row.
      icon.addEventListener('error', () => icon.replaceWith(noIcon()));
      row.appendChild(icon);
    } else {
      row.appendChild(noIcon());
    }

    const text = document.createElement('div');
    text.className = 'tab-text';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'Untitled tab';
    const sub = document.createElement('div');
    sub.className = 'tab-sub';
    sub.textContent = tab.blockedReason ?? tab.url;
    text.append(title, sub);
    row.appendChild(text);

    tabsEl.appendChild(row);
  }
  updateSelectionCount();
}

function noIcon(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'no-icon';
  return span;
}

function showProgress(progress: SessionProgress): void {
  setupEl.hidden = true;
  progressEl.hidden = false;
  progressLineEl.textContent =
    progress.state === 'running' ? `Capturing ${progress.title}` : 'Wrapping up…';
  progressCountEl.textContent =
    progress.state === 'running' ? `Page ${progress.current} of ${progress.total}` : '';
  const pct = progress.total ? (progress.current / progress.total) * 100 : 0;
  barFillEl.style.width = `${pct}%`;
}

function handoffInstruction(summary: SessionSummary): string {
  const pageWord = summary.pages === 1 ? 'page' : 'pages';
  return (
    `Read ~/Downloads/${summary.pointerFolder}/index.md — it indexes the ${summary.pages} ` +
    `${pageWord} I just captured, with the console errors and network failures for each. ` +
    'Open the per-page .md files it references (same folder) for a full report, and the ' +
    'matching image to see what the page looked like.'
  );
}

function showSummary(summary: SessionSummary): void {
  setupEl.hidden = true;
  progressEl.hidden = true;
  summaryEl.hidden = false;

  summaryHeadEl.textContent = summary.cancelled
    ? 'Stopped early — here is what was captured'
    : 'Session captured';

  tallyPagesEl.textContent = String(summary.pages);
  tallyIssuesEl.textContent = String(summary.withIssues);
  tallyIssuesEl.classList.toggle('has-errors', summary.withIssues > 0);
  tallyTimeEl.textContent = `${(summary.totalMs / 1000).toFixed(1)}s`;
  // Two lines: one long mono path wrapping mid-word is hard to read back.
  summaryFolderEl.replaceChildren();
  for (const line of [
    `Saved to ~/Downloads/${summary.folder}/`,
    `Newest copy always at ~/Downloads/${summary.pointerFolder}/`,
  ]) {
    const span = document.createElement('span');
    span.textContent = line;
    summaryFolderEl.appendChild(span);
  }

  const instruction = handoffInstruction(summary);
  handoffTextEl.textContent = instruction;
  copyInstructionBtn.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(instruction)
      .then(() => {
        summaryStatusEl.className = 'status';
        summaryStatusEl.textContent = 'Copied';
        copyInstructionBtn.textContent = 'Copied';
        // A brief tint on the panel, so the copy registers without a toast.
        handoffEl.classList.add('flash');
        setTimeout(() => {
          handoffEl.classList.remove('flash');
          copyInstructionBtn.textContent = 'Copy instruction';
        }, 1800);
      })
      .catch(() => {
        summaryStatusEl.className = 'status error';
        summaryStatusEl.textContent = 'Could not reach the clipboard — select the text above.';
      });
  });

  if (summary.indexDownloadId !== null) {
    showFolderBtn.addEventListener('click', () => {
      chrome.downloads.show(summary.indexDownloadId as number);
    });
  } else {
    showFolderBtn.hidden = true;
  }

  if (summary.failures.length) {
    const box = document.createElement('div');
    box.className = 'failures';
    const head = document.createElement('strong');
    head.textContent =
      summary.failures.length === 1
        ? 'One tab could not be captured'
        : `${summary.failures.length} tabs could not be captured`;
    const list = document.createElement('ul');
    for (const failure of summary.failures) {
      const li = document.createElement('li');
      li.textContent = `${failure.title} — ${failure.reason}`;
      list.appendChild(li);
    }
    box.append(head, list);
    summaryFailuresEl.appendChild(box);
  }
}

startBtn.addEventListener('click', () => {
  void (async () => {
    const tabIds = [...checkboxes.entries()].filter(([, c]) => c.checked).map(([id]) => id);
    if (!tabIds.length) return;
    startBtn.disabled = true;
    setupStatusEl.textContent = 'Starting…';
    // This page is one of the tabs Chrome will switch away from; progress is
    // read back from storage, so it survives losing focus.
    const response = (await chrome.runtime.sendMessage({
      type: 'SESSION_START',
      tabIds,
      reload: reloadInput.checked,
    })) as { ok: true; summary: SessionSummary } | { ok: false; reason: string };
    if (response.ok) {
      showSummary(response.summary);
    } else {
      setupEl.hidden = false;
      progressEl.hidden = true;
      startBtn.disabled = false;
      setupStatusEl.className = 'status error';
      setupStatusEl.textContent = response.reason;
    }
  })();
});

cancelBtn.addEventListener('click', () => {
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Stopping…';
  void chrome.runtime.sendMessage({ type: 'SESSION_CANCEL' });
});

chrome.storage.session.onChanged.addListener((changes) => {
  const progress = changes[SESSION_PROGRESS_KEY]?.newValue as SessionProgress | undefined;
  if (progress && progress.state === 'running') showProgress(progress);
  const summary = changes[SESSION_SUMMARY_KEY]?.newValue as SessionSummary | undefined;
  if (summary) showSummary(summary);
});

void (async () => {
  const tabs = (await chrome.runtime.sendMessage({ type: 'SESSION_LIST_TABS' })) as SessionTab[];
  // Never list ourselves: capturing the picker mid-run is meaningless.
  const own = await chrome.tabs.getCurrent();
  const stored = await chrome.storage.session.get(SESSION_SEED_TAB_KEY);
  renderTabs(
    tabs.filter((t) => t.id !== own?.id),
    stored[SESSION_SEED_TAB_KEY] as number | undefined,
  );
})();

selectAllBtn.addEventListener('click', () => {
  for (const checkbox of checkboxes.values()) checkbox.checked = true;
  updateSelectionCount();
});

selectNoneBtn.addEventListener('click', () => {
  for (const checkbox of checkboxes.values()) checkbox.checked = false;
  updateSelectionCount();
});
