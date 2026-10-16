/*
 * Where pdf.js's own data files are served from (shared by the build plugin that copies them and the
 * reader that points pdf.js at them): character maps for PDFs whose text uses predefined CMaps (Chinese,
 * Japanese, Korean), the Symbol and Dingbats fonts, and the JavaScript decoders of scanned images (CCITT
 * fax and JBIG2 for black-and-white scans, JPEG 2000). The folder carries pdf.js's version, so its files
 * can be cached for good and a new version never reads an old one.
 */

/** The folder (relative to the site's base) for a pdf.js version. */
export function pdfjsAssetDir(version: string): string {
  return `assets/pdfjs-${version}`;
}

/** pdf.js's parameters for each kind of data (each a folder URL with a trailing slash). */
export const PDFJS_DATA_FOLDERS = {
  cMapUrl: 'cmaps/',
  standardFontDataUrl: 'standard_fonts/',
  wasmUrl: 'wasm/',
} as const;
