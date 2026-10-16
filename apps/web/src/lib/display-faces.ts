/**
 * The landing page's hero heading is set large in Newsreader (roman, with one italic word). Drawn first in a
 * stand-in face and redrawn when Newsreader arrived, it re-wrapped from six lines to five and moved everything
 * under it (cumulative layout shift 0.16-0.18; the metric-matched stand-ins in globals.css bring the widths
 * within about 1%, which is not enough at that size). So on the landing page only, the first render waits for
 * those two faces: their download starts here, in parallel with nothing else the page needs, and the wait is
 * capped, so a slow network still gets the page promptly (in the stand-in) instead of a blank screen. Every
 * other page renders at once; the faces are cached by the time anyone signs in.
 */

/** The faces the landing hero is drawn with (the size only selects the face; the text is its own). */
export const LANDING_DISPLAY_FACES = [
  '400 80px "Newsreader Variable"',
  'italic 400 80px "Newsreader Variable"',
] as const;

/** Longest the landing page's first render waits for its display faces. */
export const LANDING_FONT_WAIT_MS = 700;

/** Whether `pathname` is the landing page (the only page whose first render waits for its faces). */
export function waitsForDisplayFaces(pathname: string): boolean {
  return pathname === '/' || pathname === '';
}

/**
 * Resolves once the landing page's display faces are ready, or after `capMs`, whichever is first; at once on
 * any other page or where the Font Loading API is missing. Never rejects (a failed font load just renders).
 */
export function displayFacesReady(
  pathname: string,
  fonts: Pick<FontFaceSet, 'load'> | undefined = typeof document === 'undefined' ? undefined : document.fonts,
  capMs: number = LANDING_FONT_WAIT_MS,
): Promise<void> {
  if (!waitsForDisplayFaces(pathname) || fonts === undefined) return Promise.resolve();
  const loaded = Promise.all(LANDING_DISPLAY_FACES.map((face) => fonts.load(face, 'A remembers'))).then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  return Promise.race([loaded, capped]).finally(() => {
    clearTimeout(timer);
  });
}
