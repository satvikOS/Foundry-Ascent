import type { AvatarSessionResponse } from '@foundry/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarProvider, FaceRelay, FaceRenderer } from '@/lib/realtime/avatar';

import { CallStage } from './call-stage';
import { LIVE, fakeEngine, json, renderWithRouter, stubFetch } from './testing';
import { CallFaceController, type CallFaceDeps } from './use-call-face';
import type { CallVeir } from './use-call-veir';

const VENTURE = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';
const CALL = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const LIVE_CALL = {
  ...LIVE,
  call: {
    id: CALL,
    sessionId: LIVE.sessionId ?? '',
    ventureId: VENTURE,
    personaId: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
    status: 'live' as const,
    provider: 'builtin' as const,
    inputMode: 'transcribe' as const,
    startedAt: '2026-10-17T12:00:00.000Z',
    endedAt: null,
    endReason: null,
    maxSeconds: 1800,
    durationSeconds: null,
  },
};

const SESSION: AvatarSessionResponse = {
  provider: 'fake',
  token: 'fake.session-1',
  expiresAt: '2026-10-17T12:01:00.000Z',
  voiceId: 'Matthew',
  voicing: 'audio',
  url: null,
  stockFace: false,
};

function veir(provider: CallVeir['provider']): CallVeir {
  return {
    name: 'Corin · vEIR',
    shortName: 'Corin',
    badge: 'vEIR',
    kind: 'eir_persona',
    eirFirstName: 'Corin',
    firstPerson: true,
    eirSeesWork: true,
    disclosure: '',
    portraitUrl: null,
    provider,
  };
}

/** A vendor face whose connection the test controls. */
function vendorFace() {
  let connected: (() => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  let lost: (() => void) | null = null;
  const renderer: FaceRenderer = { ready: () => true, render: () => () => undefined };
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const provider = {
    id: 'fake',
    drawsFace: true,
    voicing: 'audio',
    mount: vi.fn(),
    setState: vi.fn(),
    setLevels: vi.fn(),
    speak: vi.fn(),
    unmount: vi.fn(),
    connect: vi.fn(
      (_session: AvatarSessionResponse, _signal: AbortSignal, _relay: FaceRelay) =>
        new Promise<void>((resolve, reject) => {
          connected = resolve;
          failed = reject;
        }),
    ),
    video: () => stream,
    renderer: () => renderer,
    onLost: (listener: () => void) => {
      lost = listener;
      return () => {
        lost = null;
      };
    },
  } satisfies AvatarProvider;
  return {
    provider,
    renderer,
    stream,
    connect: () => {
      connected?.();
    },
    fail: () => {
      failed?.(new Error('refused'));
    },
    lose: () => {
      lost?.();
    },
  };
}

function deps(face: ReturnType<typeof vendorFace>, session: AvatarSessionResponse = SESSION) {
  const relay: FaceRelay = { speak: vi.fn(() => Promise.resolve()), interrupt: vi.fn() };
  return {
    startSession: vi.fn((_venture: string, _call: string, _signal: AbortSignal) => Promise.resolve(session)),
    loadProvider: vi.fn(() => Promise.resolve(face.provider as AvatarProvider)),
    relayFor: vi.fn((_callId: string) => relay),
    endFace: vi.fn((_callId: string) => Promise.resolve()),
    connectTimeoutMs: 8_000,
  } satisfies CallFaceDeps;
}

/** A call's face controller over a fake engine with a live call. */
function controllerWith(face: ReturnType<typeof vendorFace>, session?: AvatarSessionResponse) {
  const fake = fakeEngine(LIVE_CALL);
  const faceDeps = deps(face, session);
  return { ...fake, faceDeps, controller: new CallFaceController(fake.asEngine, faceDeps) };
}

function stage(props: {
  controller: CallFaceController;
  engine: ReturnType<typeof fakeEngine>['asEngine'];
  provider?: CallVeir['provider'];
  callId?: string | null;
  state?: 'listening' | 'speaking' | 'connecting';
  onVideoChange?: (live: boolean) => void;
}) {
  return (
    <CallStage
      veir={veir(props.provider ?? 'fake')}
      engine={props.engine}
      state={props.state ?? 'listening'}
      ventureId={VENTURE}
      callId={props.callId === undefined ? CALL : props.callId}
      face={props.controller}
      {...(props.onVideoChange ? { onVideoChange: props.onVideoChange } : {})}
    />
  );
}

/** The square stage of the presence (the face whenever no video is shown). */
async function presenceShown(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-slot="call-stage"]')).not.toBeNull();
  });
}

