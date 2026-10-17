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
  changeBox,
  offsetLabel,
  selectFrames,
  sheetLayout,
  sheetPlan,
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

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  // The clip ends on its own clock, not on the next frame: a tab that sits
  // still sends a frame about once a second, which let a 5 s clip run to
  // 5.5 s. Timers are throttled in this hidden document, so the clock is
  // checked from every source that ticks - a short interval, the
  // recorder's data events and each frame - and the first to see the
  // deadline ends the clip.
  let reachDeadline: () => void = () => {};
  const deadline = new Promise<'deadline'>((resolve) => {
    reachDeadline = () => resolve('deadline');
  });
  const checkDeadline = (): void => {
    if (startedAt >= 0 && performance.now() - startedAt >= lengthMs) reachDeadline();
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
    checkDeadline();
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
    thumbCtx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
    const rgba = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const luma = new Uint8Array(THUMB_W * THUMB_H);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    }
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
    lastSampleAt = at;
  };

  recorder.start(250);
  const tick = setInterval(checkDeadline, 50);
  // A ceiling in case the track never delivers a first frame: the clip ends
  // on its own clock below, this only guards against a frozen tab.
  const ceiling = new Promise<void>((resolve) => setTimeout(resolve, lengthMs + 4000));
  let pendingRead: Promise<ReadableStreamReadResult<VideoFrame>> | null = null;
  const readLoop = (async () => {
    for (;;) {
      pendingRead = reader.read();
      const next = await Promise.race([pendingRead, deadline]);
      if (next === 'deadline') {
        durationMs = Math.round(performance.now() - startedAt);
        break;
      }
      pendingRead = null;
      const { value: frame, done } = next;
      if (done || !frame) break;
      try {
        const now = performance.now();
        if (startedAt < 0) {
          startedAt = now;
          frameWidth = frame.displayWidth;
          frameHeight = frame.displayHeight;
        }
        const at = Math.round(now - startedAt);
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
  clearInterval(tick);
  recorder.stop();
  await stopped;
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  // A read left waiting when the deadline won may still hand over a frame.
  void (pendingRead as Promise<ReadableStreamReadResult<VideoFrame>> | null)?.then(
    (result) => result.value?.close(),
    () => undefined,
  );
  for (const t of stream.getTracks()) t.stop();
  if (picker.frames.length === 0) throw new Error('the tab delivered no frames - is it in front?');

  const frames = picker.frames;
  const chosen = selectFrames(frames, { maxFrames: request.maxFrames });
  const chosenCanvases = chosen.map((i) => {
    const canvas = held.get(i);
    if (!canvas) throw new Error(`frame ${i} was picked but not kept - picker bug`);
    return canvas;
  });
  // When only part of the page moved, the sheet shows just that part at its
  // real size (NOBC-159): an assistant shrinks a whole-page sheet to about a
  // fifth, which loses text and fine detail. The full-size frames keep the
  // whole tab either way.
  const crop = changeBox(frames, frameWidth, frameHeight);
  const src = crop ?? { x: 0, y: 0, width: frameWidth, height: frameHeight };
  const plan = crop ? sheetPlan(src.width, chosen.length) : { columns: 2, sheetWidth: Math.min(2600, Math.max(1200, frameWidth)) };
  const layout = sheetLayout(chosen.length, src.width, src.height, plan);
  const sheet = new OffscreenCanvas(layout.width, layout.height);
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('no sheet context');
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '600 18px -apple-system, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chosen.length; i++) {
    const tile = layout.tiles[i];
    ctx.drawImage(chosenCanvases[i], src.x, src.y, src.width, src.height, tile.x, tile.y, layout.tileWidth, layout.tileHeight);
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
  held.clear();
  spare.length = 0;

  return {
    ok: true,
    video,
    videoMime: 'video/webm',
    sheet: sheetBase64,
    sheetWidth: layout.width,
    sheetHeight: layout.height,
    frameWidth,
    frameHeight,
    ...(crop ? { crop } : {}),
    frameOffsetsMs: chosen.map((i) => frames[i].at),
    frames: frameBase64,
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
