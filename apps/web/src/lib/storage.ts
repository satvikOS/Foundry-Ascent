/**
 * localStorage access that never throws (private mode, disabled storage, quota, sandboxed iframes).
 * Only non-sensitive UI preferences are stored here — never tokens, prompts or venture content.
 */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: preference lasts for this page view only */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const STORAGE_KEYS = {
  theme: 'fa.theme',
  sidebarCollapsed: 'fa.sidebar.collapsed',
  venturesView: 'fa.ventures.view',
  sessionHint: 'fa.session-hint',
  /** Timestamp of the last access-code notice the person dismissed. */
  accessCodeNoticeDismissed: 'fa.notice.access-code',
} as const;

/**
 * Non-sensitive hint that this browser probably has a session (the fa_session cookie is HttpOnly and
 * scoped to /api, so it cannot be read). Public pages only call GET /me when the hint is set, which
 * keeps anonymous visits from waking the auto-paused database.
 */
export const sessionHint = {
  get: (): boolean => safeStorage.get(STORAGE_KEYS.sessionHint) === '1',
  set: (present: boolean): void => {
    if (present) safeStorage.set(STORAGE_KEYS.sessionHint, '1');
    else safeStorage.remove(STORAGE_KEYS.sessionHint);
  },
};
