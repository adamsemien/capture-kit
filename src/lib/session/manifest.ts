import type { ConsoleEntry, NetworkFailure } from '../messages';
import { collapseFailures, formatFailureLine } from '../net-classify';
import { redactedLabel } from '../redact';

/**
 * The session index is a TRIAGE document, not an archive. A real browser
 * session emits hundreds of lines of third-party noise — deprecation notices,
 * dev-mode warnings, analytics chatter — and an index that reprints all of it
 * will not be read. So the index carries only what answers "which page is
 * broken and why": console ERRORS and network FAILURES, in full. Warnings,
 * logs, user agent and viewport live in the per-page report.
 */

export interface SessionPage {
  title: string;
  url: string;
  /** Built by buildContentsLine — one grammar across reports and manifests. */
  contents: string;
  imageFilename: string;
  markdownFilename: string;
  /** Numbered names this page has in the latest-session mirror (01.jpg, 01.md). */
  mirrorImageFilename: string;
  mirrorMarkdownFilename: string;
  /** First-party console errors, plus any whose source could not be resolved. */
  errors: ConsoleEntry[];
  /** Errors thrown by scripts on other domains — listed, but not counted as this page's. */
  thirdPartyErrors: ConsoleEntry[];
  /** First-party network failures only. */
  networkFailures: NetworkFailure[];
  /** Blocked or failed requests to other domains — usually a blocker doing its job. */
  thirdPartyFailures: NetworkFailure[];
  warningCount: number;
  recorderActive: boolean;
  /** Values scrubbed from this page's report. */
  redacted: number;
}

export interface SessionFailure {
  title: string;
  url: string;
  reason: string;
}

export interface SessionIndexInput {
  capturedAt: Date;
  pages: SessionPage[];
  failures: SessionFailure[];
  /** Per-tab wall time, in capture order, for the timing footer. */
  timings: { title: string; ms: number }[];
  totalMs: number;
  cancelled: boolean;
  /** Set for the latest-session mirror, whose numbered files can go stale. */
  pointerFolder?: boolean;
}

/**
 * First-party trouble first, then "probably not your bug" (warnings and
 * third-party noise), then clean, then unrecorded. A page whose only
 * failures are blocked third-party beacons is neither broken nor clean.
 */
function severityRank(page: SessionPage): number {
  if (!page.recorderActive) return 3;
  if (page.errors.length || page.networkFailures.length) return 0;
  if (page.warningCount || page.thirdPartyErrors.length || page.thirdPartyFailures.length) return 1;
  return 2;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function stamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Repo titles run to hundreds of characters and would swamp the timing line. */
function shortTitle(title: string): string {
  const clean = title.trim();
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

/** One line per error: message plus call site when the recorder resolved one. */
function errorLine(entry: ConsoleEntry): string {
  const message = entry.message.replace(/\s*\n\s*/g, ' ').trim();
  return entry.source ? `- ${message} — ${entry.source}` : `- ${message}`;
}

export function buildSessionIndex(input: SessionIndexInput): string {
  const ordered = input.pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => severityRank(a.page) - severityRank(b.page) || a.index - b.index)
    .map((entry) => entry.page);

  const withIssues = input.pages.filter(
    (p) => p.errors.length || p.networkFailures.length,
  ).length;
  const pageWord = input.pages.length === 1 ? 'page' : 'pages';

  const parts: string[] = [];
  parts.push(
    `# Session — ${stamp(input.capturedAt)} — ${input.pages.length} ${pageWord}, ${withIssues} with errors`,
  );

  const intro: string[] = ['Pages with issues are listed first.'];
  if (input.pointerFolder) {
    intro.push(
      `This folder mirrors the most recent session and is overwritten in place. It holds ${input.pages.length} ${pageWord} (01–${pad(input.pages.length)}); any higher-numbered files are leftovers from an earlier, longer session — ignore them.`,
    );
  }
  if (input.cancelled) {
    intro.push('This run was cancelled — pages below are the ones captured before it stopped.');
  }
  intro.push(`Redacted: ${redactedLabel(input.pages.reduce((sum, p) => sum + p.redacted, 0))}`);
  parts.push(intro.join('\n\n'));

  ordered.forEach((page, index) => {
    parts.push(`## ${index + 1}. ${page.title || page.url}`);
    // The mirror folder holds numbered copies, so its index must name those —
    // otherwise a reader following this file looks for files that are only in
    // the timestamped session folder.
    const head = [
      page.url,
      page.contents,
      input.pointerFolder
        ? `Files: ${page.mirrorImageFilename} + ${page.mirrorMarkdownFilename}`
        : `Files: ${page.imageFilename} + ${page.markdownFilename}`,
    ];
    parts.push(head.join('\n'));

    if (page.errors.length) {
      parts.push(['Errors:', ...page.errors.map(errorLine)].join('\n'));
    }
    if (page.networkFailures.length) {
      parts.push(
        [
          'Network failures:',
          ...collapseFailures(page.networkFailures, page.url).map(formatFailureLine),
        ].join('\n'),
      );
    }
    if (page.thirdPartyErrors.length) {
      parts.push(
        ['Third-party script errors:', ...page.thirdPartyErrors.map(errorLine)].join('\n'),
      );
    }
    if (page.thirdPartyFailures.length) {
      parts.push(
        [
          'Third-party requests (blocked or failed):',
          ...collapseFailures(page.thirdPartyFailures, page.url).map(formatFailureLine),
        ].join('\n'),
      );
    }
  });

  if (input.failures.length) {
    parts.push('## Could not capture');
    parts.push(
      input.failures
        .map((f) => `- ${f.title || f.url || '(unknown tab)'} — ${f.reason}`)
        .join('\n'),
    );
  }

  const timingDetail = input.timings
    .map((t) => `${shortTitle(t.title)}: ${seconds(t.ms)}`)
    .join(' · ');
  parts.push('---');
  parts.push(
    `Captured in ${seconds(input.totalMs)} total${timingDetail ? ` — ${timingDetail}` : ''}.`,
  );

  return parts.join('\n\n') + '\n';
}
