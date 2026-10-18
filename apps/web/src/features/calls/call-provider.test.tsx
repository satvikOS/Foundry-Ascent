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
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { useSignOutAndRedirect } from '@/components/shell/account-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/api/query-keys';
import type { StartCallOptions } from '@/lib/realtime/call-engine';
import { IDLE_CALL, type CallSnapshot } from '@/lib/realtime/call-state';
import { IDS } from '@/lib/realtime/testing';

import { markChoiceInView, setStartPrivacy, takeChoiceInView } from '../chat/privacy-choice';
import { CallProvider } from './call-context';
import { MiniCallBar } from './mini-call-bar';
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

const engines = vi.hoisted((): { next: unknown; face: unknown } => ({ next: null, face: null }));
vi.mock('./create-engine', () => ({
  createCallEngine: () => engines.next,
  createCallFace: () => engines.face,
}));

const VENTURE = IDS.venture;
const SESSION = IDS.session;
const OTHER_SESSION = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a10';
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
  // This person acknowledged the first-call notice already (the server keeps it with the person).
  callNoticeAcknowledgedAt: '2026-10-01T11:00:00.000Z',
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
      {/* New chat's own Call button, beside Remember or Private. */}
      <Link
        to="/$tenant/app/v/$ventureId"
        params={{ tenant: 'ain', ventureId: VENTURE }}
        search={{ call: 1 }}
        onClick={() => {
          markChoiceInView(VENTURE);
        }}
      >
        Call from New chat
      </Link>
      {/* The sidebar's (or ⌘K's) Call: a new conversation, away from New chat's choice. */}
      <Link
        to="/$tenant/app/v/$ventureId"
        params={{ tenant: 'ain', ventureId: VENTURE }}
        search={{ call: 1 }}
      >
        Call from the sidebar
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
  // The venture is in the cache already (the sidebar loaded it): the mini bar takes the vEIR's name from it.
  client.setQueryData(queryKeys.venture.detail(VENTURE), {
    persona: {
      personaId: IDS.persona,
      name: "Corin's vEIR",
      kind: 'eir_persona',
      disclosure: CALL_CONFIG.veir.disclosure,
    },
  });
  const root = createRootRoute({
    component: () => (
      <CallProvider me={ME}>
        <MiniCallBar />
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
  setStartPrivacy(VENTURE, 'standard');
  takeChoiceInView(VENTURE);
});

/** Whether the page asked the server to create a conversation (`POST /ventures/:id/sessions`). */
function sessionCreated(): boolean {
  return fetchMock.mock.calls.some(
    ([input, init]) => urlOf(input).endsWith(`/ventures/${VENTURE}/sessions`) && init?.method === 'POST',
  );
}

/** The body of the `POST /ventures/:id/sessions` that created the call's conversation. */
function createdSession(): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => urlOf(input).endsWith(`/ventures/${VENTURE}/sessions`) && init?.method === 'POST',
  );
  const body = call?.[1]?.body;
  if (body && ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body)) as unknown;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

