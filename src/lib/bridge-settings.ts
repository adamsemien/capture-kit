/*
 * Agent bridge settings (NOBC-82). Kept in chrome.storage.local, not sync:
 * the pairing code belongs to the helper on this computer, and syncing it to
 * another machine would hand that machine's Chrome a code for a helper it
 * cannot reach.
 *
 * Two separate permissions, both off by default:
 *   - bridgeEnabled: Capture Kit connects to the helper and hands it every
 *     report you capture, so an agent on this computer can read it.
 *   - bridgeCaptureMode: whether an agent may also take a capture itself,
 *     and on which sites (the Allowed sites list is shared with page
 *     triggers). A capture brings its tab to the front, so this stays off
 *     until you choose.
 */

import { normalizeTriggerMode, type PageTriggerMode } from './site-access';

export const DEFAULT_BRIDGE_PORT = 47823;

export interface BridgeSettings {
  bridgeEnabled: boolean;
  bridgeToken: string;
  bridgePort: number;
  bridgeCaptureMode: PageTriggerMode;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  bridgeEnabled: false,
  bridgeToken: '',
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeCaptureMode: 'off',
};

export const BRIDGE_KEYS = Object.keys(DEFAULT_BRIDGE_SETTINGS) as (keyof BridgeSettings)[];

export function clampPort(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_BRIDGE_PORT;
}

/** A pasted pairing code, trimmed of the whitespace and quotes a copy can carry. */
export function cleanToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : '';
}

export async function getBridgeSettings(): Promise<BridgeSettings> {
  const stored = (await chrome.storage.local.get({ ...DEFAULT_BRIDGE_SETTINGS })) as BridgeSettings;
  return {
    bridgeEnabled: stored.bridgeEnabled === true,
    bridgeToken: cleanToken(stored.bridgeToken),
    bridgePort: clampPort(stored.bridgePort),
    bridgeCaptureMode: normalizeTriggerMode(stored.bridgeCaptureMode),
  };
}

export async function saveBridgeSettings(patch: Partial<BridgeSettings>): Promise<void> {
  const clean: Partial<BridgeSettings> = {};
  if (patch.bridgeEnabled !== undefined) clean.bridgeEnabled = patch.bridgeEnabled === true;
  if (patch.bridgeToken !== undefined) clean.bridgeToken = cleanToken(patch.bridgeToken);
  if (patch.bridgePort !== undefined) clean.bridgePort = clampPort(patch.bridgePort);
  if (patch.bridgeCaptureMode !== undefined) clean.bridgeCaptureMode = normalizeTriggerMode(patch.bridgeCaptureMode);
  await chrome.storage.local.set(clean);
}

/** What the options page shows; written by the worker to storage.session. */
export interface BridgeStatus {
  state: 'off' | 'unpaired' | 'connecting' | 'connected' | 'refused' | 'unreachable' | 'mismatch';
  at: number;
  detail?: string;
}

export const BRIDGE_STATUS_KEY = 'bridgeStatus';
