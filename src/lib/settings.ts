import type { CaptureFormat } from './capture-engine/types';
import { CLIP_DELAY_DEFAULT, CLIP_SECONDS_DEFAULT, clampClipDelay, clampClipSeconds } from './clip/frames';
import {
  DEFAULT_TRIGGER_SITES,
  normalizeSiteList,
  normalizeTriggerMode,
  type PageTriggerMode,
} from './site-access';

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
   * Which pages may fire a capture via the capture-kit:capture event: none,
   * the hosts in pageTriggerSites, or any page. Default off - a page-driven
   * capture pulls its tab to the front and writes a file, which is a fair
   * trade to opt into and a bad one to inherit. See lib/site-access.ts.
   */
  pageTriggerMode: PageTriggerMode;
  /** Hosts for "Allowed sites" mode, one pattern per entry ("localhost:3000", "*.example.com"). */
  pageTriggerSites: string[];
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
  /**
   * With "Copy to clipboard after capture" on, leave the report text off the
   * clipboard and put only the image there.
   *
   * Which half an app pastes first is the app's decision, not ours: ChatGPT
   * takes the text, Claude takes the image. For someone who always wants the
   * picture, the fix is to not offer the text at all. The .md file and
   * latest.md are still written - this changes the clipboard only. Default
   * OFF, so anyone who relied on the report riding along keeps it.
   */
  clipboardImageOnly: boolean;
  /** How long "Record clip" records, in seconds. Capped in clip/frames.ts. */
  clipSeconds: number;
  /** Seconds between the trigger and the recording starting. */
  clipDelaySeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  segmentSize: 8192,
  includeConsoleLogs: true,
  bundleFormat: 'jpeg',
  maintainLatest: true,
  openResult: true,
  imageOnlyPng: false,
  pageTriggerMode: 'off',
  pageTriggerSites: [...DEFAULT_TRIGGER_SITES],
  iconCapturesImmediately: false,
  stampUrlOnImage: false,
  autoCopyImage: false,
  clipboardImageOnly: false,
  clipSeconds: CLIP_SECONDS_DEFAULT,
  clipDelaySeconds: CLIP_DELAY_DEFAULT,
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

/**
 * The trigger mode a stored profile asks for. Profiles from before 0.4.0 hold
 * only the old allowInPageTrigger boolean: on meant every site, so it maps to
 * "any" and nobody's working agent setup breaks on upgrade. Once the new key
 * exists it wins.
 */
export function storedTriggerMode(stored: { pageTriggerMode?: unknown; allowInPageTrigger?: unknown }): PageTriggerMode {
  if (stored.pageTriggerMode != null) return normalizeTriggerMode(stored.pageTriggerMode);
  return stored.allowInPageTrigger === true ? 'any' : 'off';
}

export async function getSettings(): Promise<Settings> {
  // null, not undefined, for "not stored": chrome.storage serializes the
  // defaults object, and a key whose default is undefined is dropped from the
  // request entirely - it would then never be read back at all.
  const stored = (await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    pageTriggerMode: null,
    allowInPageTrigger: null,
  } as Record<string, unknown>)) as unknown as Settings & { allowInPageTrigger?: unknown };
  return {
    segmentSize: clampSegmentSize(stored.segmentSize),
    includeConsoleLogs: Boolean(stored.includeConsoleLogs),
    bundleFormat: normalizeBundleFormat(stored.bundleFormat),
    maintainLatest: stored.maintainLatest !== false,
    openResult: stored.openResult !== false,
    imageOnlyPng: stored.imageOnlyPng === true,
    pageTriggerMode: storedTriggerMode(stored),
    pageTriggerSites: Array.isArray(stored.pageTriggerSites)
      ? normalizeSiteList(stored.pageTriggerSites)
      : [...DEFAULT_TRIGGER_SITES],
    iconCapturesImmediately: stored.iconCapturesImmediately === true,
    stampUrlOnImage: stored.stampUrlOnImage === true,
    autoCopyImage: stored.autoCopyImage === true,
    clipboardImageOnly: stored.clipboardImageOnly === true,
    clipSeconds: clampClipSeconds(Number(stored.clipSeconds)),
    clipDelaySeconds: clampClipDelay(Number(stored.clipDelaySeconds)),
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
    pageTriggerMode: normalizeTriggerMode(settings.pageTriggerMode),
    pageTriggerSites: normalizeSiteList(settings.pageTriggerSites),
    iconCapturesImmediately: settings.iconCapturesImmediately === true,
    stampUrlOnImage: settings.stampUrlOnImage === true,
    autoCopyImage: settings.autoCopyImage === true,
    clipboardImageOnly: settings.clipboardImageOnly === true,
    clipSeconds: clampClipSeconds(settings.clipSeconds),
    clipDelaySeconds: clampClipDelay(settings.clipDelaySeconds),
  });
  // The old boolean is superseded; leaving it would let a stale "true" look
  // meaningful to anyone reading storage.
  await chrome.storage.sync.remove('allowInPageTrigger');
}

/** Storage keys the worker watches to re-arm the toolbar icon on change. */
export const ICON_MODE_KEY = 'iconCapturesImmediately';

/** Popup-owned toggle; written without disturbing the options-page settings. */
export async function setImageOnlyPng(value: boolean): Promise<void> {
  await chrome.storage.sync.set({ imageOnlyPng: value });
}
