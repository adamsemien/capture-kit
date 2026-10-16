import type { CaptureTrigger, ConsoleEntry, NetworkFailure, PageMeta } from '../messages';
import { CAPTURE_TRIGGER_LABEL, CONSOLE_LOGS_IN_BUNDLE } from '../messages';
import type { CaptureMode, PageDimensions, StampInfo } from '../capture-engine/types';
import { classifyEnvironment } from '../env-marker';
import { stampLabel } from '../capture-engine/stamp';
import { redactedLabel } from '../redact';
import {
  collapseFailures,
  formatDemotedHost,
  formatFailureLine,
  mergeHosts,
  splitConsoleErrors,
  splitFailures,
} from '../net-classify';

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
  /** Elements whose viewport-unit lengths were held at the real viewport (segmented only). */
  heightHeld?: number;
  /** Inner scrollers unrolled (expanded-inner-scroll mode only). */
  innerScrollers?: number;
  /** Embedded frames kept at their on-screen height (expanded-inner-scroll mode only). */
  framesHeld?: number;
  /** Segments stitched for the image (1 = true single-shot). */
  segments: number;
  /** Dimensions of the file on disk, footer included. */
  imageSize: PageDimensions;
  /** What set this capture going. */
  trigger: CaptureTrigger;
  /** Present only when the URL footer was composited onto the image. */
  stamp?: StampInfo;
  /** Size at the real viewport, when the page re-laid out for a segmented capture. */
  naturalSize?: PageDimensions;
  /** The tab's page zoom when the capture started; captures normalize it to 1. */
  browserZoom?: number;
  /** Values scrubbed from the page record this report was built from. */
  redacted?: number;
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
  heightHeld = 0,
  innerScrollers = 0,
  framesHeld = 0,
): string {
  // The counts say how many columns were unrolled and how many embedded
  // pages were not - a reader comparing a three-column app to its capture
  // needs to know which parts are whole.
  const parts: string[] = [];
  if (innerScrollers > 1) parts.push(`${innerScrollers} scrollers`);
  if (framesHeld > 0) {
    parts.push(`${framesHeld} embedded ${framesHeld === 1 ? 'frame' : 'frames'} kept at screen height`);
  }
  const strategy =
    mode === 'expanded-inner-scroll'
      ? parts.length > 0
        ? `expanded inner scroll (${parts.join(', ')})`
        : 'expanded inner scroll'
      : 'standard';
  const path = segments > 1 ? `segmented, ${segments} segments` : 'single-shot';
  const reveal = revealForced > 0 ? ` + reveal-forced (${revealForced} elements)` : '';
  // Says the page was altered for the capture, and how: viewport-unit lengths
  // were held at the real viewport instead of resolving against the segmented
  // path's taller virtual one. Absent when nothing moved.
  const held = heightHeld > 0 ? ` + viewport heights held (${heightHeld} elements)` : '';
  return `${strategy}, ${path}${reveal}${held}`;
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
  /** First-party console errors, plus any whose source could not be resolved. */
  errors: number;
  warnings: number;
  logs: number;
  /** First-party network failures only. */
  networkFailures: number;
  thirdPartyErrors: number;
  thirdPartyFailures: number;
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
  // Distinct nouns: a blocked analytics beacon is not the page's own failure,
  // and counting it as one made working pages read as broken. Counts stay raw
  // — collapsing is a display concern, 13 requests really did fail.
  if (input.thirdPartyErrors) {
    items.push(plural(input.thirdPartyErrors, 'third-party script error'));
  }
  if (input.thirdPartyFailures) {
    items.push(
      `${input.thirdPartyFailures} third-party request${input.thirdPartyFailures === 1 ? '' : 's'} blocked or failed`,
    );
  }
  if (items.length === 1) items.push('no console or network issues');
  return `Contents: ${items.join(' + ')}`;
}

