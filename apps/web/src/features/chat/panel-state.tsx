import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useInspector } from '@/components/shell/inspector';

/** The conversation's right panel: Sources · Notebook · To review · Human help. */
export type PanelTab = 'sources' | 'notebook' | 'review' | 'help';

interface FocusedSource {
  turnId: string;
  key: string | null;
  /** Changes on every request so the same chip can be "opened" twice. */
  nonce: number;
}

interface PanelState {
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
  /** Answer whose sources the panel shows (null → the latest answer). */
  selectedTurnId: string | null;
  focused: FocusedSource | null;
  /** Open the panel on an answer's sources, optionally focusing one key (e.g. "E2"). */
  showSources: (turnId: string, key?: string | null) => void;
  /** Open the panel on a tab. */
  showTab: (tab: PanelTab) => void;
}

const PanelContext = createContext<PanelState | null>(null);

/** Shared between the transcript and the right panel (a citation chip opens Sources on that source). */
export function PanelStateProvider({ children }: { children: ReactNode }) {
  const { setOpen } = useInspector();
  const [tab, setTab] = useState<PanelTab>('sources');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [focused, setFocused] = useState<FocusedSource | null>(null);

  const showSources = useCallback(
    (turnId: string, key: string | null = null) => {
      setTab('sources');
      setSelectedTurnId(turnId);
      setFocused((prev) => ({ turnId, key, nonce: (prev?.nonce ?? 0) + 1 }));
      setOpen(true);
    },
    [setOpen],
  );

  const showTab = useCallback(
    (next: PanelTab) => {
      setTab(next);
      setOpen(true);
    },
    [setOpen],
  );

  const value = useMemo(
    () => ({ tab, setTab, selectedTurnId, focused, showSources, showTab }),
    [tab, selectedTurnId, focused, showSources, showTab],
  );
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanelState(): PanelState {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error('usePanelState must be used inside <PanelStateProvider>.');
  return ctx;
}
