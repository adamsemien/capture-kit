/*
 * First-run page (NOBC-162). Opened once, on install, so a new user learns
 * the two shortcuts and the two settings that matter before their first
 * capture rather than after.
 *
 * The keys shown are the ones Chrome actually bound: a suggested shortcut
 * another extension already holds is silently left unassigned, and a page
 * that promised ⌘⇧9 when nothing is bound would be the first thing to break.
 */

const COMMANDS: Record<string, string> = {
  'capture-bundle': 'capture',
  'record-clip': 'clip',
};

/** "⇧⌘9" as Chrome reports it on a Mac reads more naturally as "⌘⇧9". */
function displayShortcut(shortcut: string): string {
  return shortcut.replace(/^⇧⌘/, '⌘⇧');
}

async function showShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  let missing = false;
  for (const command of commands) {
    const key = command.name ? COMMANDS[command.name] : undefined;
    if (!key) continue;
    const label = command.shortcut ? displayShortcut(command.shortcut) : 'Not set';
    if (!command.shortcut) missing = true;
    const big = document.getElementById(`key-${key}`);
    if (big) big.textContent = label;
    for (const inline of document.querySelectorAll<HTMLElement>(`kbd[data-key="${key}"]`)) {
      inline.textContent = label;
    }
  }
  if (missing) {
    const hint = document.getElementById('key-hint');
    if (hint) {
      hint.firstChild!.textContent = 'Another extension already has one of these keys, so Chrome left it unset. ';
    }
  }
}

document.getElementById('open-settings')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

// chrome:// pages cannot be linked to from an extension page; tabs.create can open them.
document.getElementById('open-shortcuts')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

void showShortcuts();
