import { useSyncExternalStore } from 'react';

import { safeStorage, STORAGE_KEYS } from './storage';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const THEME_COLORS: Record<ResolvedTheme, string> = { dark: '#0B0B0B', light: '#FAFAF9' };
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function readPreference(): ThemePreference {
  const stored = safeStorage.get(STORAGE_KEYS.theme);
  return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

let state: ThemeState = { preference: 'system', resolved: 'dark' };
const listeners = new Set<() => void>();
let initialised = false;

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

function apply(next: ThemeState): void {
  state = next;
  const root = document.documentElement;
  root.classList.toggle('dark', next.resolved === 'dark');
  root.classList.toggle('light', next.resolved === 'light');
  root.dataset.theme = next.resolved;
  // With an explicit choice both theme-color metas carry the chosen colour; "system" restores them.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute('media') ?? '';
    const forScheme: ResolvedTheme = media.includes('light') ? 'light' : 'dark';
    meta.content = THEME_COLORS[next.preference === 'system' ? forScheme : next.resolved];
  }
  for (const listener of listeners) listener();
}

/**
 * Apply the stored theme before React renders (called from main.tsx). CSS already follows the OS
 * via `color-scheme`, so this only matters when the person picked an explicit theme.
 */
export function initTheme(): void {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  const preference = readPreference();
  apply({ preference, resolved: resolve(preference) });
  try {
    window.matchMedia(LIGHT_QUERY).addEventListener('change', () => {
      if (state.preference === 'system') apply({ preference: 'system', resolved: systemTheme() });
    });
  } catch {
    /* matchMedia unavailable */
  }
  // Keep tabs in sync.
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.theme) {
      const preference = readPreference();
      apply({ preference, resolved: resolve(preference) });
    }
  });
}

export function setTheme(preference: ThemePreference): void {
  safeStorage.set(STORAGE_KEYS.theme, preference);
  apply({ preference, resolved: resolve(preference) });
}

/** Cycle dark → light → system (used by the command palette and the toggle shortcut). */
export function cycleTheme(): ThemePreference {
  const order: ThemePreference[] = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(state.preference) + 1) % order.length] ?? 'system';
  setTheme(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): ThemeState => state;

export function useTheme(): ThemeState & { setTheme: typeof setTheme } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, setTheme };
}