describe('starting a call', () => {
  it('starts when the founder clicks Call, never when history comes back to the call’s URL', async () => {
    // An earlier call's ?call=1 entry, then the conversation, then another page.
    const { engine, router, url } = renderApp([
      `${BASE}/c/${SESSION}?call=1`,
      `${BASE}/c/${SESSION}`,
      `${BASE}/knowledge`,
    ]);
    await screen.findByRole('link', { name: 'Knowledge' });
    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(url()).toBe(`${BASE}/c/${SESSION}`);
    });
    act(() => {
      router.history.back();
    });
    // Back on the call's URL: the call screen opens and waits for Start call. No microphone, no call.
    const start = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    expect(url()).toBe(`${BASE}/c/${SESSION}?call=1`);
    expect(engine.start).not.toHaveBeenCalled();
    // Forward and Back again: still nothing.
    act(() => {
      router.history.forward();
    });
    await waitFor(() => {
      expect(url()).toBe(`${BASE}/c/${SESSION}`);
    });
    act(() => {
      router.history.back();
    });
    await screen.findByRole('button', { name: 'Start call' });
    expect(engine.start).not.toHaveBeenCalled();

    // The founder's own click starts it.
    await userEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.start.mock.calls[0]?.[0]).toMatchObject({ ventureId: VENTURE, sessionId: SESSION });
  });

  it('starts at once from a Call link, and closing leaves no call entry behind', async () => {
    const { engine, router, url } = renderApp([`${BASE}/knowledge`, `${BASE}/c/${SESSION}`]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call' }));
    await waitFor(() => {
      expect(engine.start).toHaveBeenCalledTimes(1);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => {
      expect(url()).toBe(`${BASE}/c/${SESSION}`);
    });
    // The call screen's entry was replaced: Back goes through the conversation, never to ?call=1.
    for (const expected of [`${BASE}/c/${SESSION}`, `${BASE}/knowledge`]) {
      act(() => {
        router.history.back();
      });
      await waitFor(() => {
        expect(url()).toBe(expected);
      });
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(engine.start).toHaveBeenCalledTimes(1);
  });

  it('forgets an ended call of another conversation when Call opens New chat', async () => {
    const { engine } = renderApp([BASE], {
      phase: 'ended',
      ventureId: VENTURE,
      sessionId: OTHER_SESSION,
      call: { ...liveCall(OTHER_SESSION), status: 'ended' },
      ended: {
        reason: 'user',
        durationSeconds: 30,
        turnCount: 2,
        summary: null,
        summaryError: null,
        blocked: null,
      },
    });
    await userEvent.click(await screen.findByRole('link', { name: 'Call from New chat' }));
    // The old summary is not what Call opens: a new call is started in a new conversation.
    await waitFor(() => {
      expect(engine.reset).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            urlOf(input).endsWith(`/ventures/${VENTURE}/sessions`) && init?.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(screen.queryByRole('heading', { name: 'Call ended' })).toBeNull();
  });
});

describe('Remember or Private for a call from New chat', () => {
  it('remembers the call’s conversation by default', async () => {
    renderApp([BASE]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call from New chat' }));
    await waitFor(() => {
      expect(createdSession()).toMatchObject({ privacy: 'standard' });
    });
  });

  it('makes the call private when New chat chose Private', async () => {
    setStartPrivacy(VENTURE, 'ephemeral');
    renderApp([BASE]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call from New chat' }));
    await waitFor(() => {
      expect(createdSession()).toMatchObject({ privacy: 'ephemeral' });
    });
  });

  it('offers the choice before a New chat call that waits for Start call', async () => {
    // A tab that has seen no click (a link opened later): the call waits for Start call.
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { hasBeenActive: false, isActive: false },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(navigator, 'userActivation');
    });
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith('/call-config')) return Promise.resolve(json(CALL_CONFIG));
      if (url.endsWith(`/ventures/${VENTURE}/sessions`) && init?.method === 'POST') {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(json({ code: 'not_found' }, 404));
    });
    renderApp([`${BASE}?call=1`]);
    const start = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    const group = screen.getByRole('group', { name: 'Memory for this call' });
    expect(within(group).getByRole('radio', { name: 'Remember this call' })).toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: 'Private, a one-off' }));
    await userEvent.click(start);
    await waitFor(() => {
      expect(createdSession()).toMatchObject({ privacy: 'ephemeral' });
    });
  });

  it('from the sidebar, waits on the start screen with Remember chosen, and starts on Start call', async () => {
    const { engine } = renderApp([`${BASE}/knowledge`]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call from the sidebar' }));
    const start = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    const group = screen.getByRole('group', { name: 'Memory for this call' });
    expect(within(group).getByRole('radio', { name: 'Remember this call' })).toBeChecked();
    expect(group).toHaveAccessibleDescription('Remembered for next time.');
    // Nothing is created or started before the founder chooses.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessionCreated()).toBe(false);
    expect(engine.start).not.toHaveBeenCalled();
    await userEvent.click(start);
    await waitFor(() => {
      expect(createdSession()).toMatchObject({ privacy: 'standard' });
    });
  });

  it('from the sidebar, a private call is chosen before it starts', async () => {
    renderApp([`${BASE}/knowledge`]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call from the sidebar' }));
    const start = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('radio', { name: 'Private, a one-off' }));
    await userEvent.click(start);
    await waitFor(() => {
      expect(createdSession()).toMatchObject({ privacy: 'ephemeral' });
    });
  });

  it('starts at once only for the opening that New chat’s Call button made', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith('/call-config')) return Promise.resolve(json(CALL_CONFIG));
      if (url.endsWith(`/ventures/${VENTURE}/sessions`) && init?.method === 'POST') {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(json({ code: 'not_found' }, 404));
    });
    const { url } = renderApp([BASE]);
    await userEvent.click(await screen.findByRole('link', { name: 'Call from New chat' }));
    await waitFor(() => {
      expect(sessionCreated()).toBe(true);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => {
      expect(url()).toBe(BASE);
    });
    fetchMock.mockClear();
    // A later Call from the sidebar is not beside the choice: it waits for Start call.
    await userEvent.click(screen.getByRole('link', { name: 'Call from the sidebar' }));
    const start = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => {
      expect(start).toBeEnabled();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessionCreated()).toBe(false);
  });

  it('offers no choice for a call in an existing conversation', async () => {
    renderApp([`${BASE}/c/${SESSION}?call=1`]);
    await screen.findByRole('button', { name: 'Start call' });
    expect(screen.queryByRole('group', { name: /Memory for this/ })).toBeNull();
  });
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

