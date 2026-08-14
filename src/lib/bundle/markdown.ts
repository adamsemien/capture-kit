import type { ConsoleEntry, NetworkFailure, PageMeta } from '../messages';
import { CONSOLE_LOGS_IN_BUNDLE } from '../messages';
import type { CaptureMode, PageDimensions } from '../capture-engine/types';

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
  /** Timestamped image filename this bundle's screenshot was saved under. */
  imageFilename: string;
  captureMode: CaptureMode;
  /** Count of scroll-reveal elements that had to be force-revealed for this capture. */
  revealForced: number;
  /** Segments stitched for the image (1 = true single-shot). */
  segments: number;
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

/**
 * Printed in place of console/network content when the MAIN-world recorder
 * never ran on this page — the same signal the popup shows its amber warning
 * for (BufferSnapshot.mainWorldActive). "Unavailable" and "none" are very
 * different findings; only one of them is true here.
 */
const RECORDER_INACTIVE_NOTE =
  '> **Recorder not active for this page — console and network data unavailable (NOT a clean page).** ' +
  'The recorder hooks console and network at page load, so it cannot cover a tab that was already open ' +
  'when the extension was installed or reloaded. Reload the tab, reproduce the issue, then capture again.';

/**
 * Human-readable capture-mode string shared by the bundle metadata and the
 * result page. States the strategy AND the path actually taken, because an
 * AI assistant reading the report cannot tell a true one-shot from a
 * scroll-and-stitch otherwise — and stitched captures have different failure
 * modes (vh re-measure, virtualized content).
 */
export function captureModeLabel(
  mode: CaptureMode,
  revealForced: number,
  segments: number,
): string {
  const strategy = mode === 'expanded-inner-scroll' ? 'expanded inner scroll' : 'standard';
  const path = segments > 1 ? `segmented, ${segments} segments` : 'single-shot';
  const reveal = revealForced > 0 ? ` + reveal-forced (${revealForced} elements)` : '';
  return `${strategy}, ${path}${reveal}`;
}

/**
 * One machine-parseable line stating what this file actually contains — the
 * seed of the Phase 3 multi-page manifest.
 *
 *   Contents: <item>[ + <item>]*
 *
 * Items are `full-page image`, `partial image (W×H of W×H)`, `<n> console
 * error|warning|log(s)`, `<n> network failure(s)`, `no console or network
 * issues`, or `recorder not active (no console or network data)`. Counts are
 * what this file CONTAINS — never what exists elsewhere — so excluded or
 * truncated log entries are never claimed.
 */
function contentsLine(
  input: BundleInput,
  counts: { errors: number; warnings: number; logs: number },
): string {
  const image = input.truncated
    ? `partial image (${input.fullSize.width}×${input.fullSize.height} of ${input.contentSize.width}×${input.contentSize.height})`
    : 'full-page image';
  const items = [image];

  if (!input.recorderActive) {
    items.push('recorder not active (no console or network data)');
    return `Contents: ${items.join(' + ')}`;
  }

  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (counts.errors) items.push(plural(counts.errors, 'console error'));
  if (counts.warnings) items.push(plural(counts.warnings, 'console warning'));
  if (counts.logs) items.push(plural(counts.logs, 'console log'));
  if (input.networkFailures.length) {
    items.push(plural(input.networkFailures.length, 'network failure'));
  }
  if (items.length === 1) items.push('no console or network issues');
  return `Contents: ${items.join(' + ')}`;
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
      `Image: ${input.imageFilename}`,
      contentsLine(input, {
        errors: errors.length,
        warnings: warnings.length,
        logs: input.includeLogs ? logs.length : 0,
      }),
      `- **URL:** ${meta.url}`,
      `- **Title:** ${meta.title || '(untitled)'}`,
      `- **Captured at:** ${input.capturedAt.toISOString()}`,
      `- **Viewport:** ${meta.viewport.width}×${meta.viewport.height}`,
      `- **Full page:** ${input.contentSize.width}×${input.contentSize.height}`,
      `- **Capture mode:** ${captureModeLabel(input.captureMode, input.revealForced, input.segments)}`,
      `- **Recorder:** ${
        input.recorderActive
          ? 'active since page load — console and network data below are complete'
          : 'NOT ACTIVE for this page — console and network data are unavailable, not empty'
      }`,
      `- **User agent:** ${meta.userAgent}`,
    ].join('\n'),
  );

  if (input.truncated) {
    parts.push(
      `> ⚠️ The page exceeds Chrome's canvas limits — the screenshot was truncated to ${input.fullSize.width}×${input.fullSize.height} of the full ${input.contentSize.width}×${input.contentSize.height}.`,
    );
  }

  // When the recorder never ran, we were not listening — saying "no errors
  // captured" would report a clean page to a reader who cannot tell the
  // difference. State the gap instead, and print no counts at all.
  if (!input.recorderActive) {
    parts.push('## Console');
    parts.push(RECORDER_INACTIVE_NOTE);
    parts.push('## Network Failures');
    parts.push(RECORDER_INACTIVE_NOTE);
    parts.push('## Notes');
    parts.push('');
    return parts.join('\n\n') + '\n';
  }

  parts.push('## Console');

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
