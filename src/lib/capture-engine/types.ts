export interface PageDimensions {
  width: number;
  height: number;
}

export type CaptureFormat = 'png' | 'jpeg';

/** Which pipeline produced the image — logged into the bundle markdown. */
export type CaptureMode = 'standard' | 'expanded-inner-scroll';

/** CDP quality is 0–100; canvas encoding divides by 100. */
export const JPEG_QUALITY = 85;

/**
 * Max render-surface dimension (in DEVICE pixels) a captureBeyondViewport
 * single-shot can safely allocate. Beyond this the GPU silently hands back an
 * all-black texture on common hardware. The single-shot gate divides this by
 * devicePixelRatio, since the surface is allocated at DPR even though
 * clip.scale: 1 pins the encoded output to CSS pixels.
 */
export const SINGLE_SHOT_SURFACE_LIMIT = 16384;

/** What the optional URL footer needs to know. Absent = no footer, no codepath. */
export interface StampRequest {
  url: string;
  capturedAt: Date;
}

/** How the footer ended up on the image, and how tall it is. */
export interface StampInfo {
  /**
   * `extended` grew the canvas by `height` px; `overlaid` drew over the
   * bottom `height` px because growing would have breached Chrome's canvas
   * limits. A reader has to be able to tell which, since one of them covers
   * page content.
   */
  mode: 'extended' | 'overlaid';
  height: number;
}

/** Reported per segment while a segmented capture runs; drives the badge counter. */
export type CaptureProgress = (done: number, total: number) => void;

export interface CaptureRequest {
  tabId: number;
  /** Max px per segment dimension; pages larger per axis are captured in segments. */
  segmentSize: number;
  format: CaptureFormat;
  /**
   * Present only when "Stamp URL on image" is on. The footer is composited
   * after the capture has fully completed and the debugger has detached — it
   * can never reach the live page or a mid-scroll segment.
   */
  stamp?: StampRequest;
  /** Optional in-flight progress for long segmented captures. */
  onProgress?: CaptureProgress;
}

export interface CaptureResult {
  imageBase64: string;
  format: CaptureFormat;
  mode: CaptureMode;
  /** Actual captured PAGE size after canvas-limit clamping. Excludes any footer. */
  fullSize: PageDimensions;
  /** Content size the page reported (may exceed fullSize when truncated). */
  contentSize: PageDimensions;
  /**
   * Dimensions of the encoded file as written to disk — `fullSize` plus the
   * footer when one was appended. Everything that reports "the image is N×M"
   * reads this; `fullSize` keeps meaning page geometry so the truncation
   * arithmetic in buildContentsLine stays honest.
   */
  imageSize: PageDimensions;
  truncated: boolean;
  segments: number;
  /** Elements still computed-hidden after the reveal scroll pass that were force-revealed. */
  revealForced: number;
  /** Present only when the URL footer was composited onto this image. */
  stamp?: StampInfo;
}

/**
 * A capture strategy owns the whole capture of one tab. Phase 1 ships a
 * single CDP full-page strategy; Phase 2's inner-scrollable-container
 * expansion slots in as a second implementation behind this interface.
 */
export interface CaptureStrategy {
  readonly name: string;
  capture(request: CaptureRequest): Promise<CaptureResult>;
}
