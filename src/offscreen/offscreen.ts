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
  FramePicker,
  THUMB_H,
  THUMB_W,
  offsetLabel,
  selectFrames,
  sheetLayout,
} from '../lib/clip/frames';
import type { ClipRecordRequest, ClipRecordResponse } from '../lib/messages';

// MediaStreamTrackProcessor (Chrome 94+) is not in the DOM typings this
// project compiles against; the shape used here is the whole of it.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

const FRAME_JPEG_QUALITY = 0.85;
const SHEET_JPEG_QUALITY = 0.85;

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
        // The tab's own size. Without this Chrome sizes the stream to the
        // screen and letterboxes the tab into it - black bars on every frame.
        maxWidth: request.width,
        maxHeight: request.height,
      },
    },
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error('the tab stream has no video track');

  // Frames come straight off the track. This document is hidden, and Chrome
  // throttles timers in hidden pages to about once a second - a setInterval
  // sampler produced six frames in five seconds. A track processor hands over
  // every frame the tab paints, untouched by timer throttling; the clip's
  // clock is the frames' own timestamps, so the length is honest too.
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();

  const thumb = document.createElement('canvas');
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });
  if (!thumbCtx) throw new Error('no canvas context');

  // Nothing is encoded while recording. An encode resolves on a task the
  // hidden document runs about once a second, and waiting on it starved the
  // sampler to one frame a second. Each sample is instead a synchronous copy
  // into a full-size canvas, and the picker says which copies can be reused,
  // so at most maxFrames canvases ever exist. The winners are encoded
  // together after the recording stops.
  const picker = new FramePicker({ maxFrames: request.maxFrames });
  const held = new Map<number, OffscreenCanvas>();
  const spare: OffscreenCanvas[] = [];
  const timing = { copy: 0, luma: 0, samples: 0, read: 0, maxGap: 0, maxSampleGap: 0, finish: 0 };

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  const minGapMs = 1000 / request.fps;
  const lengthMs = request.seconds * 1000;
  let frameWidth = 0;
  let frameHeight = 0;
  let startedAt = -1;
  let lastSampleAt = -Infinity;
  let durationMs = 0;

  const sample = (frame: VideoFrame, at: number): void => {
    const t0 = performance.now();
    thumbCtx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
    const rgba = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const luma = new Uint8Array(THUMB_W * THUMB_H);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    }
    const t1 = performance.now();
    const index = picker.frames.length;
    for (const released of picker.push({ at, luma })) {
      const canvas = held.get(released);
      held.delete(released);
      if (canvas) spare.push(canvas);
    }
    const canvas = spare.pop() ?? new OffscreenCanvas(frameWidth, frameHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(frame, 0, 0, frameWidth, frameHeight);
    held.set(index, canvas);
    const t2 = performance.now();
    timing.luma += t1 - t0;
    timing.copy += t2 - t1;
    timing.samples += 1;
    if (lastSampleAt > -Infinity) timing.maxSampleGap = Math.max(timing.maxSampleGap, at - lastSampleAt);
    lastSampleAt = at;
  };

  recorder.start(250);
  // A ceiling in case the track stops delivering: the clip ends on its own
  // clock below, this only guards against a frozen tab.
  const ceiling = new Promise<void>((resolve) => setTimeout(resolve, lengthMs + 4000));
  const readLoop = (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        const now = performance.now();
        if (startedAt < 0) {
          startedAt = now;
          frameWidth = frame.displayWidth;
          frameHeight = frame.displayHeight;
        }
        const at = Math.round(now - startedAt);
        timing.read += 1;
        timing.maxGap = Math.max(timing.maxGap, at - durationMs);
        durationMs = at;
        if (at >= lengthMs) {
          if (at > lastSampleAt) sample(frame, at);
          break;
        }
        if (at - lastSampleAt >= minGapMs) sample(frame, at);
      } finally {
        frame.close();
      }
    }
  })();
  await Promise.race([readLoop, ceiling]);
  recorder.stop();
  await stopped;
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  for (const t of stream.getTracks()) t.stop();
  if (picker.frames.length === 0) throw new Error('the tab delivered no frames - is it in front?');

  const finishStart = performance.now();
  const frames = picker.frames;
  const chosen = selectFrames(frames, { maxFrames: request.maxFrames });
  const chosenCanvases = chosen.map((i) => {
    const canvas = held.get(i);
    if (!canvas) throw new Error(`frame ${i} was picked but not kept - picker bug`);
    return canvas;
  });
  // Two across, each tile about half the tab's width: readable by a person,
  // and an assistant downscales anything larger anyway.
  const layout = sheetLayout(chosen.length, frameWidth, frameHeight, {
    columns: 2,
    sheetWidth: Math.min(2600, Math.max(1200, frameWidth)),
  });
  const sheet = new OffscreenCanvas(layout.width, layout.height);
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('no sheet context');
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '600 18px -apple-system, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chosen.length; i++) {
    const tile = layout.tiles[i];
    ctx.drawImage(chosenCanvases[i], tile.x, tile.y, layout.tileWidth, layout.tileHeight);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(tile.x + 0.5, tile.y + 0.5, layout.tileWidth - 1, layout.tileHeight - 1);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillText(
      `${i + 1}  ${offsetLabel(frames[chosen[i]].at)}`,
      tile.x + 2,
      tile.y + layout.tileHeight + layout.labelHeight / 2,
    );
  }
  // All encodes at once: each waits on the same slow task turn, so started
  // together they finish together instead of a second apiece.
  const [sheetBlob, ...frameBlobs] = await Promise.all([
    sheet.convertToBlob({ type: 'image/jpeg', quality: SHEET_JPEG_QUALITY }),
    ...chosenCanvases.map((canvas) => canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_JPEG_QUALITY })),
  ]);
  const videoBlob = new Blob(chunks, { type: mimeType || 'video/webm' });
  const [video, sheetBase64, ...frameBase64] = await Promise.all([
    blobToBase64(videoBlob),
    blobToBase64(sheetBlob),
    ...frameBlobs.map(blobToBase64),
  ]);
  timing.finish = performance.now() - finishStart;
  held.clear();
  spare.length = 0;

  const per = (ms: number) => (timing.samples ? (ms / timing.samples).toFixed(0) : '0');
  return {
    ok: true,
    video,
    videoMime: 'video/webm',
    sheet: sheetBase64,
    sheetWidth: layout.width,
    sheetHeight: layout.height,
    frameWidth,
    frameHeight,
    frameOffsetsMs: chosen.map((i) => frames[i].at),
    frames: frameBase64,
    sampledFrames: frames.length,
    durationMs,
    debug: `${timing.read} frames read, ${timing.samples} sampled; per sample luma ${per(timing.luma)} ms, copy ${per(timing.copy)} ms; longest gap between samples ${timing.maxSampleGap} ms, between frames ${timing.maxGap} ms; encoding after stop ${timing.finish.toFixed(0)} ms`,
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
