import type { CaptureResultMeta, ResultImagePayload } from '../lib/messages';
import { buildClipboardMarkdown } from '../lib/bundle/markdown';
import { requestOutputDirPermission } from '../lib/output-dir';

const headlineEl = document.getElementById('headline') as HTMLHeadingElement;
const metaEl = document.getElementById('meta') as HTMLDivElement;
const imagesEl = document.getElementById('images') as HTMLDivElement;
const warningsEl = document.getElementById('warnings') as HTMLDivElement;
const markdownPane = document.getElementById('markdown-pane') as HTMLElement;
const markdownEl = document.getElementById('markdown') as HTMLPreElement;
const showInFinderBtn = document.getElementById('show-in-finder') as HTMLButtonElement;
const copyReportBtn = document.getElementById('copy-report') as HTMLButtonElement;
const copyImageReportBtn = document.getElementById('copy-image-report') as HTMLButtonElement;
const copyImageBtn = document.getElementById('copy-image') as HTMLButtonElement;
const copyImageKeyEl = document.getElementById('copy-image-key') as HTMLSpanElement;
const copyImageReportKeyEl = document.getElementById('copy-image-report-key') as HTMLSpanElement;
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

const IS_MAC = navigator.userAgent.includes('Mac');

/** The key the dual-format copy rides on, alongside the platform's copy modifier. */
const DUAL_COPY_KEY = 'c';

function shortcutLabel(dual: boolean): string {
  const key = (dual ? DUAL_COPY_KEY : 'c').toUpperCase();
  if (IS_MAC) return dual ? `⌘⇧${key}` : `⌘${key}`;
  return dual ? `Ctrl+Shift+${key}` : `Ctrl+${key}`;
}

/**
 * Every capture states where its files went. The 2026-08-17 failure was files
 * landing somewhere nobody expected with nothing on screen to say so.
 */
function outputChip(output: CaptureResultMeta['output']): HTMLElement {
  return output.via === 'chosen'
    ? chip('Output', `${output.label} (your folder)`)
    : chip('Output', `${output.label}${output.lapsed ? ' (fallback)' : ''}`);
}

/** The one-click re-arm. This page is an extension page, so the click counts. */
function reconnectButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Reconnect the folder';
  button.addEventListener('click', () => {
    void (async () => {
      const status = await requestOutputDirPermission();
      button.disabled = status.state === 'granted';
      button.textContent =
        status.state === 'granted'
          ? `Reconnected — the next capture goes to ${status.name}`
          : 'Chrome refused. Open Settings and choose the folder again.';
    })();
  });
  return button;
}

function renderWarnings(meta: CaptureResultMeta): void {
  if (meta.output.lapsed) {
    addWarning(
      'Your chosen folder lost its write permission, so this went to Downloads.',
      'Chrome only gives that permission back when you ask — one click here is enough, and the ' +
        'folder stays the one you already picked. If Chrome offers "allow on every visit", take ' +
        'it and this stops happening after restarts.',
      reconnectButton(),
    );
  }

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

function drawToPng(bitmap: ImageBitmap, scale: number): Promise<Blob> {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a canvas to re-encode with.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Encode at native size first, then look at what came out. PNG size tracks
 * content rather than dimensions — flat UI compresses to almost nothing, a
 * photo does not — so a pixel cap guesses at the wrong variable. Downscaling
 * is also the expensive branch, not the cheap one: on a real 1863×4568
 * capture, capping the long edge saved 14% of the bytes and cost 75% more
 * time. So it earns its place only as a backstop against a pathological page,
 * and the threshold is LARGE_PNG_BYTES — the size this product already calls
 * a very large PNG in renderWarnings. One number for one idea. One retry,
 * never a loop: a loop turns a slow path into a much slower one.
 */
async function toPngBlob(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const png = await drawToPng(bitmap, 1);
    if (png.size <= LARGE_PNG_BYTES) return png;
    return await drawToPng(bitmap, Math.sqrt(LARGE_PNG_BYTES / png.size));
  } finally {
    bitmap.close();
  }
}

/**
 * The clipboard accepts image/png only, and the default capture format is JPEG
 * (see settings.ts), so every image copy re-encodes. Memoized because both
 * shortcuts and both buttons want the same bytes, and copying twice must not
 * pay for the encode twice.
 */
let clipboardPngPromise: Promise<Blob> | null = null;

/** Set once the preview for the first image has decoded — see the render loop. */
let firstImageBlob: Blob | null = null;

function clipboardPng(captureId: string): Promise<Blob> {
  clipboardPngPromise ??= (async () => {
    let source = firstImageBlob;
    if (!source) {
      // Only before the preview has finished decoding; after that the page owns
      // the bytes and never has to ask the service worker again.
      const payload = await fetchImage(captureId, 0);
      if (!payload) throw new Error('The image preview expired.');
      source = base64ToBlob(payload.base64, payload.mime);
    }
    return toPngBlob(source);
  })();
  return clipboardPngPromise;
}

async function buildAiText(meta: CaptureResultMeta): Promise<string> {
  const paths = await resolvePaths(meta);
  const body = meta.markdown ? `${meta.markdown}\n` : '';
  return `${body}Files on disk:\n${paths.map((p) => `- ${p}`).join('\n')}\n`;
}

/** A failed write is usually a dead preview, not a dead clipboard — say which. */
async function copyFailure(png: Promise<Blob>): Promise<string> {
  try {
    await png;
    return 'Could not reach the clipboard';
  } catch {
    return 'The image preview expired — use Show in Finder to open the file';
  }
}

/*
 * Both paths hand ClipboardItem its values as promises and call write()
 * immediately. Resolving the PNG or the download paths first would spend the
 * user gesture: Chrome's transient activation expires while we work, and the
 * write then fails on a payload that was otherwise ready. One ClipboardItem
 * per call — Chrome rejects an array of several, but several types inside one
 * is exactly the supported shape.
 */

async function copyImage(captureId: string): Promise<void> {
  const png = clipboardPng(captureId);
  png.catch(() => {
    /* reported through the write below */
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flashStatus('Image copied');
  } catch {
    setStatus(await copyFailure(png), true);
  }
}

async function copyImageAndReport(captureId: string, meta: CaptureResultMeta): Promise<void> {
  const png = clipboardPng(captureId);
  png.catch(() => {
    /* falls back to the text half below */
  });
  const text = buildAiText(meta);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': png,
        'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' })),
      }),
    ]);
    flashStatus('Copied — image and report');
  } catch {
    // A dead preview must not cost the report too: the text half is still good.
    try {
      await navigator.clipboard.writeText(await text);
      flashStatus('Copied the report — the image preview had expired');
    } catch {
      setStatus('Could not reach the clipboard', true);
    }
  }
}

