import { createContext, useContext } from 'react';

export interface AppShellContextValue {
  openCommandPalette: () => void;
  openShortcuts: () => void;
  toggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

/** Shell controls for pages (e.g. a "Search" empty-state action that opens the palette). */
export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext);
  if (!ctx) throw new Error('useAppShell must be used inside <AppShell>.');
  return ctx;
}
