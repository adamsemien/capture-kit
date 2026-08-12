import type { ConsoleEntry, NetworkFailure, PageMeta } from '../messages';
import { CONSOLE_LOGS_IN_BUNDLE } from '../messages';
import type { PageDimensions } from '../capture-engine/types';

export interface BundleInput {
  meta: PageMeta;
  contentSize: PageDimensions;
  fullSize: PageDimensions;
  truncated: boolean;
  consoleEntries: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  /** False when the recorder wasn't running since page load (pre-install page). */
  recorderActive: boolean;
  includeLogs: boolean;
  capturedAt: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function timeOfDay(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Tilde fences: console output routinely contains backticks, almost never
// tildes. Any embedded fence-closer is defused.
function fence(text: string): string {
  return '~~~\n' + text.replace(/~~~/g, '~ ~ ~') + '\n~~~';
}

function consoleBlock(entry: ConsoleEntry): string {
  const lines = [`[${timeOfDay(entry.timestamp)}] ${entry.message}`];
  if (entry.source) lines.push(`at ${entry.source}`);
  return fence(lines.join('\n'));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function buildBundleMarkdown(input: BundleInput): string {
  const { meta } = input;
  const errors = input.consoleEntries.filter((e) => e.level === 'error');
  const warnings = input.consoleEntries.filter((e) => e.level === 'warn');
  const logs = input.consoleEntries.filter((e) => e.level === 'log').slice(-CONSOLE_LOGS_IN_BUNDLE);

  const parts: string[] = [];

  parts.push(`# Capture — ${meta.title || meta.url}`);
  parts.push(
    [
      `- **URL:** ${meta.url}`,
      `- **Title:** ${meta.title || '(untitled)'}`,
      `- **Captured at:** ${input.capturedAt.toISOString()}`,
      `- **Viewport:** ${meta.viewport.width}×${meta.viewport.height}`,
      `- **Full page:** ${input.contentSize.width}×${input.contentSize.height}`,
      `- **User agent:** ${meta.userAgent}`,
    ].join('\n'),
  );

  if (input.truncated) {
    parts.push(
      `> ⚠️ The page exceeds Chrome's canvas limits — the screenshot was truncated to ${input.fullSize.width}×${input.fullSize.height} of the full ${input.contentSize.width}×${input.contentSize.height}.`,
    );
  }

  parts.push('## Console');
  if (!input.recorderActive) {
    parts.push(
      '> The recorder was not active on this page since load (it starts at page load — reload the page after installing or updating the extension). Console and network data below may be missing.',
    );
  }

  parts.push(`### Errors (${errors.length})`);
  parts.push(
    errors.length ? errors.map(consoleBlock).join('\n') : 'No console errors captured since page load.',
  );

  parts.push(`### Warnings (${warnings.length})`);
  parts.push(
    warnings.length
      ? warnings.map(consoleBlock).join('\n')
      : 'No console warnings captured since page load.',
  );

  if (input.includeLogs) {
    parts.push(`### Logs (last ${CONSOLE_LOGS_IN_BUNDLE})`);
    parts.push(
      logs.length ? logs.map(consoleBlock).join('\n') : 'No console logs captured since page load.',
    );
  } else {
    parts.push('### Logs');
    parts.push('Log-level entries are excluded by the extension settings.');
  }

  parts.push('## Network Failures');
  if (input.networkFailures.length) {
    const rows = input.networkFailures.map(
      (f) =>
        `| ${escapeCell(f.method)} | ${f.status === 0 ? 'failed' : f.status} | ${escapeCell(f.url)} | ${Math.round(f.durationMs)} ms |`,
    );
    parts.push(
      ['| Method | Status | URL | Duration |', '| --- | --- | --- | --- |', ...rows].join('\n'),
    );
  } else {
    parts.push('No failed network requests captured since page load.');
  }

  parts.push('## Notes');
  parts.push('');

  return parts.join('\n\n') + '\n';
}

/** Clipboard variant: same markdown with a one-line pointer to the image on top. */
export function buildClipboardMarkdown(markdown: string, imageFilename: string): string {
  return `> Screenshot saved as \`${imageFilename}\` — attach it alongside this report.\n\n${markdown}`;
}
