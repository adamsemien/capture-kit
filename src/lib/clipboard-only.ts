import type { CaptureTrigger } from './messages';
import type { Settings } from './settings';

/**
 * "Copy to clipboard after capture" with "Show me what I captured" off: the
 * capture goes straight to the clipboard and no tab opens.
 *
 * Only from the keyboard shortcut and the one-click toolbar icon. A clipboard
 * write needs a focused document, and on those two paths the page that was
 * just captured still has focus, so its content script can write. From the
 * popup the popup holds focus instead, so the result tab opens and copies as
 * before. The in-page agent trigger never takes over the clipboard: an
 * unattended agent run would overwrite whatever the person had copied.
 */
export function copiesFromPage(
  settings: Pick<Settings, 'autoCopyImage' | 'openResult'>,
  trigger: CaptureTrigger,
): boolean {
  return (
    settings.autoCopyImage &&
    !settings.openResult &&
    (trigger === 'shortcut' || trigger === 'icon')
  );
}

/**
 * Whether the result tab opens. It always does when the person asked for it;
 * with auto-copy on it also opens whenever the page could not take the copy,
 * so a capture is never left with neither a tab nor a clipboard.
 */
export function opensResultTab(
  settings: Pick<Settings, 'autoCopyImage' | 'openResult'>,
  copiedFromPage: boolean,
): boolean {
  return settings.openResult || (settings.autoCopyImage && !copiedFromPage);
}
