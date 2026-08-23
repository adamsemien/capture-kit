import { clampSegmentSize, getSettings, normalizeBundleFormat, saveSettings } from '../lib/settings';
import {
  clearOutputDir,
  outputDirStatus,
  requestOutputDirPermission,
  saveOutputDir,
} from '../lib/output-dir';

const segmentInput = document.getElementById('segment-size') as HTMLInputElement;
const includeLogsInput = document.getElementById('include-logs') as HTMLInputElement;
const maintainLatestInput = document.getElementById('maintain-latest') as HTMLInputElement;
const openResultInput = document.getElementById('open-result') as HTMLInputElement;
const formatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="bundle-format"]'),
);
const triggerInput = document.getElementById('allow-in-page-trigger') as HTMLInputElement;
const iconCapturesInput = document.getElementById('icon-captures') as HTMLInputElement;
const stampUrlInput = document.getElementById('stamp-url') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const dirNameEl = document.getElementById('output-dir-name') as HTMLElement;
const dirChooseBtn = document.getElementById('output-dir-choose') as HTMLButtonElement;
const dirClearBtn = document.getElementById('output-dir-clear') as HTMLButtonElement;
const dirNoteEl = document.getElementById('output-dir-note') as HTMLElement;

let statusTimer: number | undefined;

async function load(): Promise<void> {
  const settings = await getSettings();
  segmentInput.value = String(settings.segmentSize);
  includeLogsInput.checked = settings.includeConsoleLogs;
  maintainLatestInput.checked = settings.maintainLatest;
  openResultInput.checked = settings.openResult;
  triggerInput.checked = settings.allowInPageTrigger;
  iconCapturesInput.checked = settings.iconCapturesImmediately;
  stampUrlInput.checked = settings.stampUrlOnImage;
  for (const input of formatInputs) {
    input.checked = input.value === settings.bundleFormat;
  }
}

/**
 * The folder row. The File System Access API never hands over a real path —
 * only the folder's own name — so that is what gets shown; promising a path
 * we cannot read would be worse than naming the folder.
 */
/**
 * Last rendered state, kept so the click handler can branch without awaiting
 * anything first: showDirectoryPicker needs the click's transient activation,
 * and bookkeeping is not worth spending it on.
 */
let lastState: 'none' | 'granted' | 'lapsed' = 'none';

async function renderOutputDir(): Promise<void> {
  const status = await outputDirStatus();
  lastState = status.state;
  dirClearBtn.hidden = status.state === 'none';
  dirNoteEl.hidden = true;
  dirNoteEl.textContent = '';

  if (status.state === 'none') {
    dirNameEl.textContent = 'Chrome Downloads — default';
    dirChooseBtn.textContent = 'Choose…';
    return;
  }

  dirNameEl.textContent = status.name ?? 'chosen folder';
  dirChooseBtn.textContent = 'Change…';
  if (status.state === 'lapsed') {
    // Chrome keeps the folder but drops the permission, and only a click can
    // give it back — a service worker has no user gesture to ask with.
    // Captures keep working in Downloads meanwhile.
    dirNoteEl.hidden = false;
    dirNoteEl.textContent =
      'Chrome dropped write permission for this folder. Captures are going to Downloads until you ' +
      'reconnect it — choose "allow on every visit" and it will survive restarts.';
    dirChooseBtn.textContent = 'Reconnect';
  }
}

/**
 * One button, two jobs: re-arm a lapsed permission without making the user
 * hunt for the same folder again, or pick a new one.
 */
async function chooseOutputDir(): Promise<void> {
  try {
    if (lastState === 'lapsed') {
      const regained = await requestOutputDirPermission();
      if (regained.state === 'granted') {
        await renderOutputDir();
        flashStatus('Reconnected');
        return;
      }
    }
    const handle = await showDirectoryPicker({ id: 'capture-kit-output', mode: 'readwrite' });
    // Picking implies the grant, but ask explicitly so a folder that was
    // chosen read-only cannot be stored as if it were writable.
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await handle.requestPermission({ mode: 'readwrite' });
    }
    await saveOutputDir(handle);
    await renderOutputDir();
    flashStatus('Saved');
  } catch (error) {
    // AbortError is the user closing the picker — not a failure worth a word.
    if ((error as DOMException)?.name !== 'AbortError') {
      dirNoteEl.hidden = false;
      dirNoteEl.textContent = `Chrome would not open that folder: ${String(error)}`;
    }
  }
}

async function save(): Promise<void> {
  const segmentSize = clampSegmentSize(Number(segmentInput.value));
  const bundleFormat = normalizeBundleFormat(formatInputs.find((input) => input.checked)?.value);
  // imageOnlyPng belongs to the popup checkbox; carry it through untouched
  // so saving from this page can't silently reset it.
  const { imageOnlyPng } = await getSettings();
  await saveSettings({
    segmentSize,
    includeConsoleLogs: includeLogsInput.checked,
    bundleFormat,
    maintainLatest: maintainLatestInput.checked,
    openResult: openResultInput.checked,
    imageOnlyPng,
    allowInPageTrigger: triggerInput.checked,
    iconCapturesImmediately: iconCapturesInput.checked,
    stampUrlOnImage: stampUrlInput.checked,
  });
  segmentInput.value = String(segmentSize);
  flashStatus('Saved');
}

function flashStatus(text: string): void {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 1500);
}

segmentInput.addEventListener('change', () => void save());
includeLogsInput.addEventListener('change', () => void save());
maintainLatestInput.addEventListener('change', () => void save());
openResultInput.addEventListener('change', () => void save());
triggerInput.addEventListener('change', () => void save());
iconCapturesInput.addEventListener('change', () => void save());
stampUrlInput.addEventListener('change', () => void save());
for (const input of formatInputs) {
  input.addEventListener('change', () => void save());
}

dirChooseBtn.addEventListener('click', () => void chooseOutputDir());
dirClearBtn.addEventListener('click', () => {
  void (async () => {
    await clearOutputDir();
    await renderOutputDir();
    flashStatus('Back to Downloads');
  })();
});

void load();
void renderOutputDir();
