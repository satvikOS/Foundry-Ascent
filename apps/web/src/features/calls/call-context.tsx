import type { Me } from '@foundry/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { CallEngine } from '@/lib/realtime/call-engine';
import { IDLE_CALL, type CallSnapshot } from '@/lib/realtime/call-state';

import type { CallFaceController } from './use-call-face';

/**
 * The engine, the call screen and the mini bar load on demand: most visits never open them. They are
 * warmed once the app is idle, so the first Call opens at once.
 */
const loadEngine = () => import('./create-engine');
const loadCallScreen = () => import('./call-screen');
const loadMiniBar = () => import('./mini-call-bar-view');
const CallScreen = lazy(() => loadCallScreen().then((module) => ({ default: module.CallScreen })));
const WARM_AFTER_MS = 3000;

const noSubscription = () => () => undefined;
const idleSnapshot = () => IDLE_CALL;

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
  /** Null until the engine has loaded (it loads when the call screen first opens, or when idle). */
  readonly engine: CallEngine | null;
  /** The face of the engine's calls (a vendor's video while one is live); null until the engine has loaded. */
  readonly face: CallFaceController | null;
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
  /**
   * The page was reached by the browser's Back or Forward (or `history.go`), not by a navigation the app
   * made: a `?call=1` reached this way never starts a call by itself.
   */
  readonly arrivedByHistory: () => boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) throw new Error('useCall must be used inside <CallProvider>');
  return value;
}

/** For the call screen, which renders only once the engine has loaded. */
export function useLoadedCall(): CallContextValue & { readonly engine: CallEngine } {
  const value = useCall();
  const { engine } = value;
  if (!engine) throw new Error('The call engine has not loaded');
  return { ...value, engine };
}

/** How long signing out waits for the live call to end on the server before it goes ahead anyway. */
const SIGN_OUT_END_WAIT_MS = 4000;

/**
 * Ends the person's live call before they sign out, and waits for the server (a few seconds at most): ending
 * it needs the session that signing out revokes, so an end sent while the page unmounts afterwards would be
 * refused and the call would run on until it went stale. Outside a CallProvider there is no call to end.
 */
export function useEndCallBeforeSignOut(): () => Promise<void> {
  const engine = useContext(CallContext)?.engine ?? null;
  return useCallback(async () => {
    if (!engine) return;
    const { phase } = engine.getSnapshot();
    if (phase !== 'live' && phase !== 'starting') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      engine.end('user').catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIGN_OUT_END_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }, [engine]);
}

export function CallProvider({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const tenant = me.tenant.slug;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search });
  const route = useMemo(() => callRouteFrom(pathname, search, tenant), [pathname, search, tenant]);
  const [quietEnd, setQuietEnd] = useState(false);

  // Which navigation brought the page here: a call starts only from the founder's action, never because
  // Back or Forward returned to a `?call=1` entry (that would open the microphone and a call unasked).
  const traversedTo = useRef<string | null>(null);
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (action.type === 'BACK' || action.type === 'FORWARD' || action.type === 'GO') {
          traversedTo.current = location.href;
        } else if (action.type === 'PUSH' || traversedTo.current !== location.href) {
          // A navigation the app made; a replace of the same URL (the router tidying it) keeps the visit.
          traversedTo.current = null;
        }
      }),
    [router],
  );
  const arrivedByHistory = useCallback(() => traversedTo.current !== null, []);

  const [engine, setEngine] = useState<CallEngine | null>(null);
  const [face, setFace] = useState<CallFaceController | null>(null);
  const engineRequested = useRef(false);
  const ensureEngine = useCallback(() => {
    if (engineRequested.current) return;
    engineRequested.current = true;
    loadEngine()
      .then(({ createCallEngine, createCallFace }) => {
        const created = createCallEngine(queryClient);
        setFace(createCallFace(created));
        setEngine(created);
      })
      .catch(() => {
        // Offline or a stale deployment: the next Call tries again.
        engineRequested.current = false;
      });
  }, [queryClient]);
  const open = route?.open === true;
  useEffect(() => {
    if (open) ensureEngine();
  }, [ensureEngine, open]);
  useEffect(() => {
    const timer = setTimeout(() => {
      ensureEngine();
      void loadCallScreen().catch(() => undefined);
      void loadMiniBar().catch(() => undefined);
    }, WARM_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ensureEngine]);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? noSubscription,
    engine?.getSnapshot ?? idleSnapshot,
    engine?.getSnapshot ?? idleSnapshot,
  );

  // The microphone is released and the server call ended when the tab closes or the shell unmounts
  // (signing out, leaving the app).
  useEffect(() => {
    if (!engine) return undefined;
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
    const { ventureId, sessionId } = engine?.getSnapshot() ?? IDLE_CALL;
    if (!ventureId || !sessionId) return;
    void navigate({
      to: '/$tenant/app/v/$ventureId/c/$sessionId',
      params: { tenant, ventureId, sessionId },
      search: { call: 1 },
    });
  }, [engine, navigate, tenant]);

  const hideCall = useCallback(
    (options: { replace?: boolean } = {}) => {
      const current = engine?.getSnapshot() ?? IDLE_CALL;
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
    hideCall();
    if (!engine) return;
    setQuietEnd(true);
    void engine.end('user').finally(() => {
      engine.reset();
      setQuietEnd(false);
    });
  }, [engine, hideCall]);

  const value = useMemo<CallContextValue>(
    () => ({
      me,
      engine,
      face,
      snapshot,
      route,
      showCall,
      hideCall,
      switchToChat,
      quietEnd,
      arrivedByHistory,
    }),
    [me, engine, face, snapshot, route, showCall, hideCall, switchToChat, quietEnd, arrivedByHistory],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {engine && (open || snapshot.phase !== 'idle') ? (
        <Suspense fallback={null}>
          <CallScreen />
        </Suspense>
      ) : null}
    </CallContext.Provider>
  );
}
