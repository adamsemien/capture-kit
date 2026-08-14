import type { CaptureResultMeta, ResultImagePayload } from '../lib/messages';
import { buildClipboardMarkdown } from '../lib/bundle/markdown';

const headlineEl = document.getElementById('headline') as HTMLHeadingElement;
const metaEl = document.getElementById('meta') as HTMLDivElement;
const imagesEl = document.getElementById('images') as HTMLDivElement;
const warningsEl = document.getElementById('warnings') as HTMLDivElement;
const markdownPane = document.getElementById('markdown-pane') as HTMLElement;
const markdownEl = document.getElementById('markdown') as HTMLPreElement;
const showInFinderBtn = document.getElementById('show-in-finder') as HTMLButtonElement;
const copyMarkdownBtn = document.getElementById('copy-markdown') as HTMLButtonElement;
const copyForAiBtn = document.getElementById('copy-for-ai') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const zoomEl = document.getElementById('zoom') as HTMLDivElement;
const viewFitBtn = document.getElementById('view-fit') as HTMLButtonElement;
const viewFullBtn = document.getElementById('view-full') as HTMLButtonElement;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

function flashStatus(text: string): void {
  setStatus(text);
  setTimeout(() => setStatus(''), 2200);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function chip(label: string, value: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'chip';
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const valueEl = document.createElement('b');
  valueEl.textContent = value;
  el.append(labelEl, valueEl);
  return el;
}

/** Appends a warning band; `body` nodes are appended after the headline. */
function addWarning(headline: string, ...body: (string | Node)[]): void {
  const band = document.createElement('div');
  band.className = 'warn-band';
  const strong = document.createElement('strong');
  strong.textContent = headline;
  band.appendChild(strong);
  for (const part of body) {
    const p = document.createElement('p');
    if (typeof part === 'string') p.textContent = part;
    else p.appendChild(part);
    band.appendChild(p);
  }
  warningsEl.appendChild(band);
}

/** Small mono line for API names — the human sentence stays on top. */
function technicalLine(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'technical';
  p.textContent = text;
  return p;
}

const LARGE_PNG_BYTES = 10 * 1024 * 1024;

function renderWarnings(meta: CaptureResultMeta): void {
  // One band for the whole capture: a report renames four files at once, and
  // four identical warnings would read as noise rather than one problem.
  if (meta.filenameConflicts.length) {
    const list = document.createElement('ul');
    for (const conflict of meta.filenameConflicts) {
      const li = document.createElement('li');
      const requested = document.createElement('code');
      requested.textContent = conflict.requested;
      const saved = document.createElement('code');
      saved.textContent = conflict.saved;
      li.append('asked for ', requested, ' — saved as ', saved);
      list.appendChild(li);
    }
    addWarning(
      'Something else in Chrome renamed your files.',
      list,
      'Another extension is taking over download names — usually a download manager. Turn those off one at a time at chrome://extensions and capture again, and the names will land correctly. Chrome does not tell us which extension did it.',
      technicalLine('The extension claimed chrome.downloads.onDeterminingFilename.'),
    );
  }

  for (const image of meta.images) {
    if (image.filename.endsWith('.png') && image.bytes > LARGE_PNG_BYTES) {
      addWarning(
        `That PNG came to ${formatBytes(image.bytes)}.`,
        'PNG keeps every pixel exactly, so a long page gets very large. The same capture as JPEG is usually a few hundred kilobytes — untick PNG in the popup unless you need it lossless.',
      );
    }
  }
}

async function fetchImage(captureId: string, index: number): Promise<ResultImagePayload> {
  try {
    return (await chrome.runtime.sendMessage({
      type: 'GET_RESULT_IMAGE',
      captureId,
      index,
    })) as ResultImagePayload;
  } catch {
    return null;
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Absolute paths for the Copy for AI block, read from the download records at
 * render time. A path that no longer resolves must say so — a broken path in
 * a block someone pastes to an assistant fails silently and wastes their time.
 */
async function resolvePaths(meta: CaptureResultMeta): Promise<string[]> {
  const lines: string[] = [];
  for (const image of meta.images) {
    try {
      const [item] = await chrome.downloads.search({ id: image.downloadId });
      if (!item) {
        lines.push(`${image.filename} — file record is gone, so the path is unknown`);
      } else if (item.exists === false) {
        lines.push(`${item.filename} — moved or deleted since the capture`);
      } else {
        lines.push(item.filename);
      }
    } catch {
      lines.push(`${image.filename} — could not look up the path`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id') ?? '';
  const key = `result:${captureId}`;
  const stored = await chrome.storage.session.get(key);
  const meta = stored[key] as CaptureResultMeta | undefined;
  if (!meta) {
    headlineEl.textContent = 'This result is from an earlier browsing session';
    metaEl.append(
      chip('Files', 'Still in your Downloads/capture-kit folder'),
    );
    showInFinderBtn.hidden = true;
    copyForAiBtn.hidden = true;
    zoomEl.hidden = true;
    return;
  }

  const first = meta.images[0];
  document.title = `capture-kit — ${first?.filename ?? 'result'}`;
  headlineEl.textContent =
    meta.kind === 'sweep'
      ? `Captured at ${meta.images.length} widths`
      : (first?.filename ?? 'Capture');

  if (meta.kind === 'sweep') {
    for (const image of meta.images) {
      metaEl.appendChild(chip(image.label ?? 'Width', `${image.width}×${image.height}`));
    }
  } else if (first) {
    metaEl.appendChild(chip('Size', `${first.width}×${first.height}`));
    metaEl.appendChild(chip('File', formatBytes(first.bytes)));
  }
  metaEl.appendChild(chip('Mode', meta.captureModeLabel));

  renderWarnings(meta);

  showInFinderBtn.addEventListener('click', () => {
    chrome.downloads.show(meta.images[0].downloadId);
  });

  copyForAiBtn.addEventListener('click', () => {
    void (async () => {
      const paths = await resolvePaths(meta);
      const body = meta.markdown ? `${meta.markdown}\n` : '';
      const text = `${body}Files on disk:\n${paths.map((p) => `- ${p}`).join('\n')}\n`;
      try {
        await navigator.clipboard.writeText(text);
        flashStatus('Copied — paste it to your assistant');
      } catch {
        setStatus('Could not reach the clipboard', true);
      }
    })();
  });

  if (meta.markdown) {
    const markdown = meta.markdown;
    const clipboardVariant = buildClipboardMarkdown(markdown, first?.filename ?? '');
    markdownPane.hidden = false;
    markdownEl.textContent = markdown;
    copyMarkdownBtn.hidden = false;
    copyMarkdownBtn.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(clipboardVariant)
        .then(() => flashStatus('Report copied'))
        .catch(() => setStatus('Could not reach the clipboard', true));
    });
    // The popup closes when this tab opens, which kills its clipboard write —
    // this page has focus now, so it honors the "report copied" promise.
    // Sweeps never promised a clipboard write, so they only get the button.
    if (meta.kind === 'bundle') {
      void navigator.clipboard
        .writeText(clipboardVariant)
        .then(() => flashStatus('Report copied to your clipboard'))
        .catch(() => {
          /* the buttons are still there */
        });
    }
  }

  // Fit is the default view: a 12,000px capture opening at 100% shows a
  // meaningless sliver of the top.
  const setView = (fit: boolean) => {
    imagesEl.className = fit ? 'images fit' : 'images full';
    viewFitBtn.classList.toggle('on', fit);
    viewFullBtn.classList.toggle('on', !fit);
  };
  setView(true);
  viewFitBtn.addEventListener('click', () => setView(true));
  viewFullBtn.addEventListener('click', () => setView(false));

  for (let index = 0; index < meta.images.length; index++) {
    const image = meta.images[index];
    const figure = document.createElement('figure');
    if (image.label) {
      const caption = document.createElement('figcaption');
      caption.textContent = `${image.label} — ${image.filename}`;
      figure.appendChild(caption);
    }
    const frame = document.createElement('div');
    frame.className = 'frame';
    figure.appendChild(frame);
    imagesEl.appendChild(figure);

    const payload = await fetchImage(captureId, index);
    if (!payload) {
      const note = document.createElement('p');
      note.className = 'expired';
      note.textContent =
        'The preview expired when the extension restarted. The file itself is fine — use Show in Finder to open it.';
      frame.appendChild(note);
      continue;
    }
    const img = document.createElement('img');
    img.alt = image.filename;
    img.src = URL.createObjectURL(base64ToBlob(payload.base64, payload.mime));
    img.addEventListener('click', () => setView(imagesEl.classList.contains('full')));
    frame.appendChild(img);
  }
}

void main();
