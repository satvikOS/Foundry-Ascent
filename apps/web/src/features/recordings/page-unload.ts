/*
 * Leaving the page while a take exists only in it (ADR-0023 §2). A recording's download never leaves the page (it is
 * saved through a hidden frame: save-download.ts), so it never meets this guard.
 */

/**
 * The browser asks before the page is closed, reloaded or left for another site (a take held only in this page would
 * be lost). Moving between the app's own pages keeps it, and needs no prompt.
 */
export function guardPageUnload(): () => void {
  const ask = (event: BeforeUnloadEvent) => {
    event.preventDefault();
  };
  window.addEventListener('beforeunload', ask);
  return () => {
    window.removeEventListener('beforeunload', ask);
  };
}
