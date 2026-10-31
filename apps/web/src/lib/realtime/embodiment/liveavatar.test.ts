import type { AvatarSessionResponse } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceRelay } from '../avatar';
import type { FaceRenderHandlers, FaceRendererOutput, FaceUnitAudio } from '../playback';
import { FakeAudioContext, FakeGain, FakeTrack } from '../testing';
import {
  LIVEAVATAR_EVENTS_TOPIC,
  LiveAvatarFace,
  type FaceAudioTap,
  type LiveAvatarDeps,
  type LiveAvatarRoom,
  type RoomTrack,
} from './liveavatar';

const SESSION: AvatarSessionResponse = {
  provider: 'heygen',
  token: 'eyJ.client.token',
  expiresAt: '2026-10-17T12:20:00.000Z',
  voiceId: 'Matthew',
  voicing: 'audio',
  url: 'wss://heygen-feapbkvq.livekit.cloud',
  stockFace: false,
};

/** A room the test drives: tracks arrive, data arrives, it disconnects. Nothing can be published from it. */
function room() {
  const handlers = {
    track: [] as ((track: RoomTrack, participant: string) => void)[],
    gone: [] as ((track: RoomTrack) => void)[],
    disconnected: [] as (() => void)[],
    data: [] as ((payload: Uint8Array, topic: string | undefined) => void)[],
  };
  const connect = vi.fn((_url: string, _token: string) => Promise.resolve());
  const disconnect = vi.fn();
  const fake: LiveAvatarRoom = {
    connect,
    disconnect,
    onTrack: (l) => handlers.track.push(l),
    onTrackGone: (l) => handlers.gone.push(l),
    onDisconnected: (l) => handlers.disconnected.push(l),
    onData: (l) => handlers.data.push(l),
    publish: vi.fn(() => Promise.reject(new Error('a LITE face never publishes'))),
  };
  const track = (kind: 'audio' | 'video', participant = 'heygen') => {
    const t = { kind, mediaStreamTrack: new FakeTrack() as unknown as MediaStreamTrack };
    for (const l of handlers.track) l(t, participant);
    return t;
  };
  const event = (name: string) => {
    const payload = new TextEncoder().encode(JSON.stringify({ event_type: name, event_id: 'e1' }));
    for (const l of handlers.data) l(payload, LIVEAVATAR_EVENTS_TOPIC);
  };
  return { fake, connect, disconnect, track, event, handlers };
}

