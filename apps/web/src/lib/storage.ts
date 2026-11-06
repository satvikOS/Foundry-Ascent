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
  sessionHint: 'fa.session-hint',
  /** Timestamp of the last access-code notice the person dismissed. */
  accessCodeNoticeDismissed: 'fa.notice.access-code',
  /** The venture opened last (an id only), so the app opens there next time. */
  lastVenture: 'fa.last-venture',
  /** Right-hand panel left open on desktop ("1") or closed (default). */
  inspectorOpen: 'fa.inspector.open',
  /** The venture context panel (New chat and conversations) open ("1", the default) or closed ("0") on desktop. */
  contextPanelOpen: 'fa.context-panel.open',
  /** Device class for costly effects ("low" swaps glass for solid surfaces): lib/perf.ts. */
  perf: 'fa.perf',
  /**
   * The welcome New chat put over the vEIR's last line without a greeting of its own, and a hash of that line (never
   * its words): the next line gets another welcome (features/chat/greeting.ts).
   */
  newChatWelcome: 'fa.new-chat.welcome',
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
