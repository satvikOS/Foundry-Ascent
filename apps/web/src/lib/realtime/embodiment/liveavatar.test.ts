import type { AvatarSessionResponse } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceRelay } from '../avatar';
import type { FaceRenderHandlers, FaceRendererOutput, FaceUnitAudio } from '../playback';
import { FakeAnalyser, FakeAudioContext, FakeGain, FakeMediaElement, FakeTrack, flush } from '../testing';
import { tapFaceAudio } from './face-media';
import {
  LIVEAVATAR_EVENTS_TOPIC,
  LiveAvatarFace,
  type FaceTapMode,
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
    const t = { kind, mediaStreamTrack: new FakeTrack(kind) as unknown as MediaStreamTrack };
    for (const l of handlers.track) l(t, participant);
    return t;
  };
  const event = (name: string) => {
    const payload = new TextEncoder().encode(JSON.stringify({ event_type: name, event_id: 'e1' }));
    for (const l of handlers.data) l(payload, LIVEAVATAR_EVENTS_TOPIC);
  };
  return { fake, connect, disconnect, track, event, handlers };
}

/** A stream as the adapter builds it (the fakes need only its tracks). */
function fakeStream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return { getTracks: () => [...tracks] } as unknown as MediaStream;
}

function setup() {
  const r = room();
  let level = 0;
  const tap = { level: () => level, mute: vi.fn((_muted: boolean) => undefined), disconnect: vi.fn() };
  const tapAudio = vi.fn((_track: MediaStreamTrack, _output: FaceRendererOutput, _mode: FaceTapMode) => tap);
  const element = new FakeMediaElement();
  const createMediaElement = vi.fn(() => element);
  let gesture: (() => void) | null = null;
  const deps: LiveAvatarDeps = {
    createRoom: () => r.fake,
    createStream: fakeStream,
    createMediaElement,
    tapAudio,
    onGesture: (callback) => {
      gesture = callback;
      return () => {
        gesture = null;
      };
    },
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
    element,
    createMediaElement,
    /** The founder clicks or presses a key on the page. */
    gesture: () => {
      gesture?.();
    },
    gestureArmed: () => gesture !== null,
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
  const audio = s.room.track('audio');
  const video = s.room.track('video');
  await connecting;
  await flush();
  return { audio: audio.mediaStreamTrack, video: video.mediaStreamTrack };
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
    // The face's audio is measured on the call's context (once), never routed into its output.
    expect(s.tapAudio).toHaveBeenCalledTimes(1);
    expect(s.tapAudio.mock.calls[0]?.[1]).toBe(s.output);
    expect(s.tapAudio.mock.calls[0]?.[2]).toBe('analyser');
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
    // Silent in the page at once, whatever the vendor still sends.
    expect(s.element.audible).toBe(false);
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

describe('LiveAvatarFace: the face is seen and heard together (one element, the browser keeps lips and voice in step)', () => {
  it('plays the avatar’s video and audio in one unmuted element; the thumbnail stream carries the video alone', async () => {
    const s = setup();
    const tracks = await joined(s);
    expect(s.createMediaElement).toHaveBeenCalledTimes(1);
    expect(s.face.media()).toBe(s.element);
    expect(s.element.tracks()).toEqual([tracks.video, tracks.audio]);
    expect(s.element.muted).toBe(false);
    expect(s.element.volume).toBe(1);
    expect(s.element.paused).toBe(false);
    expect(s.face.video()?.getTracks()).toEqual([tracks.video]);
    // Nothing is tapped before a unit needs it, and nothing ever plays through the call's output.
    expect(s.tapAudio).not.toHaveBeenCalled();
  });

  it('takes the audio into the same element when it arrives after the video', async () => {
    const s = setup();
    const connecting = s.face.connect(SESSION, new AbortController().signal, s.relay);
    await Promise.resolve();
    const video = s.room.track('video');
    await connecting;
    expect(s.element.tracks()).toEqual([video.mediaStreamTrack]);
    const audio = s.room.track('audio');
    await flush();
    expect(s.createMediaElement).toHaveBeenCalledTimes(1);
    expect(s.element.tracks()).toEqual([video.mediaStreamTrack, audio.mediaStreamTrack]);
    expect(s.element.audible).toBe(true);
  });

  it('ducks, silences on barge-in and turns the face up again for its next unit, on the element itself', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().setVolume?.(0.2);
    expect(s.element.volume).toBe(0.2);
    expect(s.element.muted).toBe(false);
    const stop = s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(0);
    s.speakLoud();
    await vi.advanceTimersByTimeAsync(40);
    stop();
    expect(s.element.muted).toBe(true);
    expect(s.element.volume).toBe(0);
    // The call's unduck after a barge-in does not make the interrupted face heard again.
    s.face.renderer().setVolume?.(1);
    expect(s.element.audible).toBe(false);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    expect(s.element.muted).toBe(false);
    expect(s.element.volume).toBe(1);
    expect(s.face.renderer().level?.()).toBeCloseTo(0.2);
  });

  it('a unit given back to the call silences the face first, so two voices never overlap', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(s.log).toEqual(['end failed']);
    expect(s.element.audible).toBe(false);
  });

  it('plays on when the browser pauses it, and stops for good when the face ends', async () => {
    const s = setup();
    await joined(s);
    const plays = s.element.plays;
    s.element.pause();
    expect(s.element.plays).toBe(plays + 1);
    expect(s.element.paused).toBe(false);
    s.face.unmount();
    expect(s.element.paused).toBe(true);
    expect(s.element.srcObject).toBeNull();
    expect(s.element.removed).toBe(true);
    expect(s.face.media()).toBeNull();
  });

  it('when the browser refuses the element’s sound, plays it muted and routes the voice into the call until a gesture', async () => {
    const s = setup();
    s.element.soundRefused = true;
    await joined(s);
    // The face still shows (muted playback is always allowed); the founder is not left without a voice.
    expect(s.element.muted).toBe(true);
    expect(s.element.paused).toBe(false);
    expect(s.gestureArmed()).toBe(true);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    expect(s.tapAudio.mock.calls.map((c) => c[2])).toEqual(['output']);
    // The founder's next click: the element sounds, and the copy in the call's output goes in the same moment.
    s.element.soundRefused = false;
    s.gesture();
    await flush();
    expect(s.element.muted).toBe(false);
    expect(s.element.audible).toBe(true);
    expect(s.tap.disconnect).toHaveBeenCalledTimes(1);
    expect(s.tapAudio.mock.calls.map((c) => c[2])).toEqual(['output', 'analyser']);
  });

  it('a face lost before a unit’s first sound gives the unit back at once, not after the onset timeout', async () => {
    const s = setup();
    await joined(s);
    s.face.renderer().render(s.buffer, s.output, s.handlers, s.audio);
    await vi.advanceTimersByTimeAsync(100);
    for (const l of s.room.handlers.disconnected) l();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.log).toEqual(['end failed']);
  });
});