function setup() {
  const r = room();
  let level = 0;
  const tap: FaceAudioTap = { level: () => level, disconnect: vi.fn() };
  const tapAudio = vi.fn((_track: MediaStreamTrack, _output: FaceRendererOutput) => tap);
  const deps: LiveAvatarDeps = {
    createRoom: () => r.fake,
    createStream: (tracks) => ({ getTracks: () => tracks }) as unknown as MediaStream,
    tapAudio,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const relayed: FaceUnitAudio[] = [];
  let refuse = false;
  const relay = {
    speak: vi.fn((audio: FaceUnitAudio, _signal: AbortSignal) => {
      relayed.push(audio);
      return refuse ? Promise.reject(new Error('refused')) : Promise.resolve();
    }),
    interrupt: vi.fn(),
  } satisfies FaceRelay;
  const output = {
    context: new FakeAudioContext() as unknown as FaceRendererOutput['context'],
    destination: new FakeGain() as unknown as AudioNode,
  };
  const log: string[] = [];
  const handlers: FaceRenderHandlers = {
    onStart: () => log.push('start'),
    onEnd: (outcome) => log.push(`end ${outcome}`),
  };
  const audio: FaceUnitAudio = { pcm: new Uint8Array(96), manifest: 'fa1.k1.p.m' };
  return {
    room: r,
    face: new LiveAvatarFace(deps),
    tapAudio,
    tap,
    relay,
    relayed,
    output,
    log,
    handlers,
    audio,
    buffer: { duration: 1 } as AudioBuffer,
    speakLoud: () => {
      level = 0.2;
    },
    refuse: () => {
      refuse = true;
    },
  };
}

/** Joins the room and shows the avatar's tracks. */
async function joined(s: ReturnType<typeof setup>) {
  const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
  await Promise.resolve();
  s.room.track('audio');
  s.room.track('video');
  await connecting;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiveAvatarFace (HeyGen LiveAvatar, LITE: the browser only watches)', () => {
  it('joins only a LiveAvatar room with its token, and goes live at the avatar’s first video', async () => {
    const s = setup();
    await expect(
      s.face.connect({ ...SESSION, provider: 'fake' }, new AbortController().signal, s.relay),
    ).rejects.toThrow(/not_liveavatar_session/);
    await expect(
      s.face.connect({ ...SESSION, url: null }, new AbortController().signal, s.relay),
    ).rejects.toThrow();

    const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
    await Promise.resolve();
    expect(s.room.connect).toHaveBeenCalledWith('wss://heygen-feapbkvq.livekit.cloud', 'eyJ.client.token');
    // Another participant's video is not the face.
    s.room.track('video', 'someone-else');
    expect(s.face.renderer().ready()).toBe(false);
    s.room.track('video');
    await connecting;
    expect(s.face.renderer().ready()).toBe(true);
    expect(s.face.video()?.getTracks()).toHaveLength(1);
  });

  it('gives up when no video comes in time, or the call closes it', async () => {
    const s = setup();
    const late = s.face.connect(SESSION, new AbortController().signal, s.relay);
    const expectation = expect(late).rejects.toThrow(/face_no_video/);
    await vi.advanceTimersByTimeAsync(8_000);
    await expectation;
    expect(s.room.disconnect).toHaveBeenCalled();

    const t = setup();
    const controller = new AbortController();
    const closed = t.face.connect(SESSION, controller.signal, t.relay);
    controller.abort();
    await expect(closed).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('renders a unit by relaying it through the server, and counts it heard from the face’s first sound', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    expect(s.relayed).toEqual([s.audio]);
    // The face's audio plays into the call's own output (once).
    expect(s.tapAudio).toHaveBeenCalledTimes(1);
    expect(s.tapAudio.mock.calls[0]?.[1]).toBe(s.output);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.log).toEqual([]);
    s.speakLoud();
    await vi.advanceTimersByTimeAsync(40);
    expect(s.log).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(s.log).toEqual(['start', 'end ended']);
  });

  it('follows the vendor’s own speak events when the room carries them', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(0);
    s.room.event('avatar.speak_started');
    expect(s.log).toEqual(['start']);
    s.room.event('avatar.speak_ended');
    expect(s.log).toEqual(['start', 'end ended']);
  });

  it('gives a unit back to the call when the server gave the face nothing, refused it, or the face stays silent', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().render(s.buffer, s.output, s.handlers, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.relay.speak).not.toHaveBeenCalled();
    expect(s.log).toEqual(['end failed']);

    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(3_100);
    // Silent face: the server is told to drop it, so the call's own playback never doubles it.
    expect(s.log).toEqual(['end failed', 'end failed']);
    expect(s.relay.interrupt).toHaveBeenCalledTimes(1);

    s.refuse();
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.log).toEqual(['end failed', 'end failed', 'end failed']);
  });

  it('stops a unit at once on barge-in (the server tells the face), without reporting an end', async () => {
    const s = setup();
    await joined(s);
    const stop = s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(0);
    s.speakLoud();
    await vi.advanceTimersByTimeAsync(40);
    stop();
    expect(s.relay.interrupt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.log).toEqual(['start']);
  });

  it('tells the call when the room goes away or the video ends, and releases everything when unmounted', async () => {
    const s = setup();
    const lost = vi.fn();
    s.face.onLost(lost);
    await joined(s);
    for (const l of s.room.handlers.disconnected) l();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(s.face.renderer().ready()).toBe(false);
    s.face.unmount();
    expect(s.room.disconnect).toHaveBeenCalled();
    expect(s.face.video()).toBeNull();
  });
});
