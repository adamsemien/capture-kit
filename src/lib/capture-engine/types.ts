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

export interface CaptureRequest {
  tabId: number;
  /** Max px per segment dimension; pages larger per axis are captured in segments. */
  segmentSize: number;
  format: CaptureFormat;
}

export interface CaptureResult {
  imageBase64: string;
  format: CaptureFormat;
  mode: CaptureMode;
  /** Actual captured size after canvas-limit clamping. */
  fullSize: PageDimensions;
  /** Content size the page reported (may exceed fullSize when truncated). */
  contentSize: PageDimensions;
  truncated: boolean;
  segments: number;
  /** Elements still computed-hidden after the reveal scroll pass that were force-revealed. */
  revealForced: number;
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
