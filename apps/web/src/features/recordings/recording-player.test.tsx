import type { RecordingView } from '@foundry/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('RecordingPlayer: the transcript follows the replay', () => {
  const VTT = [
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:00:02.000',
    '<v.veir Thomas>What changed this week?',
    '',
    '2',
    '00:00:03.000 --> 00:00:05.000',
    '<v.founder Maya>We ran the pilot.',
    '',
  ].join('\n');

  /** A media element whose time the test moves (jsdom plays nothing). */
  function controllable(video: HTMLVideoElement) {
    const state = { time: 0, paused: true };
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => state.time,
      set: (value: number) => {
        state.time = value;
        video.dispatchEvent(new Event('seeked'));
      },
    });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 60 });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => state.paused });
    const play = vi.spyOn(video, 'play').mockImplementation(() => {
      state.paused = false;
      return Promise.resolve();
    });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
      state.paused = true;
    });
    return { state, play, pause };
  }

  it('marks the line being heard, jumps to a line when it is pressed, and answers K, J and L', async () => {
    stubFetch().mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://recordings.test/captions.vtt'))
        return Promise.resolve(new Response(VTT, { status: 200 }));
      return Promise.resolve(
        jsonResponse({
          recording: { ...RECORDING, hasCaptions: true },
          media: { url: 'https://recordings.test/call.webm?sig=1', expiresAt: '2026-11-06T13:00:00.000Z' },
          captions: {
            url: 'https://recordings.test/captions.vtt?sig=1',
            expiresAt: '2026-11-06T13:00:00.000Z',
          },
        }),
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<RecordingPlayer recording={{ ...RECORDING, hasCaptions: true }} />);
    const video = await replay();
    const { state, play, pause } = controllable(video);
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    await waitFor(() => {
      expect(within(transcript).getAllByRole('button')).toHaveLength(2);
    });
    const [thomas, maya] = within(transcript).getAllByRole('button');
    if (thomas === undefined || maya === undefined) throw new Error('no transcript lines');

    act(() => {
      state.time = 3.5;
      video.dispatchEvent(new Event('timeupdate'));
    });
    expect(maya).toHaveAttribute('aria-current', 'true');
    expect(thomas).not.toHaveAttribute('aria-current');
    expect(document.querySelector('[data-slot="recording-captions"]')).toHaveTextContent(
      'Maya: We ran the pilot.',
    );

    await user.click(thomas);
    expect(state.time).toBe(0);
    expect(play).toHaveBeenCalledOnce();
    expect(thomas).toHaveAttribute('aria-current', 'true');

    await user.keyboard('l');
    expect(state.time).toBe(10);
    await user.keyboard('j');
    expect(state.time).toBe(0);
    await user.keyboard('k');
    expect(pause).toHaveBeenCalledOnce();
    await user.keyboard('k');
    expect(play).toHaveBeenCalledTimes(2);
  });
});
