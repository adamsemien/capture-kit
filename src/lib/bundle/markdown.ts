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
export interface ContentsInput {
  truncated: boolean;
  fullSize: PageDimensions;
  contentSize: PageDimensions;
  recorderActive: boolean;
  errors: number;
  warnings: number;
  logs: number;
  networkFailures: number;
}

/**
 * THE grammar. Session manifests, page reports and sweep reports all call
 * this — there is exactly one implementation, so a parser written against a
 * report row also parses a manifest row.
 */
export function buildContentsLine(input: ContentsInput): string {
  const image = input.truncated
    ? `partial image (${input.fullSize.width}×${input.fullSize.height} of ${input.contentSize.width}×${input.contentSize.height})`
    : 'full-page image';
  const items = [image];

  if (!input.recorderActive) {
    items.push('recorder not active (no console or network data)');
    return `Contents: ${items.join(' + ')}`;
  }

  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (input.errors) items.push(plural(input.errors, 'console error'));
  if (input.warnings) items.push(plural(input.warnings, 'console warning'));
  if (input.logs) items.push(plural(input.logs, 'console log'));
  if (input.networkFailures) items.push(plural(input.networkFailures, 'network failure'));
  if (items.length === 1) items.push('no console or network issues');
  return `Contents: ${items.join(' + ')}`;
}

function contentsLine(
  input: BundleInput,
  counts: { errors: number; warnings: number; logs: number },
): string {
  return buildContentsLine({
    truncated: input.truncated,
    fullSize: input.fullSize,
    contentSize: input.contentSize,
    recorderActive: input.recorderActive,
    errors: counts.errors,
    warnings: counts.warnings,
    logs: counts.logs,
    networkFailures: input.networkFailures.length,
  });
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

  parts.push(...consoleAndNetworkSections({
    recorderActive: input.recorderActive,
    errors,
    warnings,
    logs,
    includeLogs: input.includeLogs,
    networkFailures: input.networkFailures,
  }));

  parts.push('## Notes');
  parts.push('');

  return parts.join('\n\n') + '\n';
}

interface SectionsInput {
  recorderActive: boolean;
  errors: ConsoleEntry[];
  warnings: ConsoleEntry[];
  logs: ConsoleEntry[];
  includeLogs: boolean;
  networkFailures: NetworkFailure[];
}

/**
 * Console + network sections, shared by page reports and sweep reports.
 * When the recorder never ran we were not listening, so the sections say the
 * data is unavailable rather than printing counts a reader would take for
 * "clean".
 */
function consoleAndNetworkSections(input: SectionsInput): string[] {
  if (!input.recorderActive) {
    return ['## Console', RECORDER_INACTIVE_NOTE, '## Network Failures', RECORDER_INACTIVE_NOTE];
  }

  const parts: string[] = ['## Console'];
  parts.push(`### Errors (${input.errors.length})`);
  parts.push(
    input.errors.length
      ? input.errors.map(consoleBlock).join('\n')
      : 'No console errors captured since page load.',
  );

  parts.push(`### Warnings (${input.warnings.length})`);
  parts.push(
    input.warnings.length
      ? input.warnings.map(consoleBlock).join('\n')
      : 'No console warnings captured since page load.',
  );

  if (input.includeLogs) {
    parts.push(`### Logs (last ${CONSOLE_LOGS_IN_BUNDLE})`);
    parts.push(
      input.logs.length
        ? input.logs.map(consoleBlock).join('\n')
        : 'No console logs captured since page load.',
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
  return parts;
}

export interface SweepWidthInput {
  width: number;
  filename: string;
  fullSize: PageDimensions;
  contentSize: PageDimensions;
  truncated: boolean;
  captureMode: CaptureMode;
  revealForced: number;
  segments: number;
}

export interface SweepMarkdownInput {
  meta: PageMeta;
  capturedAt: Date;
  widths: SweepWidthInput[];
  failures: { width: number; reason: string }[];
  consoleEntries: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  recorderActive: boolean;
  includeLogs: boolean;
}

/**
 * A sweep is one page at three widths, so console/network state is stated
 * once at document level; each width carries its own Contents line for the
 * image it produced.
 */
export function buildSweepMarkdown(input: SweepMarkdownInput): string {
  const { meta } = input;
  const errors = input.consoleEntries.filter((e) => e.level === 'error');
  const warnings = input.consoleEntries.filter((e) => e.level === 'warn');
  const logs = input.consoleEntries.filter((e) => e.level === 'log').slice(-CONSOLE_LOGS_IN_BUNDLE);

  const parts: string[] = [];
  parts.push(`# Responsive sweep — ${meta.title || meta.url}`);
  parts.push(
    [
      `- **URL:** ${meta.url}`,
      `- **Title:** ${meta.title || '(untitled)'}`,
      `- **Captured at:** ${input.capturedAt.toISOString()}`,
      `- **Widths:** ${input.widths.map((w) => `${w.width} px`).join(', ') || '(none)'}`,
      `- **User agent:** ${meta.userAgent}`,
    ].join('\n'),
  );

  for (const width of input.widths) {
    parts.push(`## ${width.width} px`);
    parts.push(
      [
        `Image: ${width.filename}`,
        buildContentsLine({
          truncated: width.truncated,
          fullSize: width.fullSize,
          contentSize: width.contentSize,
          // Console data belongs to the page, not to each width — the
          // document-level section below states it once.
          recorderActive: true,
          errors: 0,
          warnings: 0,
          logs: 0,
          networkFailures: 0,
        }),
        `- **Size:** ${width.fullSize.width}×${width.fullSize.height}`,
        `- **Capture mode:** ${captureModeLabel(width.captureMode, width.revealForced, width.segments)}`,
      ].join('\n'),
    );
  }

  for (const failure of input.failures) {
    parts.push(`## ${failure.width} px — failed`);
    parts.push(`> ${failure.reason}`);
  }

  parts.push(...consoleAndNetworkSections({
    recorderActive: input.recorderActive,
    errors,
    warnings,
    logs,
    includeLogs: input.includeLogs,
    networkFailures: input.networkFailures,
  }));

  return parts.join('\n\n') + '\n';
}

/** Clipboard variant: same markdown with a one-line pointer to the image on top. */
export function buildClipboardMarkdown(markdown: string, imageFilename: string): string {
  return `> Screenshot saved as \`${imageFilename}\` — attach it alongside this report.\n\n${markdown}`;
}
