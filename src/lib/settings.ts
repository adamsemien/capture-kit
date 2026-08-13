import type { CaptureFormat } from './capture-engine/types';

export interface Settings {
  /** Max capture dimension per segment, px. Pages larger than this per axis are captured in segments. */
  segmentSize: number;
  /** Whether log-level console entries appear in bundles (errors + warnings always do). */
  includeConsoleLogs: boolean;
  /** Image format for Capture Bundle. The Capture Page button always saves PNG. */
  bundleFormat: CaptureFormat;
  /** Keep overwriting latest.md / latest.jpg|png after each bundle (the AI-agent bridge). */
  maintainLatest: boolean;
  /** Open the result preview tab after each capture. */
  openResult: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  segmentSize: 8192,
  includeConsoleLogs: true,
  bundleFormat: 'jpeg',
  maintainLatest: true,
  openResult: true,
};

export function normalizeBundleFormat(value: unknown): CaptureFormat {
  return value === 'png' ? 'png' : 'jpeg';
}

export const SEGMENT_SIZE_MIN = 1024;
export const SEGMENT_SIZE_MAX = 16384;

export function clampSegmentSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.segmentSize;
  return Math.min(SEGMENT_SIZE_MAX, Math.max(SEGMENT_SIZE_MIN, Math.floor(value)));
}

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  return {
    segmentSize: clampSegmentSize(stored.segmentSize),
    includeConsoleLogs: Boolean(stored.includeConsoleLogs),
    bundleFormat: normalizeBundleFormat(stored.bundleFormat),
    maintainLatest: stored.maintainLatest !== false,
    openResult: stored.openResult !== false,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({
    segmentSize: clampSegmentSize(settings.segmentSize),
    includeConsoleLogs: settings.includeConsoleLogs,
    bundleFormat: normalizeBundleFormat(settings.bundleFormat),
    maintainLatest: settings.maintainLatest !== false,
    openResult: settings.openResult !== false,
  });
}
