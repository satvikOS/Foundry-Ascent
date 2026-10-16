import type { Me, TurnView } from '@foundry/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { SessionDetail } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';
import { browserCallDeps } from '@/lib/realtime/browser';
import { CallEngine, type CallSnapshot } from '@/lib/realtime/call-engine';

import { CallScreen } from './call-screen';

/**
 * The call lives in the app shell, not in a page: one CallEngine for the signed-in person, so a call keeps
 * going while they move between conversations and venture pages. The call screen opens on `?call=1` of a
 * venture's New chat (a new conversation) or of a conversation (this conversation); without it, a live
 * call shows as the mini call bar.
 */

export interface CallRoute {
  readonly ventureId: string;
  /** Null on New chat: the call creates its conversation first. */
  readonly sessionId: string | null;
  /** `?call=1`: the call screen is open. */
  readonly open: boolean;
}

/** Reads the call screen's place from the URL (`/<tenant>/app/v/<venture>[/c/<session>][?call=1]`). */
export function callRouteFrom(pathname: string, search: unknown, tenant: string): CallRoute | null {
  const prefix = `/${tenant}/app/v/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split('/').filter(Boolean);
  const [ventureId, section, sessionId] = parts;
  if (!ventureId) return null;
  const isNewChat = parts.length === 1;
  const isConversation = parts.length === 3 && section === 'c' && Boolean(sessionId);
  if (!isNewChat && !isConversation) return { ventureId, sessionId: null, open: false };
  const value = (search as { call?: unknown } | null)?.call;
  return {
    ventureId,
    sessionId: isConversation ? (sessionId ?? null) : null,
    open: value === 1 || value === '1' || value === true,
  };
}

interface CallContextValue {
  readonly me: Me;
  readonly engine: CallEngine;
  readonly snapshot: CallSnapshot;
  readonly route: CallRoute | null;
  /** Opens the call screen of the live (or just ended) call. */
  readonly showCall: () => void;
  /** Closes the call screen; a live call continues in the mini bar. */
  readonly hideCall: (options?: { replace?: boolean }) => void;
  /** Ends the call and returns to the conversation without the summary. */
  readonly switchToChat: () => void;
  /** True while a call ends without its summary (Switch to chat), so the mini bar stays out of the way. */
  readonly quietEnd: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) throw new Error('useCall must be used inside <CallProvider>');
  return value;
}

export function CallProvider({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search });
  const route = useMemo(() => callRouteFrom(pathname, search, tenant), [pathname, search, tenant]);
  const [quietEnd, setQuietEnd] = useState(false);

  const [engine] = useState(
    () =>
      new CallEngine(
        browserCallDeps((sessionId: string, turn: TurnView | null) => {
          if (turn) {
            queryClient.setQueryData<SessionDetail>(queryKeys.session.detail(sessionId), (previous) =>
              previous
                ? {
                    session: {
                      ...previous.session,
                      turnCount: Math.max(previous.session.turnCount, turn.ordinal),
                    },
                    turns: [...previous.turns.filter((t) => t.id !== turn.id), turn].sort(
                      (a, b) => a.ordinal - b.ordinal,
                    ),
                  }
                : previous,
            );
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) });
          const ventureId = engine.getSnapshot().ventureId;
          if (ventureId) void queryClient.invalidateQueries({ queryKey: queryKeys.venture.scope(ventureId) });
        }),
      ),
  );
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  // The microphone is released and the server call ended when the tab closes or the shell unmounts
  // (signing out, leaving the app).
  useEffect(() => {
    const onPageHide = () => {
      engine.dispose();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      engine.dispose();
    };
  }, [engine]);

  const showCall = useCallback(() => {
    const { ventureId, sessionId } = engine.getSnapshot();
    if (!ventureId || !sessionId) return;
    void navigate({
      to: '/$tenant/app/v/$ventureId/c/$sessionId',
      params: { tenant, ventureId, sessionId },
      search: { call: 1 },
    });
  }, [engine, navigate, tenant]);

  const hideCall = useCallback(
    (options: { replace?: boolean } = {}) => {
      const current = engine.getSnapshot();
      const ventureId = current.ventureId ?? route?.ventureId;
      const sessionId = current.sessionId ?? route?.sessionId ?? null;
      if (!ventureId) return;
      if (sessionId) {
        void navigate({
          to: '/$tenant/app/v/$ventureId/c/$sessionId',
          params: { tenant, ventureId, sessionId },
          search: {},
          replace: options.replace,
        });
      } else {
        void navigate({
          to: '/$tenant/app/v/$ventureId',
          params: { tenant, ventureId },
          search: {},
          replace: options.replace,
        });
      }
    },
    [engine, navigate, route, tenant],
  );

  const switchToChat = useCallback(() => {
    setQuietEnd(true);
    hideCall();
    void engine.end('user').finally(() => {
      engine.reset();
      setQuietEnd(false);
    });
  }, [engine, hideCall]);

  const value = useMemo<CallContextValue>(
    () => ({ me, engine, snapshot, route, showCall, hideCall, switchToChat, quietEnd }),
    [me, engine, snapshot, route, showCall, hideCall, switchToChat, quietEnd],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallScreen />
    </CallContext.Provider>
  );
}
