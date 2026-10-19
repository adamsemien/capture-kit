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
  /**
   * Also cut a tall capture into screen-sized slices an assistant can read
   * (NOBC-161). Only the report path asks; a plain screenshot does not pay for it.
   */
  slices?: boolean;
}

/** One full-resolution piece of a tall capture, in image pixels from the top. */
export interface CaptureSlice {
  imageBase64: string;
  top: number;
  height: number;
  /** Width of the slice as written - narrower than the page when its empty side margins were trimmed. */
  width: number;
  /** Columns trimmed off the left, in page pixels; 0 when untrimmed. */
  left: number;
}

export interface CaptureResult {
  imageBase64: string;
  format: CaptureFormat;
  mode: CaptureMode;
  /** Actual captured PAGE size after canvas-limit clamping. Excludes any footer. */
  fullSize: PageDimensions;
  /**
   * Content size of the layout the image depicts (may exceed fullSize when
   * truncated). On the segmented path this is measured under the virtual
   * viewport, so it can differ from what the page measures in the real one.
   */
  contentSize: PageDimensions;
  /**
   * Size measured at the tab's real viewport, before any virtual-viewport
   * override. Set only when it differs from contentSize — i.e. when the page
   * re-laid out for the capture, which a reader comparing the image against
   * their own browser needs told.
   */
  naturalSize?: PageDimensions;
  /**
   * The tab's browser page zoom when the capture started. Captures are always
   * taken at 100%, so anything other than 1 means the image is not the zoom
   * level the user was looking at — which the report says out loud.
   */
  browserZoom?: number;
  /**
   * Dimensions of the encoded file as written to disk — `fullSize` plus the
   * footer when one was appended. Everything that reports "the image is N×M"
   * reads this; `fullSize` keeps meaning page geometry so the truncation
   * arithmetic in buildContentsLine stays honest.
   */
  imageSize: PageDimensions;
  truncated: boolean;
  segments: number;
  /** Inner scrollers unrolled for this capture (expanded-inner-scroll mode only). */
  innerScrollers?: number;
  /**
   * True when inner-scroll expansion was undone because it would have hidden
   * the page's content; the capture is then of the page as it looks on screen.
   */
  innerScrollAbandoned?: boolean;
  /** Absolutely positioned panels brought into the flow for the expansion. */
  panelsReflowed?: number;
  /**
   * Embedded frames kept at their on-screen height while the columns around
   * them unrolled. Their own content is not unrolled, and the report says so.
   */
  framesHeld?: number;
  /** Elements still computed-hidden after the reveal scroll pass that were force-revealed. */
  revealForced: number;
  /**
   * Elements whose viewport-unit lengths the segmented path's virtual viewport
   * would have resized, held at their real-viewport values instead. Absent or
   * 0 on single-shot, where no viewport override happens.
   */
  heightHeld?: number;
  /** Present only when the URL footer was composited onto this image. */
  stamp?: StampInfo;
  /**
   * Below 1 when the page was past Chrome's single-image limits and the
   * whole-page image was scaled down to fit rather than cut off. `fullSize`
   * stays the page's real size; `imageSize` is the scaled file.
   */
  scale?: number;
  /**
   * Full-resolution slices of a tall page, top to bottom, when the request
   * asked for them and the page is more than about two screens tall.
   */
  slices?: CaptureSlice[];
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
