import type { CaptureResultMeta, ResultImagePayload } from '../lib/messages';
import { buildClipboardMarkdown } from '../lib/bundle/markdown';

const metaEl = document.getElementById('meta') as HTMLParagraphElement;
const imagesEl = document.getElementById('images') as HTMLDivElement;
const markdownPane = document.getElementById('markdown-pane') as HTMLElement;
const markdownEl = document.getElementById('markdown') as HTMLPreElement;
const showInFinderBtn = document.getElementById('show-in-finder') as HTMLButtonElement;
const copyMarkdownBtn = document.getElementById('copy-markdown') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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

async function main(): Promise<void> {
  const captureId = new URLSearchParams(location.search).get('id') ?? '';
  const key = `result:${captureId}`;
  const stored = await chrome.storage.session.get(key);
  const meta = stored[key] as CaptureResultMeta | undefined;
  if (!meta) {
    metaEl.textContent =
      'Result not found — it belongs to a previous browser session. The files are still in Downloads/capture-kit.';
    showInFinderBtn.hidden = true;
    return;
  }

  document.title = `capture-kit — ${meta.images[0]?.filename ?? 'result'}`;
  metaEl.textContent = meta.images
    .map((img) => `${img.filename} — ${img.width}×${img.height}, ${formatBytes(img.bytes)}`)
    .join('  ·  ')
    .concat(`  ·  Capture mode: ${meta.captureModeLabel}`);

  showInFinderBtn.addEventListener('click', () => {
    chrome.downloads.show(meta.images[0].downloadId);
  });

  if (meta.kind === 'bundle' && meta.markdown) {
    const markdown = meta.markdown;
    const clipboardVariant = buildClipboardMarkdown(markdown, meta.images[0].filename);
    markdownPane.hidden = false;
    markdownEl.textContent = markdown;
    copyMarkdownBtn.hidden = false;
    copyMarkdownBtn.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(clipboardVariant)
        .then(() => setStatus('Markdown copied.'))
        .catch(() => setStatus('Clipboard write failed.', true));
    });
    // The popup closes when this tab opens, which kills its clipboard write —
    // this page has focus now, so it honors the "markdown copied" promise.
    void navigator.clipboard
      .writeText(clipboardVariant)
      .then(() => setStatus('Markdown copied to clipboard.'))
      .catch(() => {
        /* user can use the button */
      });
  }

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
        'Preview expired (the extension background restarted). Use "Show in Finder" to open the saved file.';
      frame.appendChild(note);
      continue;
    }
    const img = document.createElement('img');
    img.alt = image.filename;
    img.src = URL.createObjectURL(base64ToBlob(payload.base64, payload.mime));
    img.addEventListener('click', () => img.classList.toggle('zoomed'));
    frame.appendChild(img);
  }
}

void main();