function contentsLine(
  input: BundleInput,
  counts: { errors: ConsoleEntry[]; warnings: number; logs: number },
): string {
  const errorSplit = splitConsoleErrors(counts.errors, input.meta.url);
  const failureSplit = splitFailures(input.networkFailures, input.meta.url);
  return buildContentsLine({
    truncated: input.truncated,
    fullSize: input.fullSize,
    contentSize: input.contentSize,
    recorderActive: input.recorderActive,
    errors: errorSplit.firstParty.length,
    warnings: counts.warnings,
    logs: counts.logs,
    networkFailures: failureSplit.firstParty.length,
    thirdPartyErrors: errorSplit.thirdParty.length,
    thirdPartyFailures: failureSplit.thirdParty.length,
  });
}

export interface ContextBlockInput {
  url: string;
  title: string;
  capturedAt: Date;
  viewport: PageDimensions;
  contentSize: PageDimensions;
  /** Dimensions of the file on disk. Differs from contentSize when a footer was added. */
  imageSize: PageDimensions;
  /** Already-formatted captureModeLabel output. */
  captureMode: string;
  trigger: CaptureTrigger;
  recorderActive: boolean;
  stamp?: StampInfo;
  userAgent: string;
  /** Size at the real viewport, when the page re-laid out for a segmented capture. */
  naturalSize?: PageDimensions;
  /** The tab's page zoom when the capture started; captures normalize it to 1. */
  browserZoom?: number;
  /** Values scrubbed from the page record. Absent = the caller did not scrub, and no line is printed. */
  redacted?: number;
}

/** True when the captured layout is not the layout the user was looking at. */
function relaidOut(input: ContextBlockInput): boolean {
  const n = input.naturalSize;
  return Boolean(n && (n.width !== input.contentSize.width || n.height !== input.contentSize.height));
}

/**
 * How many image pixels there are per CSS pixel. 1 on the segmented path
 * (which pins deviceScaleFactor), 2 on a single-shot from a Retina display.
 * Rounded to two places because a stamped footer shifts the height ratio
 * slightly and only the width ratio is meaningful.
 */
function pixelScale(input: ContextBlockInput): number | null {
  if (!input.contentSize.width || !input.imageSize.width) return null;
  const ratio = input.imageSize.width / input.contentSize.width;
  if (Math.abs(ratio - 1) < 0.01) return null;
  return Math.round(ratio * 100) / 100;
}

/**
 * THE context block, and the reason this feature exists: an assistant reading
 * a report should never have to ask "is this localhost or production?" It is
 * the first content block of every report, before any console output, because
 * the answer changes what every line under it means.
 *
 * Ordering is deliberate — URL and Environment first, then the geometry, then
 * provenance. Nothing here is duplicated further down the file.
 */
