import type { AvatarSessionResponse } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceLoss, FaceRelay } from '../avatar';
import type { FaceRenderHandlers, FaceRendererOutput, SpeechUnitToPlay } from '../playback';
import { FakeAudioContext, FakeGain, FakeMediaElement, FakeTrack, flush } from '../testing';
import { FakeLiteSocket } from './fake-lite-socket';
import {
  LiveAvatarFace,
  type FaceTapMode,
  type LiveAvatarDeps,
  type LiveAvatarRoom,
  type RoomTrack,
} from './liveavatar';

/*
 * A LITE stock face the page feeds (docs/architecture/calls.md §4.4): the adapter joins the vendor's room, then opens
 * the speak channel the API handed it and goes live only once the vendor said `connected`; it then says the call's
 * units itself (voicing `stream`) in the face's one element, and a channel that drops ends the face.
 */

const WS = 'wss://webrtc-signaling.heygen.io/s/interactive-avatar/session/s';
const SESSION: AvatarSessionResponse = {
  provider: 'heygen',
  token: 'eyJ.client.token',
  expiresAt: '2026-11-05T12:20:00.000Z',
  voiceId: null,
  voicing: 'audio',
  url: 'wss://heygen-feapbkvq.livekit.cloud',
  stockFace: true,
  controlUrl: WS,
};
const TURN = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';

function setup(options: { behaviour?: 'normal' | 'refuse' } = {}) {
  const listeners = { track: [] as ((track: RoomTrack, participant: string) => void)[] };
  const disconnect = vi.fn();
  const room: LiveAvatarRoom = {
    connect: vi.fn(() => Promise.resolve()),
    disconnect,
    onTrack: (l) => listeners.track.push(l),
    onTrackGone: () => undefined,
    onDisconnected: () => undefined,
    onData: () => undefined,
    publish: vi.fn(() => Promise.reject(new Error('the LITE page publishes nothing to the room'))),
  };
  const sockets: FakeLiteSocket[] = [];
  const opened: string[] = [];
  const element = new FakeMediaElement();
  const tapAudio = vi.fn((_track: MediaStreamTrack, _output: FaceRendererOutput, _mode: FaceTapMode) => ({
    level: () => 0,
    mute: vi.fn(),
    disconnect: vi.fn(),
  }));
  const deps: LiveAvatarDeps = {
    createRoom: () => room,
    createStream: (tracks) => ({ getTracks: () => [...tracks] }) as unknown as MediaStream,
    createMediaElement: () => element,
    tapAudio,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    now: () => Date.now(),
    openLiteSocket: (url) => {
      opened.push(url);
      const socket = new FakeLiteSocket({
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => {
          clearTimeout(h as ReturnType<typeof setTimeout>);
        },
        now: () => Date.now(),
        startDelayMs: 300,
        ...(options.behaviour === undefined ? {} : { behaviour: options.behaviour }),
      });
      sockets.push(socket);
      return socket;
    },
  };
  const relay = {
    speak: vi.fn(() => Promise.reject(new Error('the relay is not this face’s route'))),
    say: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(),
  } satisfies FaceRelay;
  const face = new LiveAvatarFace(deps);
  const losses: FaceLoss[] = [];
  face.onLost((loss) => losses.push(loss));
  const track = (kind: 'audio' | 'video') => {
    const t = { kind, mediaStreamTrack: new FakeTrack(kind) as unknown as MediaStreamTrack };
    for (const l of listeners.track) l(t, 'heygen');
  };
  const output = {
    context: new FakeAudioContext() as unknown as FaceRendererOutput['context'],
    destination: new FakeGain() as unknown as AudioNode,
  };
  return { face, room, disconnect, sockets, opened, element, tapAudio, relay, losses, track, output };
}

async function joined(s: ReturnType<typeof setup>): Promise<void> {
  const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
  await Promise.resolve();
  s.track('audio');
  s.track('video');
  await vi.advanceTimersByTimeAsync(10);
  await connecting;
}

