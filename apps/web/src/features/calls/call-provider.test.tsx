import type { CallView, Me } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSignOutAndRedirect } from '@/components/shell/account-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { StartCallOptions } from '@/lib/realtime/call-engine';
import { IDLE_CALL, type CallSnapshot } from '@/lib/realtime/call-state';
import { IDS } from '@/lib/realtime/testing';

import { CallProvider } from './call-context';
import { json, stubFetch, urlOf } from './testing';

/*
 * The call's place in the app: the real CallProvider and call screen in a memory router, with a stand-in
 * engine (the engine itself is tested in lib/realtime). What starts a call, what forgets one, and what
 * happens to a live call when the founder signs out.
 */

/** A stand-in CallEngine: the store the UI reads, and spies for what the UI asks of it. */
class StandInEngine {
  snapshot: CallSnapshot;
  readonly log: string[];
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: Partial<CallSnapshot>, log: string[]) {
    this.snapshot = { ...IDLE_CALL, ...snapshot };
    this.log = log;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  set(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Records the start; the call stays where it is (the screen shows its lobby). */
  start = vi.fn((_options: StartCallOptions) => Promise.resolve());
  reset = vi.fn(() => {
    if (this.snapshot.phase === 'live' || this.snapshot.phase === 'starting') return;
    this.set(IDLE_CALL);
  });
  end = vi.fn(async () => {
    this.log.push('end');
    await Promise.resolve();
    this.log.push('ended');
    this.set({
      phase: 'ended',
      ended: {
        reason: 'user',
        durationSeconds: 12,
        turnCount: 0,
        summary: null,
        summaryError: null,
        blocked: null,
      },
    });
  });
  dispose = vi.fn(() => {
    this.log.push('dispose');
    this.set(IDLE_CALL);
  });
  hold = vi.fn();
  resume = vi.fn();
  setMuted = vi.fn();
  setTalkMode = vi.fn();
  pushToTalk = vi.fn();
  sendText = vi.fn();
  interrupt = vi.fn();
  resumeAudio = vi.fn();
  reconnectMicrophone = vi.fn(() => Promise.resolve());
  avatarState = () => 'idle';
  levels = () => ({ veir: 0, founder: 0 });
  onSpeak = () => () => undefined;
}

const engines = vi.hoisted((): { next: unknown } => ({ next: null }));
vi.mock('./create-engine', () => ({ createCallEngine: () => engines.next }));

const VENTURE = IDS.venture;
const SESSION = IDS.session;
const BASE = `/ain/app/v/${VENTURE}`;

const ME: Me = {
  principal: { id: IDS.persona, displayName: 'Maya Example', title: null, synthetic: true },
  tenant: { id: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07', slug: 'ain', name: 'AIN', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: VENTURE, ventureName: 'QuietQuad', role: 'founder' }],
  assignedVentureIds: [],
  disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
  aiEnabled: true,
  notices: [],
};

const CALL_CONFIG = {
  veir: {
    personaId: IDS.persona,
    name: "Corin's vEIR",
    shortName: 'Corin',
    kind: 'eir_persona',
    eirDisplayName: 'Corin Halvorsen',
    tagline: null,
    disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
    embodiment: {
      provider: 'builtin',
      voiceId: null,
      portraitUrl: null,
      voiceConsented: false,
      likenessConsented: false,
    },
  },
  provider: 'builtin',
  maxMinutes: 20,
  remainingMinutesToday: 40,
  aiEnabled: true,
  callsEnabled: true,
};

function liveCall(sessionId: string): CallView {
  return {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01',
    sessionId,
    ventureId: VENTURE,
    personaId: IDS.persona,
    status: 'live',
    provider: 'builtin',
    inputMode: 'typed',
    startedAt: '2026-10-01T12:00:00.000Z',
    endedAt: null,
    endReason: null,
    maxSeconds: 1200,
    durationSeconds: null,
  };
}

let signOutNow: (() => void) | null = null;

/** The page under the provider: the Call entry, a way elsewhere, and the account menu's sign-out. */
function Page() {
  const { signOut } = useSignOutAndRedirect();
  useEffect(() => {
    signOutNow = signOut;
  }, [signOut]);
  return (
    <nav>
      <Link
        to="/$tenant/app/v/$ventureId/c/$sessionId"
        params={{ tenant: 'ain', ventureId: VENTURE, sessionId: SESSION }}
        search={{ call: 1 }}
      >
        Call
      </Link>
      <Link
        to="/$tenant/app/v/$ventureId"
        params={{ tenant: 'ain', ventureId: VENTURE }}
        search={{ call: 1 }}
      >
        Call from New chat
      </Link>
      <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant: 'ain', ventureId: VENTURE }}>
        Knowledge
      </Link>
    </nav>
  );
}

function renderApp(entries: string[], snapshot: Partial<CallSnapshot> = {}) {
  const log: string[] = [];
  const engine = new StandInEngine(snapshot, log);
  engines.next = engine;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({
    component: () => (
      <CallProvider me={ME}>
        <Outlet />
      </CallProvider>
    ),
  });
  const page = (path: string) => createRoute({ getParentRoute: () => root, path, component: Page });
  const history = createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/$tenant/app/v/$ventureId'),
      page('/$tenant/app/v/$ventureId/c/$sessionId'),
      page('/$tenant/app/v/$ventureId/knowledge'),
      createRoute({ getParentRoute: () => root, path: '/sign-in', component: () => <p>Signed out</p> }),
    ]),
    history,
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const url = () => `${router.state.location.pathname}${router.state.location.searchStr}`;
  return { engine, router, log, url };
}

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  window.localStorage.setItem('fa.call.voice-notice', '1');
  signOutNow = null;
  fetchMock = stubFetch();
  fetchMock.mockImplementation((input) => {
    const url = urlOf(input);
    if (url.endsWith('/call-config')) return Promise.resolve(json(CALL_CONFIG));
    return Promise.resolve(json({ code: 'not_found' }, 404));
  });
});
afterEach(() => {
  window.localStorage.clear();
});

describe('signing out during a call', () => {
  it('ends the call on the server before the session is revoked', async () => {
    const { engine, log } = renderApp([`${BASE}/c/${SESSION}?call=1`], {
      phase: 'live',
      ventureId: VENTURE,
      sessionId: SESSION,
      call: liveCall(SESSION),
      input: 'typed',
      activity: 'listening',
      liveAt: Date.now(),
      remaining: { seconds: 1200, at: Date.now() },
    });
    await screen.findByRole('button', { name: 'End call' });
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      log.push(url.replace(/^.*\/api\/v1/, ''));
      if (url.endsWith('/call-config')) return Promise.resolve(json(CALL_CONFIG));
      if (url.endsWith('/auth/sign-out')) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({ code: 'not_found' }, 404));
    });
    act(() => {
      signOutNow?.();
    });
    await screen.findByText('Signed out');
    expect(engine.end).toHaveBeenCalledWith('user');
    const signedOut = log.indexOf('/auth/sign-out');
    expect(signedOut).toBeGreaterThan(-1);
    expect(log.indexOf('ended')).toBeGreaterThan(-1);
    expect(log.indexOf('ended')).toBeLessThan(signedOut);
  });
});
