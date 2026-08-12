import { clampSegmentSize, getSettings, saveSettings } from '../lib/settings';

const segmentInput = document.getElementById('segment-size') as HTMLInputElement;
const includeLogsInput = document.getElementById('include-logs') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;

let statusTimer: number | undefined;

async function load(): Promise<void> {
  const settings = await getSettings();
  segmentInput.value = String(settings.segmentSize);
  includeLogsInput.checked = settings.includeConsoleLogs;
}

async function save(): Promise<void> {
  const segmentSize = clampSegmentSize(Number(segmentInput.value));
  await saveSettings({ segmentSize, includeConsoleLogs: includeLogsInput.checked });
  segmentInput.value = String(segmentSize);
  statusEl.textContent = 'Saved.';
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 1500);
}

segmentInput.addEventListener('change', () => void save());
includeLogsInput.addEventListener('change', () => void save());

void load();