beforeEach(() => {
  stubFetch().mockResolvedValue(json({ title: 'Unauthorized', status: 401 }, 401));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CallStage: the face of a call', () => {
  it('shows the presence for the built-in provider and never asks for a session', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps } = controllerWith(face);
    renderWithRouter(stage({ controller, engine: asEngine, provider: 'builtin' }));
    await presenceShown();
    expect(faceDeps.startSession).not.toHaveBeenCalled();
    expect(engine.attachFace).not.toHaveBeenCalled();
    // Without faces, the tile is exactly the presence tile (no layout change).
    expect(document.querySelector('[data-slot="call-tile"]')).toHaveAttribute('data-face', 'presence');
  });

  it('becomes a video in the same tile once the vendor face shows its first frame, and hands it the call’s audio', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps } = controllerWith(face);
    const onVideoChange = vi.fn();
    const { container } = renderWithRouter(
      stage({ controller, engine: asEngine, state: 'speaking', onVideoChange }),
    );
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.startSession).toHaveBeenCalledWith(VENTURE, CALL, expect.any(AbortSignal));
    expect(face.provider.connect.mock.calls[0]?.[0]).toEqual(SESSION);
    // The face's audio goes through the server for this call.
    expect(faceDeps.relayFor).toHaveBeenCalledWith(CALL);
    // Until the first frame, the presence is the face.
    await presenceShown();
    expect(engine.attachFace).not.toHaveBeenCalledWith(face.renderer);

    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    const tile = container.querySelector('[data-slot="call-tile"]');
    expect(tile).toHaveAttribute('data-face', 'video');
    expect(tile).toHaveAttribute('data-speaking', 'true');
    expect(container.querySelector('[data-slot="call-name-tag"]')).toHaveTextContent('Corin');
    expect(container.querySelector('[data-slot="call-stage"]')).toBeNull();
    const video = container.querySelector<HTMLVideoElement>('[data-slot="call-video"]');
    expect(video?.muted).toBe(true);
    expect(video?.srcObject).toBe(face.stream);
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(true);
    expect(onVideoChange).toHaveBeenLastCalledWith(true);
    expect(face.provider.setState).toHaveBeenCalledWith('speaking');
  });

  it('loads a FULL stock face for text voicing, hands it the call’s units and labels it "AI avatar"', async () => {
    const face = vendorFace();
    const full: AvatarSessionResponse = { ...SESSION, voicing: 'text', stockFace: true };
    const { asEngine, engine, controller, faceDeps } = controllerWith(face, full);
    const { container } = renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.loadProvider).toHaveBeenCalledWith('fake', 'text');
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    expect(screen.getByText('AI avatar')).toBeVisible();
    expect(container.querySelector('[data-slot="call-ai-avatar-label"]')).not.toBeNull();
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(controller.getSnapshot()).toMatchObject({ status: 'live', stock: true });
  });

  it('shows no "AI avatar" label on a face that is not a stock avatar', async () => {
    const face = vendorFace();
    const { asEngine, controller, faceDeps } = controllerWith(face);
    renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.loadProvider).toHaveBeenCalledWith('fake', 'audio');
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    expect(screen.queryByText('AI avatar')).toBeNull();
  });

  it('keeps the face while the call is minimized and shows it again, asking only once per call', async () => {
    const face = vendorFace();
    const { asEngine, controller, faceDeps } = controllerWith(face);
    const first = renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    // Minimized: the call screen unmounts, the face stays with the call.
    first.unmount();
    expect(face.provider.unmount).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('live');
    renderWithRouter(stage({ controller, engine: asEngine }));
    await screen.findByRole('figure');
    expect(faceDeps.startSession).toHaveBeenCalledTimes(1);
  });

  it('goes back to the presence, quietly, when the face drops mid-call, and tells the server', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps } = controllerWith(face);
    const onVideoChange = vi.fn();
    renderWithRouter(stage({ controller, engine: asEngine, onVideoChange }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    act(() => {
      face.lose();
    });
    await presenceShown();
    expect(engine.attachFace).toHaveBeenLastCalledWith(null);
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(false);
    expect(face.provider.unmount).toHaveBeenCalled();
    expect(faceDeps.endFace).toHaveBeenCalledWith(CALL);
    expect(onVideoChange).toHaveBeenLastCalledWith(false);
    // Never asked for again in this call.
    renderWithRouter(stage({ controller, engine: asEngine }));
    expect(faceDeps.startSession).toHaveBeenCalledTimes(1);
  });

  it('drops the face when the server says stop, and for a crisis turn (a face never says the crisis line)', async () => {
    const stopped = vendorFace();
    const a = controllerWith(stopped);
    renderWithRouter(stage({ controller: a.controller, engine: a.asEngine }));
    await waitFor(() => {
      expect(stopped.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      stopped.connect();
    });
    await screen.findByRole('figure');
    act(() => {
      a.stopFace();
    });
    await waitFor(() => {
      expect(a.controller.getSnapshot().status).toBe('presence');
    });
    // The server already ended it.
    expect(a.faceDeps.endFace).not.toHaveBeenCalled();

    const crisis = vendorFace();
    const b = controllerWith(crisis);
    b.controller.request({ provider: 'fake', ventureId: VENTURE, callId: CALL, reducedMotion: false });
    await waitFor(() => {
      expect(crisis.provider.connect).toHaveBeenCalled();
    });
    crisis.connect();
    await waitFor(() => {
      expect(b.controller.getSnapshot().status).toBe('live');
    });
    b.setSnapshot({
      ...LIVE_CALL,
      blocked: { reason: 'crisis_support', message: 'Support is available.', resources: [] } as never,
    });
    expect(b.controller.getSnapshot().status).toBe('presence');
    expect(b.faceDeps.endFace).toHaveBeenCalledWith(CALL);
  });

  it('gives the face up when the call stays on hold (the vendor bills idle faces); a short hold keeps it', async () => {
    const face = vendorFace();
    const fake = fakeEngine(LIVE_CALL);
    const faceDeps = { ...deps(face), holdGraceMs: 40 };
    const controller = new CallFaceController(fake.asEngine, faceDeps);
    controller.request({ provider: 'fake', ventureId: VENTURE, callId: CALL, reducedMotion: false });
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    face.connect();
    await waitFor(() => {
      expect(controller.getSnapshot().status).toBe('live');
    });
    // A quick look at another tab: back before the grace runs out.
    fake.setSnapshot({ ...LIVE_CALL, held: true });
    fake.setSnapshot({ ...LIVE_CALL, held: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(controller.getSnapshot().status).toBe('live');
    expect(faceDeps.endFace).not.toHaveBeenCalled();
    // Left on hold: the face ends, and the server ends the vendor session.
    fake.setSnapshot({ ...LIVE_CALL, held: true });
    await waitFor(() => {
      expect(controller.getSnapshot().status).toBe('presence');
    });
    expect(faceDeps.endFace).toHaveBeenCalledWith(CALL);
    expect(face.provider.unmount).toHaveBeenCalled();
  });

  it('keeps the presence when the API offers no face or the face cannot connect', async () => {
    const noToken = vendorFace();
    const a = controllerWith(noToken, { ...SESSION, provider: 'builtin', token: null, voicing: 'engine' });
    const first = renderWithRouter(stage({ controller: a.controller, engine: a.asEngine }));
    await waitFor(() => {
      expect(a.faceDeps.startSession).toHaveBeenCalled();
    });
    expect(a.faceDeps.loadProvider).not.toHaveBeenCalled();
    await presenceShown();
    first.unmount();

    const refused = vendorFace();
    const b = controllerWith(refused);
    renderWithRouter(stage({ controller: b.controller, engine: b.asEngine }));
    await waitFor(() => {
      expect(refused.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      refused.fail();
    });
    await waitFor(() => {
      expect(refused.provider.unmount).toHaveBeenCalled();
    });
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(b.faceDeps.endFace).toHaveBeenCalledWith(CALL);
  });

  it('gives up on a face that shows no frame in time, cancelling its join', async () => {
    const slow = vendorFace();
    const fake = fakeEngine(LIVE_CALL);
    const faceDeps = { ...deps(slow), connectTimeoutMs: 30 };
    const controller = new CallFaceController(fake.asEngine, faceDeps);
    renderWithRouter(stage({ controller, engine: fake.asEngine }));
    await waitFor(() => {
      expect(slow.provider.unmount).toHaveBeenCalled();
    });
    // The vendor's join is cancelled, so no session goes on (and bills) unseen.
    expect(slow.provider.connect.mock.calls[0]?.[1].aborted).toBe(true);
    act(() => {
      slow.connect();
    });
    await presenceShown();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(fake.engine.attachFace).not.toHaveBeenCalledWith(slow.renderer);
  });

  it('asks for no face before the call is live, and closes the face when the call ends', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps, setSnapshot } = controllerWith(face);
    const view = renderWithRouter(stage({ controller, engine: asEngine, callId: null, state: 'connecting' }));
    await presenceShown();
    expect(faceDeps.startSession).not.toHaveBeenCalled();
    view.unmount();

    renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    const signal = faceDeps.startSession.mock.calls[0]?.[2];
    act(() => {
      setSnapshot({ ...LIVE_CALL, phase: 'ended' });
    });
    expect(signal?.aborted).toBe(true);
    expect(face.provider.unmount).toHaveBeenCalled();
    expect(engine.attachFace).toHaveBeenLastCalledWith(null);
    // The call's end ended the face on the server; heartbeats no longer report one.
    expect(faceDeps.endFace).not.toHaveBeenCalled();
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(null);
  });
});
