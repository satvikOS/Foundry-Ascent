import type { RecordingView } from '@foundry/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';
import { LIVE } from '@/features/calls/testing';
import type { CallSnapshot } from '@/lib/realtime/call-state';

import { RecordingPlayer } from './recording-player';

/** The call the player sees (the page's call context), changed by each test. */
const call = vi.hoisted(() => ({
  current: null as null | { engine: { hold: () => void }; snapshot: CallSnapshot },
}));
vi.mock('@/features/calls/call-context', () => ({ useOptionalCall: () => call.current }));

const RECORDING: RecordingView = {
  id: '55555555-5555-4555-8555-555555555555',
  callId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ventureId: '33333333-3333-4333-8333-333333333333',
  conversationTitle: 'Pilot pricing',
  mimeType: 'video/webm',
  kind: 'video',
  bytes: 4_096,
  durationMs: 125_000,
  hasCaptions: false,
  status: 'ready',
  createdAt: '2026-11-06T12:00:00.000Z',
  completedAt: '2026-11-06T12:00:05.000Z',
};

/** The player, rendered again whenever the test changes the call (`changeCall`). */
const rerender = { now: (): void => undefined };
function Player() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  rerender.now = bump;
  return <RecordingPlayer recording={RECORDING} autoPlay />;
}

function changeCall(next: typeof call.current): void {
  call.current = next;
  act(() => {
    rerender.now();
  });
}

function servePlayback() {
  stubFetch().mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        recording: RECORDING,
        media: { url: 'https://recordings.test/call.webm?sig=1', expiresAt: '2026-11-06T13:00:00.000Z' },
        captions: null,
      }),
    ),
  );
}

async function replay(): Promise<HTMLVideoElement> {
  await waitFor(() => {
    expect(document.querySelector('video[data-slot="recording-video"]')).not.toBeNull();
  });
  const video = document.querySelector<HTMLVideoElement>('video[data-slot="recording-video"]');
  if (video === null) throw new Error('no replay');
  return video;
}

afterEach(() => {
  call.current = null;
  vi.unstubAllGlobals();
});

describe('RecordingPlayer during a live call', () => {
  it('plays at once when no call is live', async () => {
    servePlayback();
    renderWithProviders(<RecordingPlayer recording={RECORDING} autoPlay />);
    expect((await replay()).autoplay).toBe(true);
    expect(document.querySelector('[data-slot="recording-on-call"]')).toBeNull();
  });

  it('waits to be played, holds the voice call when played, and pauses when the microphone opens again', async () => {
    servePlayback();
    const hold = vi.fn();
    call.current = { engine: { hold }, snapshot: { ...LIVE, input: 'voice' } };
    renderWithProviders(<Player />);
    const video = await replay();
    expect(video.autoplay).toBe(false);
    expect(screen.getByText('Playing this puts your call on hold.')).toBeVisible();

    video.dispatchEvent(new Event('play'));
    expect(hold).toHaveBeenCalledOnce();

    // On hold while it plays; then the founder resumes the call: the replay pauses.
    let playing = true;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => !playing });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
      playing = false;
    });
    changeCall({ engine: { hold }, snapshot: { ...LIVE, input: 'voice', held: true, muted: true } });
    expect(pause).not.toHaveBeenCalled();
    changeCall({ engine: { hold }, snapshot: { ...LIVE, input: 'voice', held: false, muted: false } });
    expect(pause).toHaveBeenCalledOnce();
  });

  it('on a typed call it only waits to be played (there is no microphone to hold)', async () => {
    servePlayback();
    const hold = vi.fn();
    call.current = { engine: { hold }, snapshot: { ...LIVE, input: 'typed' } };
    renderWithProviders(<RecordingPlayer recording={RECORDING} autoPlay />);
    const video = await replay();
    expect(video.autoplay).toBe(false);
    video.dispatchEvent(new Event('play'));
    expect(hold).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="recording-on-call"]')).toBeNull();
  });
});
