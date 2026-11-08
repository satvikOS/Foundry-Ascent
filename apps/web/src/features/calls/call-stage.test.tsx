import type { AvatarSessionResponse, FaceJoinStage } from '@foundry/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarProvider, FaceLoss, FaceRelay, FaceRenderer } from '@/lib/realtime/avatar';

import { CallStage } from './call-stage';
import { LIVE, fakeEngine, json, renderWithRouter, stubFetch } from './testing';
import { CallFaceController, FACE_SESSION_TIMEOUT_MS, type CallFaceDeps } from './use-call-face';
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
  controlUrl: null,
};

function veir(provider: CallVeir['provider']): CallVeir {
  return {
    name: 'Thomas',
    shortName: 'Thomas',
    kind: 'eir_persona',
    presentation: 'mentor',
    eirFirstName: 'Corin',
    firstPerson: true,
    eirSeesWork: true,
    disclosure: '',
    portraitUrl: null,
    provider,
  };
}

/** A vendor face whose connection the test controls (`media`: it brings its own element, video and voice). */
function vendorFace(options: { media?: HTMLVideoElement; joinStage?: FaceJoinStage } = {}) {
  let connected: (() => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  let lost: ((loss: FaceLoss) => void) | null = null;
  const renderer: FaceRenderer = { ready: () => true, render: () => () => undefined };
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const provider = {
    id: 'fake',
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
    media: () => options.media ?? null,
    renderer: () => renderer,
    joinStage: (): FaceJoinStage | null => options.joinStage ?? null,
    onLost: (listener: (loss: FaceLoss) => void) => {
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
    fail: (error: Error = new Error('refused')) => {
      failed?.(error);
    },
    lose: (loss: FaceLoss = { reason: 'video_ended' }) => {
      lost?.(loss);
    },
  };
}

function deps(face: ReturnType<typeof vendorFace>, session: AvatarSessionResponse = SESSION) {
  const relay: FaceRelay = { speak: vi.fn(() => Promise.resolve()), interrupt: vi.fn() };
  return {
    startSession: vi.fn((_venture: string, _call: string, _signal: AbortSignal) => Promise.resolve(session)),
    loadProvider: vi.fn(() => Promise.resolve(face.provider as AvatarProvider)),
    relayFor: vi.fn((_callId: string) => relay),
    endFace: vi.fn((_callId: string, _loss: FaceLoss) => Promise.resolve()),
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
  /** A voice call (false) never asks for the face; a video call (the default here) does. */
  video?: boolean;
}) {
  return (
    <CallStage
      veir={veir(props.provider ?? 'fake')}
      engine={props.engine}
      state={props.state ?? 'listening'}
      ventureId={VENTURE}
      callId={props.callId === undefined ? CALL : props.callId}
      face={props.controller}
      video={props.video ?? true}
    />
  );
}

/** The sphere's stage (a voice call's presence, or a call without a vendor face). */
async function presenceShown(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-slot="call-stage"]')).not.toBeNull();
  });
}

/**
 * A video call's tile while its face is not shown: it says so in words, and never falls back to the sphere (owner,
 * round 3).
 */
