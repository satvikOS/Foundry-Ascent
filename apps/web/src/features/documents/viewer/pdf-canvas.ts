/* How densely a PDF page's canvas is drawn. */

/**
 * Most pixels one page's canvas holds (16.8 MP, 64 MB): iOS's canvas limit, and a bound on memory at high
 * zoom on a sharp screen (a page at 400% on a 2x display would otherwise be 60–100 MP). Past it the page is
 * drawn at a lower density and the browser stretches it to its size.
 */
export const MAX_CANVAS_PIXELS = 2 ** 24;

/**
 * The density to draw a page at: the screen's (at most 2x), lowered so the canvas stays within
 * {@link MAX_CANVAS_PIXELS}.
 */
export function drawingRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const area = cssWidth * cssHeight;
  if (area <= 0 || area * ratio * ratio <= MAX_CANVAS_PIXELS) return ratio;
  return Math.sqrt(MAX_CANVAS_PIXELS / area);
}