export function contextBlock(input: ContextBlockInput): string[] {
  const environment = classifyEnvironment(input.url);
  const lines = [
    `- **URL:** ${input.url}`,
    `- **Environment:** ${environment.label}`,
    `- **Viewport:** ${input.viewport.width}×${input.viewport.height}`,
    `- **Full page:** ${input.contentSize.width}×${input.contentSize.height}`,
    ...(relaidOut(input)
      ? [
          '- **Relayout:** the segmented path captures under a virtual viewport, and the page ' +
            `re-laid out for it. Measured at the tab's own width first: ` +
            `${input.naturalSize?.width}×${input.naturalSize?.height}. The image is of the ` +
            `${input.contentSize.width}×${input.contentSize.height} layout named above. Expect ` +
            'viewport-relative sizing and media queries to differ from what was on screen.',
        ]
      : []),
    `- **Image file:** ${input.imageSize.width}×${input.imageSize.height}`,
    ...(pixelScale(input) !== null
      ? [
          `- **Pixel scale:** ${pixelScale(input)}× — the file holds ${pixelScale(input)} image ` +
            'pixels per CSS pixel (a high-DPI display). Coordinates measured in the image must be ' +
            `divided by ${pixelScale(input)} to match CSS pixels in DevTools.`,
        ]
      : []),
    ...(input.browserZoom !== undefined && Math.abs(input.browserZoom - 1) > 0.001
      ? [
          `- **Browser zoom:** the tab was at ${Math.round(input.browserZoom * 100)}%. The capture ` +
            'was taken at 100% and the zoom restored afterwards, so the image is 1:1 with CSS ' +
            'pixels and does not match the zoom level on screen.',
        ]
      : []),
    `- **Captured at:** ${input.capturedAt.toISOString()}`,
    `- **Capture mode:** ${input.captureMode}`,
    `- **Triggered by:** ${CAPTURE_TRIGGER_LABEL[input.trigger]}`,
    `- **URL stamp:** ${stampLabel(input.stamp)}`,
    `- **Recorder:** ${
      input.recorderActive
        ? 'active since page load — console and network data below are complete'
        : 'NOT ACTIVE for this page — console and network data are unavailable, not empty'
    }`,
    `- **Title:** ${input.title || '(untitled)'}`,
    `- **User agent:** ${input.userAgent}`,
    ...(input.redacted !== undefined ? [`- **Redacted:** ${redactedLabel(input.redacted)}`] : []),
  ];
  return lines;
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
        errors,
        warnings: warnings.length,
        logs: input.includeLogs ? logs.length : 0,
      }),
      ...contextBlock({
        url: meta.url,
        title: meta.title,
        capturedAt: input.capturedAt,
        viewport: meta.viewport,
        contentSize: input.contentSize,
        imageSize: input.imageSize,
        captureMode: captureModeLabel(
          input.captureMode,
          input.revealForced,
          input.segments,
          input.heightHeld,
          input.innerScrollers,
          input.framesHeld,
        ),
        trigger: input.trigger,
        recorderActive: input.recorderActive,
        stamp: input.stamp,
        naturalSize: input.naturalSize,
        browserZoom: input.browserZoom,
        userAgent: meta.userAgent,
        redacted: input.redacted,
      }),
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
    pageUrl: meta.url,
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
  /** Page URL, for first-party/third-party classification. */
  pageUrl: string;
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

  const errorSplit = splitConsoleErrors(input.errors, input.pageUrl);
  const failureSplit = splitFailures(input.networkFailures, input.pageUrl);
  const thirdPartyHosts = mergeHosts(errorSplit.thirdPartyHosts, failureSplit.thirdPartyHosts);

  const parts: string[] = ['## Console'];
  parts.push(`### Errors (${errorSplit.firstParty.length})`);
  parts.push(
    errorSplit.firstParty.length
      ? errorSplit.firstParty.map(consoleBlock).join('\n')
      : 'No console errors captured since page load.',
  );

  if (errorSplit.thirdParty.length) {
    parts.push(`### Third-party script errors (${errorSplit.thirdParty.length})`);
    parts.push(
      'Thrown by scripts served from another domain — usually a vendor widget, not this page\'s code.',
    );
    parts.push(errorSplit.thirdParty.map(consoleBlock).join('\n'));
  }

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
  if (failureSplit.firstParty.length) {
    parts.push(
      collapseFailures(failureSplit.firstParty, input.pageUrl).map(formatFailureLine).join('\n'),
    );
  } else {
    parts.push('No failed first-party network requests captured since page load.');
  }

  if (failureSplit.thirdParty.length) {
    parts.push('## Third-party requests (blocked or failed)');
    parts.push(
      'Requests to other domains — commonly analytics or ad beacons stopped by a blocker, not defects in this page.',
    );
    parts.push(
      collapseFailures(failureSplit.thirdParty, input.pageUrl).map(formatFailureLine).join('\n'),
    );
  }

  // Inspectability: state which hosts were reclassified. If the rule ever
  // gets it wrong, the user can see that it happened instead of wondering
  // why a failure disappeared from the section above.
  if (thirdPartyHosts.length) {
    parts.push(
      `Hosts treated as third-party on this page: ${thirdPartyHosts.map(formatDemotedHost).join(', ')}`,
    );
  }
  return parts;
}

