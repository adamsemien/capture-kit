/*
 * The offscreen document: where a clip is actually recorded (NOBC-158).
 *
 * A service worker has no DOM, so it cannot hold a MediaRecorder or draw on a
 * canvas. The worker gets a tab stream id from chrome.tabCapture and hands it
 * here; this page turns it into a MediaStream, records it, samples frames as
 * it goes, and at the end picks the frames that changed and lays them on one
 * sheet. Everything goes back to the worker as base64 in the response, and
 * the worker closes this document.
 *
 * Only runtime messaging works in an offscreen document, and every runtime
 * message reaches every listener in the extension, so messages are routed by
 * `target`.
 */

import {
  THUMB_H,
  THUMB_W,
  offsetLabel,
  selectFrames,
  sheetLayout,
} from '../lib/clip/frames';
import type { SampledFrame } from '../lib/clip/frames';
import type { ClipRecordRequest, ClipRecordResponse } from '../lib/messages';

const FRAME_JPEG_QUALITY = 0.85;
const SHEET_JPEG_QUALITY = 0.85;

interface KeptFrame extends SampledFrame {
  blob: Blob;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), type, quality);
  });
}

function pickMimeType(): string {
  for (const candidate of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

async function record(request: ClipRecordRequest): Promise<ClipRecordResponse> {
  // The constraint shape Chrome's tabCapture docs give: a `mandatory` block
  // naming the source kind and the stream id. Not in the standard typings.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: request.streamId,
      },
    },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('could not start the tab stream'));
  });
  await video.play();
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;

  const full = document.createElement('canvas');
  full.width = frameWidth;
  full.height = frameHeight;
  const fullCtx = full.getContext('2d', { willReadFrequently: false });
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });
  if (!fullCtx || !thumbCtx) throw new Error('no canvas context');

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  const frames: KeptFrame[] = [];
  const startedAt = performance.now();
  let sampling = false;
  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      const at = Math.round(performance.now() - startedAt);
      fullCtx.drawImage(video, 0, 0, frameWidth, frameHeight);
      thumbCtx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
      const rgba = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
      const luma = new Uint8Array(THUMB_W * THUMB_H);
      for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
        luma[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
      }
      const blob = await canvasBlob(full, 'image/jpeg', FRAME_JPEG_QUALITY);
      frames.push({ at, luma, blob });
    } finally {
      sampling = false;
    }
  };

  recorder.start(250);
  const interval = setInterval(() => void sample(), Math.max(50, Math.round(1000 / request.fps)));
  await sample();
  await new Promise((resolve) => setTimeout(resolve, request.seconds * 1000));
  clearInterval(interval);
  await sample();
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const durationMs = Math.round(performance.now() - startedAt);

  const chosen = selectFrames(frames, { maxFrames: request.maxFrames });
  const layout = sheetLayout(chosen.length, frameWidth, frameHeight, {
    sheetWidth: Math.min(1800, Math.max(900, frameWidth)),
  });
  const sheet = document.createElement('canvas');
  sheet.width = layout.width;
  sheet.height = layout.height;
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('no sheet context');
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '600 18px -apple-system, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chosen.length; i++) {
    const frame = frames[chosen[i]];
    const tile = layout.tiles[i];
    const bitmap = await createImageBitmap(frame.blob);
    ctx.drawImage(bitmap, tile.x, tile.y, layout.tileWidth, layout.tileHeight);
    bitmap.close();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(tile.x + 0.5, tile.y + 0.5, layout.tileWidth - 1, layout.tileHeight - 1);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillText(
      `${i + 1}  ${offsetLabel(frame.at)}`,
      tile.x + 2,
      tile.y + layout.tileHeight + layout.labelHeight / 2,
    );
  }
  const sheetBlob = await canvasBlob(sheet, 'image/jpeg', SHEET_JPEG_QUALITY);
  const videoBlob = new Blob(chunks, { type: mimeType || 'video/webm' });

  return {
    ok: true,
    video: await blobToBase64(videoBlob),
    videoMime: 'video/webm',
    sheet: await blobToBase64(sheetBlob),
    sheetWidth: layout.width,
    sheetHeight: layout.height,
    frameWidth,
    frameHeight,
    frameOffsetsMs: chosen.map((i) => frames[i].at),
    sampledFrames: frames.length,
    durationMs,
  };
}

chrome.runtime.onMessage.addListener((message: { target?: string } & Partial<ClipRecordRequest>, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'CLIP_RECORD') return false;
  void record(message as ClipRecordRequest)
    .then(sendResponse)
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, reason } satisfies ClipRecordResponse);
    });
  return true;
});