function pcm(ms: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(Math.round(ms * 24) * 2).fill(1));
      c.close();
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // 20 minutes before the session's end.
  vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiveAvatarFace: a LITE stock face the page feeds', () => {
  it('opens the speak channel once the room joined, and is live only once the vendor said connected', async () => {
    const s = setup();
    const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
    await Promise.resolve();
    expect(s.opened).toEqual([]);
    s.track('audio');
    s.track('video');
    await flush();
    // One socket for the call, at the URL the API handed this call.
    expect(s.opened).toEqual([WS]);
    expect(s.face.renderer().ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await connecting;
    const renderer = s.face.renderer();
    expect(renderer.voicing).toBe('stream');
    expect(renderer.ready()).toBe(true);
    expect(s.face.liteReport()).toMatchObject({ utterances: 0 });
  });

  it('gives the face up when its speak channel never connects (the call keeps the presence)', async () => {
    const s = setup({ behaviour: 'refuse' });
    const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
    const failed = expect(connecting).rejects.toThrow('face_control_timeout');
    await Promise.resolve();
    s.track('audio');
    s.track('video');
    await vi.advanceTimersByTimeAsync(5_100);
    await failed;
    expect(s.disconnect).toHaveBeenCalled();
    expect(s.sockets[0]?.readyState).toBe(3);
  });

  it('says the call’s units in its own element only, and silences it at once on barge-in until the next turn', async () => {
    const s = setup();
    await joined(s);
    const renderer = s.face.renderer();
    const unit: SpeechUnitToPlay = {
      turnId: TURN,
      seq: 0,
      text: 'Hello.',
      sig: 'sig-0-0123456789abcdef',
      faceApproved: true,
    };
    expect(renderer.feed?.(unit, pcm(2_000), 24_000)).toBe(true);
    const log: string[] = [];
    const handlers: FaceRenderHandlers = {
      onStart: () => log.push('start'),
      onEnd: (outcome) => log.push(`end ${outcome}`),
    };
    const stop = renderer.render(null, s.output, handlers, null, unit);
    await vi.advanceTimersByTimeAsync(0);
    // The face's sound is measured on the call's context, never routed into the call's output.
    expect(s.tapAudio.mock.calls[0]?.[2]).toBe('analyser');
    expect(s.sockets[0]?.utterances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(log).toEqual(['start']);
    expect(s.element.muted).toBe(false);
    stop();
    expect(s.element.muted).toBe(true);
    expect(s.sockets[0]?.count('agent.interrupt')).toBe(1);
    // The server hears of it (bookkeeping only).
    expect(s.relay.interrupt).toHaveBeenCalledTimes(1);
    // The server's relay is never used for this face.
    expect(s.relay.speak).not.toHaveBeenCalled();
  });

  it('ends the face when the vendor closes its speak channel, giving back what was not heard', async () => {
    const s = setup();
    await joined(s);
    const renderer = s.face.renderer();
    const unit: SpeechUnitToPlay = {
      turnId: TURN,
      seq: 0,
      text: 'Hello.',
      sig: 'sig-0-0123456789abcdef',
      faceApproved: true,
    };
    renderer.feed?.(unit, pcm(1_000), 24_000);
    const log: string[] = [];
    renderer.render(
      null,
      s.output,
      {
        onStart: () => log.push('start'),
        onEnd: (outcome) => log.push(`end ${outcome}`),
      },
      null,
      unit,
    );
    await vi.advanceTimersByTimeAsync(100);
    s.sockets[0]?.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['end failed']);
    expect(s.losses).toEqual([{ reason: 'control_lost' }]);
    expect(renderer.ready()).toBe(false);
  });

  it('hands over between turns once the session’s expiresAt is too close for the next turn (time_limit)', async () => {
    const s = setup();
    await joined(s);
    // Five seconds before the session's end (expiresAt 12:20): the next turn would outlast it.
    vi.setSystemTime(new Date('2026-11-05T12:19:55.000Z'));
    const renderer = s.face.renderer();
    const unit: SpeechUnitToPlay = {
      turnId: TURN,
      seq: 0,
      text: 'Hello.',
      sig: 'sig-0-0123456789abcdef',
      faceApproved: true,
    };
    expect(renderer.feed?.(unit, pcm(1_000), 24_000)).toBe(true);
    const log: string[] = [];
    renderer.render(
      null,
      s.output,
      { onStart: () => log.push('start'), onEnd: (outcome) => log.push(`end ${outcome}`) },
      null,
      unit,
    );
    await vi.advanceTimersByTimeAsync(10);
    // The call says the turn from its start; nothing went to the vendor.
    expect(log).toEqual(['end failed']);
    expect(s.sockets[0]?.utterances).toHaveLength(0);
    expect(s.losses).toEqual([{ reason: 'time_limit' }]);
  });

  it('leaves the limit to the vendor when this device’s clock is already past expiresAt (skew)', async () => {
    vi.setSystemTime(new Date('2026-11-05T13:00:00.000Z'));
    const s = setup();
    await joined(s);
    const renderer = s.face.renderer();
    const unit: SpeechUnitToPlay = {
      turnId: TURN,
      seq: 0,
      text: 'Hello.',
      sig: 'sig-0-0123456789abcdef',
      faceApproved: true,
    };
    renderer.feed?.(unit, pcm(1_000), 24_000);
    renderer.render(null, s.output, { onStart: () => undefined, onEnd: () => undefined }, null, unit);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.sockets[0]?.utterances).toHaveLength(1);
    expect(s.losses).toEqual([]);
  });
});