async function videoTileSays(
  text: string,
  face: 'connecting' | 'reconnecting' | 'paused' | 'unavailable',
): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-slot="call-video-pending"]')).toHaveTextContent(text);
  });
  expect(document.querySelector('[data-slot="call-tile"]')).toHaveAttribute('data-face', `video-${face}`);
  expect(document.querySelector('[data-slot="call-stage"]')).toBeNull();
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

  it('never asks for a face on a voice call, even when one is offered; once switched to video it does', async () => {
    const face = vendorFace();
    const { asEngine, controller, faceDeps } = controllerWith(face);
    function Switchable() {
      const [video, setVideo] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setVideo(true);
            }}
          >
            Video
          </button>
          {stage({ controller, engine: asEngine, video })}
        </>
      );
    }
    renderWithRouter(<Switchable />);
    await presenceShown();
    expect(faceDeps.startSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('presence');
    await userEvent.click(screen.getByRole('button', { name: 'Video' }));
    await waitFor(() => {
      expect(faceDeps.startSession).toHaveBeenCalledTimes(1);
    });
    expect(controller.getSnapshot().status).toBe('connecting');
  });

  it('becomes a video in the same tile once the vendor face shows its first frame, and hands it the call’s audio', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps } = controllerWith(face);
    const { container } = renderWithRouter(stage({ controller, engine: asEngine, state: 'speaking' }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.startSession).toHaveBeenCalledWith(VENTURE, CALL, expect.any(AbortSignal));
    expect(face.provider.connect.mock.calls[0]?.[0]).toEqual(SESSION);
    // The face's audio goes through the server for this call.
    expect(faceDeps.relayFor).toHaveBeenCalledWith(CALL);
    // Until the first frame, the tile says the call is connecting to Thomas (no stand-in face), and the conversation
    // waits for the face.
    await videoTileSays('Connecting to Thomas…', 'connecting');
    expect(engine.attachFace).not.toHaveBeenCalledWith(face.renderer);
    expect(engine.startConversation).not.toHaveBeenCalled();

    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    const tile = container.querySelector('[data-slot="call-tile"]');
    expect(tile).toHaveAttribute('data-face', 'video');
    expect(tile).toHaveAttribute('data-speaking', 'true');
    expect(container.querySelector('[data-slot="call-name-tag"]')).toHaveTextContent('Thomas');
    expect(container.querySelector('[data-slot="call-stage"]')).toBeNull();
    const video = container.querySelector<HTMLVideoElement>('[data-slot="call-video"]');
    expect(video?.muted).toBe(true);
    expect(video?.srcObject).toBe(face.stream);
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(true);
    expect(face.provider.setState).toHaveBeenCalledWith('speaking');
    // The face is there: its first frame is timed, and the conversation starts (the face says the intro).
    expect(engine.faceArrived).toHaveBeenCalledTimes(1);
    expect(engine.startConversation).toHaveBeenCalledTimes(1);
    expect(engine.attachFace.mock.invocationCallOrder.at(-1)).toBeLessThan(
      engine.startConversation.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('shows a vendor face’s own element (video and voice together, unmuted), and keeps it playing while minimized', async () => {
    // The adapter's element: one stream with both tracks, unmuted, so the browser keeps the lips in step.
    const media = document.createElement('video');
    media.srcObject = { getTracks: () => [] } as unknown as MediaStream;
    const play = vi.spyOn(media, 'play').mockResolvedValue(undefined);
    const face = vendorFace({ media });
    const { asEngine, controller } = controllerWith(face, { ...SESSION, voicing: 'text', stockFace: true });
    const first = renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    // The tile shows that very element (never a muted copy), so the voice is heard once.
    const shown = first.container.querySelectorAll('video');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe(media);
    expect(media.muted).toBe(false);
    expect(first.container.querySelector('[data-slot="call-video-host"]')?.contains(media)).toBe(true);
    await waitFor(() => {
      expect(play).toHaveBeenCalled();
    });
    // Minimized: the element waits on the page, still playing, out of sight; the face stays with the call.
    first.unmount();
    expect(media.isConnected).toBe(true);
    expect(media.muted).toBe(false);
    expect(face.provider.unmount).not.toHaveBeenCalled();
    // Shown again: the same element comes back into the tile.
    const second = renderWithRouter(stage({ controller, engine: asEngine }));
    await screen.findByRole('figure');
    expect(second.container.querySelector('[data-slot="call-video-host"]')?.contains(media)).toBe(true);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    // The face ends: the adapter takes its element off the page, and the tile never puts it back (a new session
    // replaces it).
    act(() => {
      media.srcObject = null;
      media.remove();
      face.lose();
    });
    await videoTileSays('Reconnecting…', 'reconnecting');
    expect(media.isConnected).toBe(false);
  });

  it('loads a FULL stock face for text voicing, hands it the call’s units and labels it "AI avatar"', async () => {
    const face = vendorFace();
    const full: AvatarSessionResponse = { ...SESSION, voicing: 'text', stockFace: true };
    const { asEngine, engine, controller, faceDeps } = controllerWith(face, full);
    const { container } = renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.loadProvider).toHaveBeenCalledWith('fake', 'text', { liteSocket: false });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    expect(screen.getByText('AI avatar')).toBeVisible();
    expect(container.querySelector('[data-slot="call-ai-avatar-label"]')).not.toBeNull();
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(controller.getSnapshot()).toMatchObject({ status: 'live' });
  });

  it('labels a face that is not a stock avatar (an EIR’s consented likeness) "AI avatar" too', async () => {
    const face = vendorFace();
    const { asEngine, controller, faceDeps } = controllerWith(face);
    renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.loadProvider).toHaveBeenCalledWith('fake', 'audio', { liteSocket: false });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    expect(screen.getByText('AI avatar')).toBeVisible();
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

  it('replaces a face the vendor ended with a new session of the call, holding its speech meanwhile', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps } = controllerWith(face);
    renderWithRouter(stage({ controller, engine: asEngine }));
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    expect(engine.setFaceReplaceable).toHaveBeenCalledWith(true);
    engine.holdForFace.mockClear();
    act(() => {
      face.lose({ reason: 'vendor_stopped', vendorReason: 'session_timeout' });
    });
    // At once: the call's speech waits for the next face, the old one is gone, and heartbeats report neither.
    expect(engine.holdForFace).toHaveBeenCalledWith(true);
    expect(engine.attachFace).toHaveBeenLastCalledWith(null);
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(null);
    expect(face.provider.unmount).toHaveBeenCalled();
    await videoTileSays('Reconnecting…', 'reconnecting');
    // The server is told which trigger ended the face (audited with its end), then the next session is asked for.
    expect(faceDeps.endFace).toHaveBeenCalledWith(CALL, {
      reason: 'vendor_stopped',
      vendorReason: 'session_timeout',
    });
    await waitFor(() => {
      expect(faceDeps.startSession).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalledTimes(2);
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    // The new face takes the call's speech, which goes on (the conversation was never restarted).
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(engine.holdForFace).toHaveBeenLastCalledWith(false);
    expect(engine.setFaceShown).toHaveBeenLastCalledWith(true);
    expect(controller.getSnapshot().status).toBe('live');
  });

  it('says video is not available when the face cannot come back, and offers the voice call', async () => {
    const face = vendorFace();
    const fake = fakeEngine(LIVE_CALL);
    const faceDeps = deps(face);
    // The first session opens; the next one is refused (credits used up, a cap): no face is offered.
    faceDeps.startSession
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValue({ ...SESSION, provider: 'builtin', token: null, voicing: 'engine' });
    const controller = new CallFaceController(fake.asEngine, faceDeps);
    const voice = vi.fn();
    renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={fake.asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        face={controller}
        video
        onVoiceInstead={voice}
      />,
    );
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    act(() => {
      face.lose({ reason: 'room_disconnected' });
    });
    await videoTileSays('Video isn’t available right now', 'unavailable');
    expect(controller.getSnapshot()).toEqual({ status: 'unavailable', hadVideo: true });
    // Never a silent downgrade: the speech that waited goes on, and the tile says so with the voice call one tap away.
    expect(fake.engine.holdForFace).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Your conversation with Thomas is kept/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Voice call$/ }));
    expect(voice).toHaveBeenCalledTimes(1);
    // Another try asks the server again.
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(faceDeps.startSession).toHaveBeenCalledTimes(3);
    });
  });

  it('replaces a session close to its end at a quiet moment, before the vendor ends it', async () => {
    const face = vendorFace();
    const fake = fakeEngine(LIVE_CALL);
    let now = Date.parse('2026-10-17T12:00:00.000Z');
    const faceDeps = { ...deps(face), refreshLeadMs: 25_000, wallNow: () => now };
    const controller = new CallFaceController(fake.asEngine, faceDeps);
    // The vendor ends this session at 12:01:00 (the free plan's limit).
    controller.request({ provider: 'fake', ventureId: VENTURE, callId: CALL, reducedMotion: false });
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    // The face shows 20 s before its session ends, while the vEIR speaks: not now. Then the founder's turn: replaced.
    now += 40_000;
    fake.setSnapshot({ ...LIVE_CALL, activity: 'speaking' });
    act(() => {
      face.connect();
    });
    await waitFor(() => {
      expect(controller.getSnapshot().status).toBe('live');
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(faceDeps.startSession).toHaveBeenCalledTimes(1);
    fake.setSnapshot({ ...LIVE_CALL, activity: 'listening' });
    await waitFor(() => {
      expect(faceDeps.endFace).toHaveBeenCalledWith(CALL, { reason: 'time_limit' });
    });
    await waitFor(() => {
      expect(faceDeps.startSession).toHaveBeenCalledTimes(2);
    });
    expect(controller.getSnapshot().status).toBe('reconnecting');
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
      expect(a.controller.getSnapshot()).toEqual({ status: 'unavailable', hadVideo: true });
    });
    // The server already ended it, and it does not come back in this call.
    expect(a.faceDeps.endFace).not.toHaveBeenCalled();
    expect(a.controller.canAsk(CALL)).toBe(false);

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
    // Never back to "connecting": the face is over for this call, so video is not available (the voice call offered).
    expect(b.controller.getSnapshot()).toEqual({ status: 'unavailable', hadVideo: true });
    expect(b.faceDeps.endFace).toHaveBeenCalledWith(CALL, { reason: 'crisis' });
  });

  it('after a crisis turn, once its support is read, the tile offers the voice call, never "Connecting"', async () => {
    const face = vendorFace();
    const { asEngine, setSnapshot, controller, faceDeps } = controllerWith(face);
    const voice = vi.fn();
    const blocked = { reason: 'crisis_support', message: 'Support is available.', resources: [] } as never;
    function Live() {
      // As CallLive: the stage is not shown over the crisis support.
      const [shown, setShown] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown((now) => !now);
            }}
          >
            toggle
          </button>
          {shown ? (
            <CallStage
              veir={veir('fake')}
              engine={asEngine}
              state="listening"
              ventureId={VENTURE}
              callId={CALL}
              face={controller}
              video
              onVoiceInstead={voice}
            />
          ) : null}
        </>
      );
    }
    renderWithRouter(<Live />);
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    act(() => {
      setSnapshot({ ...LIVE_CALL, blocked });
    });
    // The founder's next turn clears the support: the stage is back.
    act(() => {
      setSnapshot({ ...LIVE_CALL, blocked: null });
    });
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await videoTileSays('Video isn’t available right now', 'unavailable');
    expect(screen.getByRole('button', { name: /^Voice call$/ })).toBeVisible();
    // No Try again: the face does not come back in this call.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(faceDeps.startSession).toHaveBeenCalledTimes(1);
  });

  it('a voice call keeps its sphere through a crisis turn; switched to video afterwards, video is not available', async () => {
    const face = vendorFace();
    const { asEngine, setSnapshot, controller, faceDeps } = controllerWith(face);
    const blocked = { reason: 'crisis_support', message: 'Support is available.', resources: [] } as never;
    function Switchable() {
      const [video, setVideo] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setVideo(true);
            }}
          >
            to video
          </button>
          {stage({ controller, engine: asEngine, video })}
        </>
      );
    }
    renderWithRouter(<Switchable />);
    await presenceShown();
    act(() => {
      setSnapshot({ ...LIVE_CALL, blocked });
    });
    act(() => {
      setSnapshot({ ...LIVE_CALL, blocked: null });
    });
    expect(controller.getSnapshot().status).toBe('presence');
    await presenceShown();
    await userEvent.click(screen.getByRole('button', { name: 'to video' }));
    await videoTileSays('Video isn’t available right now', 'unavailable');
    expect(faceDeps.startSession).not.toHaveBeenCalled();
  });

  it('counts only the sessions the server opened: a refused ask does not use one up', async () => {
    const face = vendorFace();
    const fake = fakeEngine(LIVE_CALL);
    const faceDeps = deps(face, { ...SESSION, provider: 'builtin', token: null, voicing: 'engine' });
    const controller = new CallFaceController(fake.asEngine, faceDeps);
    controller.request({ provider: 'fake', ventureId: VENTURE, callId: CALL, reducedMotion: false });
    await waitFor(() => {
      expect(controller.getSnapshot().status).toBe('unavailable');
    });
    // Another 150 refused tries (far past any bound) still leave the call able to ask.
    for (let n = 0; n < 150; n += 1) {
      controller.retry(CALL);
      await waitFor(() => {
        expect(faceDeps.startSession).toHaveBeenCalledTimes(n + 2);
      });
      await waitFor(() => {
        expect(controller.getSnapshot().status).toBe('unavailable');
      });
    }
    expect(controller.canAsk(CALL)).toBe(true);
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
      expect(controller.getSnapshot().status).toBe('paused');
    });
    expect(faceDeps.endFace).toHaveBeenCalledWith(CALL, { reason: 'on_hold' });
    expect(face.provider.unmount).toHaveBeenCalled();
    // Back from hold: a new session of the call.
    fake.setSnapshot({ ...LIVE_CALL, held: false });
    await waitFor(() => {
      expect(faceDeps.startSession).toHaveBeenCalledTimes(2);
    });
    expect(controller.getSnapshot().status).toBe('reconnecting');
  });

  it('waits for a slow vendor start past the join’s bound: the call’s one session is not given up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const face = vendorFace();
      const { asEngine, controller, faceDeps } = controllerWith(face);
      // As production on 2026-11-08: the server took 8.1–8.5 s to open the session.
      faceDeps.startSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(SESSION);
            }, 8_500);
          }),
      );
      renderWithRouter(stage({ controller, engine: asEngine }));
      await videoTileSays('Connecting to Thomas…', 'connecting');
      act(() => {
        vi.advanceTimersByTime(8_600);
      });
      await waitFor(() => {
        expect(face.provider.connect).toHaveBeenCalled();
      });
      act(() => {
        face.connect();
      });
      await screen.findByRole('figure');
      expect(faceDeps.endFace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a vendor start up only after its own bound', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const face = vendorFace();
      const { asEngine, controller, faceDeps } = controllerWith(face);
      faceDeps.startSession.mockImplementation(() => new Promise<AvatarSessionResponse>(() => undefined));
      renderWithRouter(stage({ controller, engine: asEngine }));
      await videoTileSays('Connecting to Thomas…', 'connecting');
      act(() => {
        vi.advanceTimersByTime(FACE_SESSION_TIMEOUT_MS + 100);
      });
      await videoTileSays('Video isn’t available right now', 'unavailable');
      expect(face.provider.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says video couldn’t start when the API offers no face or the face cannot connect', async () => {
    const noToken = vendorFace();
    const a = controllerWith(noToken, { ...SESSION, provider: 'builtin', token: null, voicing: 'engine' });
    const first = renderWithRouter(stage({ controller: a.controller, engine: a.asEngine }));
    await waitFor(() => {
      expect(a.faceDeps.startSession).toHaveBeenCalled();
    });
    expect(a.faceDeps.loadProvider).not.toHaveBeenCalled();
    await videoTileSays('Video isn’t available right now', 'unavailable');
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
    await videoTileSays('Video isn’t available right now', 'unavailable');
    // Where the join stopped (the adapter gave no stage: the room, the controller's own) and the page's plain code.
    expect(b.faceDeps.endFace).toHaveBeenCalledWith(CALL, {
      reason: 'connect_failed',
      stage: 'room',
      detail: 'refused',
    });
  });

  it('sends a library error as its name and reason only, never its message (which may hold a URL)', async () => {
    const refused = vendorFace({ joinStage: 'room' });
    const b = controllerWith(refused);
    renderWithRouter(stage({ controller: b.controller, engine: b.asEngine }));
    await waitFor(() => {
      expect(refused.provider.connect).toHaveBeenCalled();
    });
    // As LiveKit's ConnectionError: a name, a reason name, and a message that names the server.
    const error = Object.assign(
      new Error('could not connect to wss://room.example.test/rtc?access_token=abc'),
      {
        name: 'ConnectionError',
        reasonName: 'ServerUnreachable',
      },
    );
    act(() => {
      refused.fail(error);
    });
    await waitFor(() => {
      expect(b.faceDeps.endFace).toHaveBeenCalled();
    });
    expect(b.faceDeps.endFace).toHaveBeenCalledWith(CALL, {
      reason: 'connect_failed',
      stage: 'room',
      detail: 'ConnectionError.ServerUnreachable',
    });
    expect(JSON.stringify(vi.mocked(b.faceDeps.endFace).mock.calls)).not.toMatch(/wss:|access_token/);
  });

  it('gives up on a face that shows no frame in time, cancelling its join', async () => {
    // The adapter's own stage at the give-up (lab run 42112455038 could not tell a room that never joined from a
    // speak channel that never connected).
    const slow = vendorFace({ joinStage: 'control' });
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
    await videoTileSays('Video isn’t available right now', 'unavailable');
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(fake.engine.attachFace).not.toHaveBeenCalledWith(slow.renderer);
    expect(faceDeps.endFace).toHaveBeenCalledWith(CALL, {
      reason: 'connect_timeout',
      stage: 'control',
      detail: 'face_timeout',
    });
  });

  it('asks for no face before the call is live, and closes the face when the call ends', async () => {
    const face = vendorFace();
    const { asEngine, engine, controller, faceDeps, setSnapshot } = controllerWith(face);
    const view = renderWithRouter(stage({ controller, engine: asEngine, callId: null, state: 'connecting' }));
    await videoTileSays('Connecting to Thomas…', 'connecting');
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
