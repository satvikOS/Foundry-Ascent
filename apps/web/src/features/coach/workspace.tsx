import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useInspector } from '@/components/shell/inspector';

export type SessionInspectorTab = 'evidence' | 'facts' | 'proposed' | 'handoff';

interface FocusedEvidence {
  turnId: string;
  key: string | null;
  /** Changes on every request so the same chip can be "opened" twice. */
  nonce: number;
}

interface CoachWorkspaceValue {
  tab: SessionInspectorTab;
  setTab: (tab: SessionInspectorTab) => void;
  /** Turn whose evidence the inspector shows (null → the latest completed turn). */
  selectedTurnId: string | null;
  focused: FocusedEvidence | null;
  /** Open the inspector on a turn's evidence, optionally highlighting one key (e.g. "E2"). */
  showEvidence: (turnId: string, key?: string | null) => void;
  /** Open the inspector on a given tab. */
  showTab: (tab: SessionInspectorTab) => void;
}

const CoachWorkspaceContext = createContext<CoachWorkspaceValue | null>(null);

/** Shared state between the session transcript and its inspector (evidence chips → Evidence tab). */
export function CoachWorkspaceProvider({ children }: { children: ReactNode }) {
  const { setOpen } = useInspector();
  const [tab, setTab] = useState<SessionInspectorTab>('evidence');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [focused, setFocused] = useState<FocusedEvidence | null>(null);

  const showEvidence = useCallback(
    (turnId: string, key: string | null = null) => {
      setTab('evidence');
      setSelectedTurnId(turnId);
      setFocused((prev) => ({ turnId, key, nonce: (prev?.nonce ?? 0) + 1 }));
      setOpen(true);
    },
    [setOpen],
  );

  const showTab = useCallback(
    (next: SessionInspectorTab) => {
      setTab(next);
      setOpen(true);
    },
    [setOpen],
  );

  const value = useMemo(
    () => ({ tab, setTab, selectedTurnId, focused, showEvidence, showTab }),
    [tab, selectedTurnId, focused, showEvidence, showTab],
  );
  return <CoachWorkspaceContext.Provider value={value}>{children}</CoachWorkspaceContext.Provider>;
}

export function useCoachWorkspace(): CoachWorkspaceValue {
  const ctx = useContext(CoachWorkspaceContext);
  if (!ctx) throw new Error('useCoachWorkspace must be used inside <CoachWorkspaceProvider>.');
  return ctx;
}
