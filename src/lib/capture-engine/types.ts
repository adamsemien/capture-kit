export interface PageDimensions {
  width: number;
  height: number;
}

export interface CaptureRequest {
  tabId: number;
  /** Max px per segment dimension; pages larger per axis are captured in segments. */
  segmentSize: number;
}

export interface CaptureResult {
  pngBase64: string;
  /** Actual captured size after canvas-limit clamping. */
  fullSize: PageDimensions;
  /** Content size the page reported (may exceed fullSize when truncated). */
  contentSize: PageDimensions;
  truncated: boolean;
  segments: number;
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
