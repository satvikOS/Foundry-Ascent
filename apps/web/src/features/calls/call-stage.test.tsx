import type { AvatarSessionResponse } from '@foundry/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarProvider, FaceRenderer } from '@/lib/realtime/avatar';

import { CallStage } from './call-stage';
import { fakeEngine, json, renderWithRouter, stubFetch } from './testing';
import type { CallFaceDeps } from './use-call-face';
import type { CallVeir } from './use-call-veir';

const VENTURE = '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01';
const CALL = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const SESSION: AvatarSessionResponse = {
  provider: 'fake',
  token: 'fake.session-1',
  expiresAt: '2026-10-17T12:01:00.000Z',
  voiceId: 'Matthew',
  voicing: 'audio',
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
      (_session: AvatarSessionResponse, _signal: AbortSignal) =>
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
  return {
    startSession: vi.fn((_venture: string, _call: string, _signal: AbortSignal) => Promise.resolve(session)),
    loadProvider: vi.fn(() => Promise.resolve(face.provider as AvatarProvider)),
    connectTimeoutMs: 8_000,
  } satisfies CallFaceDeps;
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
    const { asEngine, engine } = fakeEngine();
    const face = vendorFace();
    const faceDeps = deps(face);
    renderWithRouter(
      <CallStage
        veir={veir('builtin')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={faceDeps}
      />,
    );
    await presenceShown();
    expect(faceDeps.startSession).not.toHaveBeenCalled();
    expect(engine.attachFace).not.toHaveBeenCalled();
  });

  it('becomes a video tile once the vendor face shows its first frame, and hands it the call’s audio', async () => {
    const { asEngine, engine } = fakeEngine();
    const face = vendorFace();
    const faceDeps = deps(face);
    const onVideoChange = vi.fn();
    const { container } = renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="speaking"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={faceDeps}
        onVideoChange={onVideoChange}
      />,
    );
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    expect(faceDeps.startSession).toHaveBeenCalledWith(VENTURE, CALL, expect.any(AbortSignal));
    expect(face.provider.connect.mock.calls[0]?.[0]).toEqual(SESSION);
    // Until the first frame, the presence is the face.
    await presenceShown();
    expect(engine.attachFace).not.toHaveBeenCalledWith(face.renderer);

    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    // The same tile, now a video: speaking edge and name tag unchanged.
    const tile = container.querySelector('[data-slot="call-tile"]');
    expect(tile).toHaveAttribute('data-face', 'video');
    expect(tile).toHaveAttribute('data-speaking', 'true');
    expect(container.querySelector('[data-slot="call-name-tag"]')).toHaveTextContent('Corin');
    expect(container.querySelector('[data-slot="call-stage"]')).toBeNull();
    const video = container.querySelector<HTMLVideoElement>('[data-slot="call-video"]');
    expect(video?.muted).toBe(true);
    expect(video?.srcObject).toBe(face.stream);
    expect(engine.attachFace).toHaveBeenLastCalledWith(face.renderer);
    expect(onVideoChange).toHaveBeenLastCalledWith(true);
    // The face follows the call's state.
    expect(face.provider.setState).toHaveBeenCalledWith('speaking');
  });

  it('goes back to the presence, quietly, when the face drops mid-call', async () => {
    const { asEngine, engine } = fakeEngine();
    const face = vendorFace();
    const onVideoChange = vi.fn();
    renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={deps(face)}
        onVideoChange={onVideoChange}
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
      face.lose();
    });
    await presenceShown();
    expect(engine.attachFace).toHaveBeenLastCalledWith(null);
    expect(face.provider.unmount).toHaveBeenCalled();
    expect(onVideoChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the presence when the API offers no face or the face cannot connect', async () => {
    const { asEngine } = fakeEngine();
    const noToken = vendorFace();
    const noTokenDeps = deps(noToken, { ...SESSION, provider: 'builtin', token: null, voicing: 'engine' });
    const first = renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={noTokenDeps}
      />,
    );
    await waitFor(() => {
      expect(noTokenDeps.startSession).toHaveBeenCalled();
    });
    expect(noTokenDeps.loadProvider).not.toHaveBeenCalled();
    await presenceShown();
    first.unmount();

    const refused = vendorFace();
    renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={deps(refused)}
      />,
    );
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
  });

  it('gives up on a face that shows no frame in time', async () => {
    const { asEngine, engine } = fakeEngine();
    const slow = vendorFace();
    renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={{ ...deps(slow), connectTimeoutMs: 30 }}
      />,
    );
    await waitFor(() => {
      expect(slow.provider.unmount).toHaveBeenCalled();
    });
    // The vendor's join is cancelled, so no session goes on (and bills) unseen.
    expect(slow.provider.connect.mock.calls[0]?.[1].aborted).toBe(true);
    // A frame arriving after the deadline changes nothing.
    act(() => {
      slow.connect();
    });
    await presenceShown();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(engine.attachFace).not.toHaveBeenCalledWith(slow.renderer);
  });

  it('asks for no face before the call is live, and closes the face when the call ends', async () => {
    const { asEngine, engine } = fakeEngine();
    const face = vendorFace();
    const faceDeps = deps(face);
    const view = renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="connecting"
        ventureId={VENTURE}
        callId={null}
        faceDeps={faceDeps}
      />,
    );
    await presenceShown();
    expect(faceDeps.startSession).not.toHaveBeenCalled();
    view.unmount();

    const live = renderWithRouter(
      <CallStage
        veir={veir('fake')}
        engine={asEngine}
        state="listening"
        ventureId={VENTURE}
        callId={CALL}
        faceDeps={faceDeps}
      />,
    );
    await waitFor(() => {
      expect(face.provider.connect).toHaveBeenCalled();
    });
    act(() => {
      face.connect();
    });
    await screen.findByRole('figure');
    const signal = faceDeps.startSession.mock.calls[0]?.[2];
    live.unmount();
    expect(signal?.aborted).toBe(true);
    expect(face.provider.unmount).toHaveBeenCalled();
    expect(engine.attachFace).toHaveBeenLastCalledWith(null);
  });
});