/**
 * Absolute paths for the "Copy image + report" block, read from the download records at
 * render time. A path that no longer resolves must say so — a broken path in
 * a block someone pastes to an assistant fails silently and wastes their time.
 */
async function resolvePaths(meta: CaptureResultMeta): Promise<string[]> {
  const lines: string[] = [];
  for (const image of meta.images) {
    if (image.downloadId === null) {
      // The File System Access API deliberately withholds real paths, so the
      // best available answer is the folder the user picked plus the name.
      lines.push(`${meta.output.label}/${image.filename}`);
      continue;
    }
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
    copyImageReportBtn.hidden = true;
    copyReportBtn.hidden = true;
    copyImageBtn.hidden = true;
    zoomEl.hidden = true;
    return;
  }

  // "Copy report" names a real control on this surface — the tooltip on
  // "Copy image + report" sends people to it by name, so it is a visible
  // button rather than the hidden one it used to be. It still hides when
  // there is no report to copy (an "Image only" capture), because a button
  // that copies nothing is worse than no button.
  copyReportBtn.hidden = !meta.markdown;

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
  metaEl.appendChild(outputChip(meta.output));

  renderWarnings(meta);

  // Files written through the File System Access API have no download record,
  // and chrome.downloads.show is the only reveal API an extension has — so the
  // button hides rather than lying about what it can do.
  const revealId = meta.images[0]?.downloadId ?? null;
  if (revealId === null) {
    showInFinderBtn.hidden = true;
  } else {
    showInFinderBtn.addEventListener('click', () => {
      chrome.downloads.show(revealId);
    });
  }

  copyImageKeyEl.textContent = shortcutLabel(false);
  copyImageReportKeyEl.textContent = shortcutLabel(true);

  copyImageBtn.addEventListener('click', () => void copyImage(captureId));
  copyImageReportBtn.addEventListener('click', () => void copyImageAndReport(captureId, meta));

  /*
   * Two paths, separated by a modifier rather than a setting. A designer wants
   * the picture and a wall of markdown in Figma would be a defect; a developer
   * wants the picture and the context. A toggle would make one key mean two
   * things depending on state nobody can see, so the plain key stays the plain
   * thing. A live text selection outranks both — highlighting inside the report
   * pane must still copy what was highlighted.
   */
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey) {
      if (key !== DUAL_COPY_KEY) return;
      event.preventDefault();
      void copyImageAndReport(captureId, meta);
    } else {
      if (key !== 'c') return;
      event.preventDefault();
      void copyImage(captureId);
    }
  });

  if (meta.markdown) {
    const markdown = meta.markdown;
    const clipboardVariant = buildClipboardMarkdown(markdown, first?.filename ?? '');
    markdownPane.hidden = false;
    markdownEl.textContent = markdown;
    copyReportBtn.addEventListener('click', () => {
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
    const blob = base64ToBlob(payload.base64, payload.mime);
    // Hold on to the bytes the preview already decoded. The service worker's
    // copy lives in memory and dies with the worker, so a result tab left open
    // for a minute can no longer answer GET_RESULT_IMAGE — and a copy button
    // that stops working once the tab goes quiet is worse than no button.
    if (index === 0) firstImageBlob = blob;
    const img = document.createElement('img');
    img.alt = image.filename;
    img.src = URL.createObjectURL(blob);
    img.addEventListener('click', () => setView(imagesEl.classList.contains('full')));
    frame.appendChild(img);
  }
}

void main();
