import { clampSegmentSize, getSettings, normalizeBundleFormat, saveSettings } from '../lib/settings';

const segmentInput = document.getElementById('segment-size') as HTMLInputElement;
const includeLogsInput = document.getElementById('include-logs') as HTMLInputElement;
const formatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="bundle-format"]'),
);
const statusEl = document.getElementById('status') as HTMLParagraphElement;

let statusTimer: number | undefined;

async function load(): Promise<void> {
  const settings = await getSettings();
  segmentInput.value = String(settings.segmentSize);
  includeLogsInput.checked = settings.includeConsoleLogs;
  for (const input of formatInputs) {
    input.checked = input.value === settings.bundleFormat;
  }
}

async function save(): Promise<void> {
  const segmentSize = clampSegmentSize(Number(segmentInput.value));
  const bundleFormat = normalizeBundleFormat(formatInputs.find((input) => input.checked)?.value);
  await saveSettings({ segmentSize, includeConsoleLogs: includeLogsInput.checked, bundleFormat });
  segmentInput.value = String(segmentSize);
  statusEl.textContent = 'Saved.';
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 1500);
}

segmentInput.addEventListener('change', () => void save());
includeLogsInput.addEventListener('change', () => void save());
for (const input of formatInputs) {
  input.addEventListener('change', () => void save());
}

void load();