describe('tapFaceAudio: the call measures the face’s sound without playing it', () => {
  function graph() {
    const context = new FakeAudioContext();
    const destination = new FakeGain();
    const output = {
      context: context as unknown as FaceRendererOutput['context'],
      destination: destination as unknown as AudioNode,
    };
    const stream = fakeStream([new FakeTrack('audio') as unknown as MediaStreamTrack]);
    return { context, destination, output, stream };
  }

  it('feeds an analyser connected to nothing: neither the call’s output nor the speakers get the face', () => {
    const g = graph();
    const hold = vi.fn(() => vi.fn());
    const tap = tapFaceAudio(g.stream, g.output, 'analyser', hold);
    const source = g.context.streamSources[0];
    expect(source?.stream).toBe(g.stream);
    expect(source?.node.connections).toHaveLength(1);
    const analyser = source?.node.connections[0];
    expect(analyser).toBeInstanceOf(FakeAnalyser);
    expect(analyser?.connections).toEqual([]);
    expect(g.destination.connections).toEqual([]);
    expect(g.context.destination.connections).toEqual([]);
    // The element holds and plays the track: no second holder.
    expect(hold).not.toHaveBeenCalled();
    (analyser as FakeAnalyser).level = 0.1;
    expect(tap.level()).toBeCloseTo(0.1);
    tap.disconnect();
    expect(source?.node.connections).toEqual([]);
  });

  it('routes the voice into the call’s output only as the fallback, through a gain barge-in can close', () => {
    const g = graph();
    const release = vi.fn();
    const tap = tapFaceAudio(g.stream, g.output, 'output', () => release);
    const source = g.context.streamSources[0];
    const gain = g.context.gains[0];
    expect(source?.node.connections).toEqual([expect.any(FakeAnalyser), gain]);
    expect(gain?.connections).toEqual([g.destination]);
    tap.mute?.(true);
    expect(gain?.gain.value).toBe(0);
    tap.mute?.(false);
    expect(gain?.gain.value).toBe(1);
    tap.disconnect();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
