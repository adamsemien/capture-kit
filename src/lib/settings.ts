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
  /**
   * "Image only" writes PNG instead of the JPEG default. Sticky, because a
   * PNG user is being deliberate — set from the popup checkbox, not options.
   */
  imageOnlyPng: boolean;
  /**
   * Let page JavaScript fire a capture via the capture-kit:capture event.
   *
   * Default OFF, and it has to be: this boolean has no origin restriction, so
   * turning it on lets every site you visit fire a capture, pull its own tab
   * to the front, focus the window, and write a file into your output folder.
   * That is a fair trade to opt into deliberately and a bad one to inherit.
   * A page-driven capture is still worth having, so the setting stays; PR-3
   * replaces this boolean with a three-mode site-access control (Off /
   * Allowed sites / Any page), matching Chrome's own vocabulary for exactly
   * this decision.
   */
  allowInPageTrigger: boolean;
  /**
   * Clicking the toolbar icon fires a capture instead of opening the popup.
   *
   * Default OFF: turning it on removes the popup from the icon, and a user who
   * inherited that without asking for it would click expecting a menu and get
   * a debugger attach and a file on disk. The popup stays reachable through
   * the icon's right-click menu whenever this is on.
   */
  iconCapturesImmediately: boolean;
  /**
   * Composite a URL + timestamp footer onto the finished image.
   *
   * Default OFF because it changes the pixels of every capture, and a
   * screenshot that quietly grew a black bar is a surprise. Off means the
   * stamping code is never entered at all, not that it draws nothing.
   */
  stampUrlOnImage: boolean;
  /**
   * Put the image on the clipboard the moment the result tab opens - with the
   * report for a bundle, alone for an image-only capture - so the next paste
   * needs no click.
   *
   * Default OFF: it changes what lands on the clipboard after every capture,
   * replacing the report text that lands there today. Rides on the result tab
   * (openResult), because a write needs a focused document and that tab is
   * the one that has focus when the capture finishes.
   */
  autoCopyImage: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  segmentSize: 8192,
  includeConsoleLogs: true,
  bundleFormat: 'jpeg',
  maintainLatest: true,
  openResult: true,
  imageOnlyPng: false,
  allowInPageTrigger: false,
  iconCapturesImmediately: false,
  stampUrlOnImage: false,
  autoCopyImage: false,
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
    imageOnlyPng: stored.imageOnlyPng === true,
    // `=== true`, not `!== false`: an unset key must read as off, including
    // for anyone whose profile predates this setting existing.
    allowInPageTrigger: stored.allowInPageTrigger === true,
    iconCapturesImmediately: stored.iconCapturesImmediately === true,
    stampUrlOnImage: stored.stampUrlOnImage === true,
    autoCopyImage: stored.autoCopyImage === true,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({
    segmentSize: clampSegmentSize(settings.segmentSize),
    includeConsoleLogs: settings.includeConsoleLogs,
    bundleFormat: normalizeBundleFormat(settings.bundleFormat),
    maintainLatest: settings.maintainLatest !== false,
    openResult: settings.openResult !== false,
    imageOnlyPng: settings.imageOnlyPng === true,
    allowInPageTrigger: settings.allowInPageTrigger === true,
    iconCapturesImmediately: settings.iconCapturesImmediately === true,
    stampUrlOnImage: settings.stampUrlOnImage === true,
    autoCopyImage: settings.autoCopyImage === true,
  });
}

/** Storage keys the worker watches to re-arm the toolbar icon on change. */
export const ICON_MODE_KEY = 'iconCapturesImmediately';

/** Popup-owned toggle; written without disturbing the options-page settings. */
export async function setImageOnlyPng(value: boolean): Promise<void> {
  await chrome.storage.sync.set({ imageOnlyPng: value });
}
