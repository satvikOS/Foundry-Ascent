/*
 * Saving a recording's file without leaving the page (ADR-0023 §4). Its presigned GET is at the recordings store's
 * origin, where a link's `download` attribute is ignored: followed as a link, it would start a navigation of the page
 * itself until the answer (an attachment) says otherwise, and in Firefox and Safari starting one breaks what the page
 * has open (a take's upload, the call's streamed replies, its Transcribe socket). A hidden frame loads it instead: the
 * browser saves the attachment from there, and the page is never navigated, so it is not asked about leaving either.
 */

/** How long the frame stays: long past the store's answer, after which the download is the browser's own. */
const FRAME_LIFETIME_MS = 60_000;

/** Saves the file at `url` (a presigned GET answered as an attachment) from a hidden frame. */
export function saveDownload(url: string): void {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  // It may only download: an error page from the store (a link that expired) runs nothing.
  frame.setAttribute('sandbox', 'allow-downloads');
  frame.src = url;
  document.body.append(frame);
  window.setTimeout(() => {
    frame.remove();
  }, FRAME_LIFETIME_MS);
}