describe('the mini call bar', () => {
  /** A live call, minimized: the conversation with the mini bar. */
  async function minimized() {
    const app = renderApp([`${BASE}/c/${SESSION}?call=1`], {
      phase: 'live',
      ventureId: VENTURE,
      sessionId: SESSION,
      call: { ...liveCall(SESSION), inputMode: 'transcribe' },
      input: 'voice',
      activity: 'listening',
      liveAt: Date.now(),
      remaining: { seconds: 600, at: Date.now() },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Minimize call' }));
    const bar = await screen.findByRole('region', { name: "Call with Corin's vEIR" });
    return { ...app, bar };
  }

  it('shows the live face as the bar’s thumbnail, and the monogram again once it is gone', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const provider = { setState: vi.fn(), speak: vi.fn(), setLevels: vi.fn() };
    let face: { status: string; stream?: MediaStream; provider?: typeof provider } = {
      status: 'live',
      stream,
      provider,
    };
    const listeners = new Set<() => void>();
    engines.face = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => face,
      request: vi.fn(),
      close: vi.fn(),
    };
    try {
      const { bar } = await minimized();
      const video = bar.querySelector<HTMLVideoElement>('[data-slot="call-face-thumbnail"] video');
      expect(video?.muted).toBe(true);
      expect(video?.srcObject).toBe(stream);
      act(() => {
        face = { status: 'presence' };
        for (const listener of [...listeners]) listener();
      });
      expect(bar.querySelector('[data-slot="call-face-thumbnail"]')).toBeNull();
    } finally {
      engines.face = null;
    }
  });

  it('warns when the time is nearly up, and says when the call ended out of view', async () => {
    const { engine, bar } = await minimized();
    // The bar sits at the top of the page, over whatever scrolls under it: the bars' dense glass.
    expect(bar).toHaveClass('glass-bar');
    const status = within(bar).getByRole('status');
    expect(status).toHaveTextContent('');
    act(() => {
      engine.set({
        remaining: { seconds: 100, at: Date.now() },
        notice: { kind: 'time_warning', message: 'About 2 minutes left on this call.' },
      });
    });
    expect(bar).toHaveTextContent(/1:[34]\d left/);
    expect(status).toHaveTextContent('About 2 minutes left on this call.');

    act(() => {
      engine.set({
        phase: 'ended',
        ended: {
          reason: 'timeout',
          durationSeconds: 1200,
          turnCount: 4,
          summary: null,
          summaryError: null,
          blocked: null,
        },
      });
    });
    expect(bar).toHaveTextContent('Call ended');
    expect(status).toHaveTextContent('Call ended. The call reached its time limit.');
    expect(within(bar).getByRole('button', { name: 'Summary' })).toBeInTheDocument();
  });

  it('offers Turn on sound when the browser stopped the call’s sound, keeping the AI marker', async () => {
    const { engine, bar } = await minimized();
    expect(within(bar).queryByRole('button', { name: 'Turn on sound' })).toBeNull();
    // An interruption (a phone call on iOS) suspends the call's audio while it is minimized.
    act(() => {
      engine.set({ audioBlocked: true });
    });
    expect(bar).toHaveTextContent('Sound is off');
    expect(within(bar).getByRole('status')).toHaveTextContent('Sound is off.');
    await userEvent.click(within(bar).getByRole('button', { name: 'Turn on sound' }));
    expect(engine.resumeAudio).toHaveBeenCalledTimes(1);
    // The vEIR keeps its badge in the bar (the call settings here carry no first-person consent: "AI").
    expect(bar.querySelector('[data-slot="veir-badge"]')).toHaveTextContent('AI');

    act(() => {
      engine.set({ audioBlocked: false });
    });
    expect(within(bar).queryByRole('button', { name: 'Turn on sound' })).toBeNull();
    expect(bar).not.toHaveTextContent('Sound is off');
  });

  it('says when the microphone disconnected while the call is minimized', async () => {
    const { engine, bar } = await minimized();
    act(() => {
      engine.set({ input: 'typed', typedReason: 'mic_lost' });
    });
    expect(bar).toHaveTextContent('Microphone disconnected');
    expect(within(bar).getByRole('status')).toHaveTextContent(
      'Microphone disconnected. Return to the call to reconnect it.',
    );
  });
});
