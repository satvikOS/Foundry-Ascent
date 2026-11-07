/*
 * Leaving the page while a take exists only in it (ADR-0023 §2), and the one navigation that never leaves it: a
 * recording's download. A download's presigned GET is at the recordings store's origin, where a link's `download`
 * attribute is ignored, so the browser treats following it as leaving the page until the answer (an attachment) says
 * otherwise; without care that would ask whether to leave, and Cancel would stop the download.
 */

/** How long after following a download link a leave-the-page event is taken to be that link's own. */
const DOWNLOAD_GRACE_MS = 1_000;

/** Set while the app follows a download link it made itself. */
let downloading = false;

/**
 * The browser asks before the page is closed, reloaded or left for another site (a take held only in this page would
 * be lost). Moving between the app's own pages keeps it, and needs no prompt; nor does a download ({@link
 * followDownload}).
 */
export function guardPageUnload(): () => void {
  const ask = (event: BeforeUnloadEvent) => {
    if (!downloading) event.preventDefault();
  };
  window.addEventListener('beforeunload', ask);
  return () => {
    window.removeEventListener('beforeunload', ask);
  };
}

/**
 * Saves the file at `url` (a presigned GET answered as an attachment) by following it as a link: the page stays where
 * it is, and is not asked about leaving.
 */
export function followDownload(url: string): void {
  downloading = true;
  window.setTimeout(() => {
    downloading = false;
  }, DOWNLOAD_GRACE_MS);
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.click();
}