export interface SweepWidthInput {
  width: number;
  filename: string;
  fullSize: PageDimensions;
  contentSize: PageDimensions;
  /** Dimensions of the file on disk, footer included. */
  imageSize: PageDimensions;
  truncated: boolean;
  captureMode: CaptureMode;
  revealForced: number;
  heightHeld?: number;
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
  viewport: PageDimensions;
  /** Present only when the URL footer was composited onto the widths. */
  stamp?: StampInfo;
  /** Values scrubbed from the page record this report was built from. */
  redacted?: number;
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
  // The same context grammar as a page report, minus the per-width geometry
  // that each width states for itself below.
  const environment = classifyEnvironment(meta.url);
  parts.push(
    [
      `- **URL:** ${meta.url}`,
      `- **Environment:** ${environment.label}`,
      `- **Viewport:** ${input.viewport.width}×${input.viewport.height}`,
      `- **Captured at:** ${input.capturedAt.toISOString()}`,
      `- **Widths:** ${input.widths.map((w) => `${w.width} px`).join(', ') || '(none)'}`,
      `- **Triggered by:** ${CAPTURE_TRIGGER_LABEL.sweep}`,
      `- **URL stamp:** ${stampLabel(input.stamp)}`,
      `- **Recorder:** ${
        input.recorderActive
          ? 'active since page load — console and network data below are complete'
          : 'NOT ACTIVE for this page — console and network data are unavailable, not empty'
      }`,
      `- **Title:** ${meta.title || '(untitled)'}`,
      `- **User agent:** ${meta.userAgent}`,
      ...(input.redacted !== undefined ? [`- **Redacted:** ${redactedLabel(input.redacted)}`] : []),
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
          thirdPartyErrors: 0,
          thirdPartyFailures: 0,
        }),
        `- **Size:** ${width.fullSize.width}×${width.fullSize.height}`,
        `- **Image file:** ${width.imageSize.width}×${width.imageSize.height}`,
        `- **Capture mode:** ${captureModeLabel(width.captureMode, width.revealForced, width.segments, width.heightHeld)}`,
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
    pageUrl: meta.url,
  }));

  return parts.join('\n\n') + '\n';
}

/** Clipboard variant: same markdown with a one-line pointer to the image on top. */
export function buildClipboardMarkdown(markdown: string, imageFilename: string): string {
  return `> Screenshot saved as \`${imageFilename}\` — attach it alongside this report.\n\n${markdown}`;
}

/**
 * The rolling-copy notice, inserted immediately under the H1 of latest.md.
 *
 * latest.md and its timestamped original are byte-identical apart from this
 * line, and an assistant handed the rolling copy has no way to tell which one
 * it is holding — or that the file it read a minute ago has since been
 * replaced. One line fixes that.
 */
export const LATEST_NOTICE =
  '_This is the rolling copy — always the most recent capture. Timestamped originals sit alongside it._';

/**
 * Inserts the notice after the first line (the H1). Falls back to prepending
 * if the report somehow has no heading, so the notice is never lost.
 */
export function withLatestNotice(markdown: string): string {
  const newline = markdown.indexOf('\n');
  if (newline === -1 || !markdown.startsWith('# ')) {
    return `${LATEST_NOTICE}\n\n${markdown}`;
  }
  return `${markdown.slice(0, newline)}\n\n${LATEST_NOTICE}${markdown.slice(newline)}`;
}

/**
 * Written once into the output folder, the first time a bundle lands there and
 * finds no README.txt. Plain text, not markdown: it is for a human opening the
 * folder in Finder, and it should not render as anything.
 *
 * Never overwrites — someone may have put their own notes here.
 */
export const OUTPUT_README = `capture-kit — what is in this folder

{page-title}_{date}_{time}.jpg   one capture's screenshot
{page-title}_{date}_{time}.md    that capture's report: URL, environment, console errors, network failures
latest.jpg / latest.md           the most recent capture, overwritten every time — the stable path to point an AI assistant at
session_{date}_{time}/           a multi-tab session capture, with an index.md triaging every page
{page-title}_{date}_{time}_sweep.md   a responsive sweep: the same page at 375, 768 and 1440 px wide

Tell your assistant once: "when I say check my capture, read latest.md and the image next to it."
`;
