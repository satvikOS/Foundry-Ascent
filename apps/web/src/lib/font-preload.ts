import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

import { waitsForDisplayFaces } from '@/lib/display-faces';

/*
 * The platform's one face (Inter, Latin: styles/inter.css) is preloaded as the app starts, on every page but the
 * landing page. The landing page is set in its own faces (Newsreader, Geist) and its first render waits for its
 * display face (lib/display-faces.ts): a preload of Inter there competed with Newsreader for bandwidth, so on a
 * slow network the hero was drawn in its stand-in and re-wrapped when Newsreader arrived (CLS 0.001 -> 0.075).
 * Not a tag in index.html: one page differs, and the CSP forbids an inline script that could tell them apart.
 */

/** The emitted URL of Inter's Latin file (the same file styles/inter.css draws). */
export const PLATFORM_FONT_URL: string = interLatin;

/** Whether `pathname` preloads the platform's face: every page but the landing page. */
export function preloadsPlatformFont(pathname: string): boolean {
  return !waitsForDisplayFaces(pathname);
}

/** Adds the `<link rel="preload">` for the platform's face to `doc`'s head, unless `pathname` is the landing page. */
export function preloadPlatformFont(pathname: string, doc: Document = document): void {
  if (!preloadsPlatformFont(pathname)) return;
  const link = doc.createElement('link');
  link.rel = 'preload';
  link.as = 'font';
  link.type = 'font/woff2';
  // Fonts are fetched in CORS mode: the preload must be too, or the browser fetches the file twice.
  link.crossOrigin = 'anonymous';
  link.href = PLATFORM_FONT_URL;
  doc.head.append(link);
}
