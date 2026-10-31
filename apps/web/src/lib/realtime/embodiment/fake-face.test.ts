import type { AvatarSessionResponse } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceRelay } from '../avatar';
import type { FaceRenderHandlers, FaceRendererOutput, FaceUnitAudio } from '../playback';
import { FakeAudioContext, FakeGain, FakeTrack } from '../testing';
import { FakeFaceAvatar, type FakeFaceDeps } from './fake-face';

const SESSION: AvatarSessionResponse = {
  provider: 'fake',
  token: 'fake.session-1',
  expiresAt: '2026-10-17T12:01:00.000Z',
  voiceId: 'Matthew',
  voicing: 'audio',
  url: null,
  stockFace: false,
};

function setup() {
  const tracks = [new FakeTrack()];
  const stream = {
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
  const frames: ((time: number) => void)[] = [];
  // jsdom draws nothing (no 2D context): the face still connects, streams and renders audio.
  const createCanvas = vi.fn(
    (width: number, height: number) =>
      ({ width, height, getContext: () => null }) as unknown as HTMLCanvasElement,
  );
  const captureStream = vi.fn((_canvas: HTMLCanvasElement, _fps: number) => stream);
  const cancelFrame = vi.fn();
  const deps: FakeFaceDeps = {
    createCanvas,
    captureStream,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    connectMs: 500,
    renderMs: 120,
  };
  const face = new FakeFaceAvatar(deps);
  const context = new FakeAudioContext();
  const output = {
    context: context as unknown as FaceRendererOutput['context'],
    destination: new FakeGain() as unknown as AudioNode,
  };
  const buffer = { duration: 1.5 } as AudioBuffer;
  const audio: FaceUnitAudio = { pcm: new Uint8Array(48), manifest: 'fa1.k.p.m' };
  const relayed: FaceUnitAudio[] = [];
  let refuse = false;
  const relay = {
    speak: vi.fn((unit: FaceUnitAudio, _signal: AbortSignal) => {
      relayed.push(unit);
      return refuse ? Promise.reject(new Error('refused')) : Promise.resolve();
    }),
    interrupt: vi.fn(),
  } satisfies FaceRelay;
  const log: string[] = [];
  const handlers: FaceRenderHandlers = {
    onStart: () => log.push('start'),
    onEnd: (outcome) => log.push(`end ${outcome}`),
  };
  return {
    face,
    createCanvas,
    captureStream,
    cancelFrame,
    tracks,
    stream,
    frames,
    context,
    output,
    buffer,
    log,
    handlers,
    audio,
    relay,
    relayed,
    refuseRelay: () => {
      refuse = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FakeFaceAvatar (the development stand-in face)', () => {
  it('is a face that renders the call’s own audio', () => {
    const { face } = setup();
    expect(face).toMatchObject({ id: 'fake', drawsFace: true, voicing: 'audio' });
  });

  it('opens only a stand-in session, after the join delay, and then streams video', async () => {
    const { face, stream, captureStream, relay } = setup();
    await expect(
      face.connect({ ...SESSION, token: 'heygen.abc' }, new AbortController().signal, setup().relay),
    ).rejects.toThrow(/stand_in/);
    await expect(
      face.connect({ ...SESSION, token: null }, new AbortController().signal, setup().relay),
    ).rejects.toThrow();

    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(499);
    expect(face.video()).toBeNull();
    expect(face.renderer().ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await connected;
    expect(face.video()).toBe(stream);
    expect(face.renderer().ready()).toBe(true);
    expect(captureStream).toHaveBeenCalledWith(expect.objectContaining({ width: 640, height: 360 }), 30);
  });

  it('gives up at once when the call closes it while it connects', async () => {
    const { face, createCanvas, relay } = setup();
    const controller = new AbortController();
    const connected = face.connect(SESSION, controller.signal, relay);
    controller.abort();
    await expect(connected).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(createCanvas).not.toHaveBeenCalled();
    expect(face.video()).toBeNull();
  });

  it('never starts a face that was unmounted while it joined', async () => {
    const { face, createCanvas, relay } = setup();
    void face.connect(SESSION, new AbortController().signal, relay).catch(() => undefined);
    face.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(createCanvas).not.toHaveBeenCalled();
    expect(face.video()).toBeNull();
  });

  it('plays a unit into the call’s own output after its render delay, and reports its start and end', async () => {
    const { face, context, output, buffer, log, handlers, audio, relay, relayed } = setup();
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    face.renderer().render(buffer, output, handlers, audio);
    // The server got exactly this unit's audio to check and relay; the face renders only after it accepted.
    expect(relayed).toEqual([audio]);
    await vi.advanceTimersByTimeAsync(119);
    expect(context.sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['start']);
    const source = context.sources[0];
    expect(source?.started).toBe(true);
    expect(source?.connections).toContain(output.destination);
    source?.finish();
    expect(log).toEqual(['start', 'end ended']);
  });

  it('stops a unit at once (barge-in), before or after its first sound, without reporting an end', async () => {
    const { face, context, output, buffer, log, handlers, audio, relay } = setup();
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    const early = face.renderer().render(buffer, output, handlers, audio);
    early();
    await vi.advanceTimersByTimeAsync(500);
    expect(context.sources).toHaveLength(0);

    const late = face.renderer().render(buffer, output, handlers, audio);
    await vi.advanceTimersByTimeAsync(120);
    late();
    expect(context.sources[0]?.stopped).toBe(true);
    // The server tells the face to drop what it still had to say.
    expect(relay.interrupt).toHaveBeenCalledTimes(1);
    context.sources[0]?.finish();
    expect(log).toEqual(['start']);
  });

  it('gives a unit back to the call when the server gave the face nothing, or refused it', async () => {
    const { face, context, output, buffer, log, handlers, audio, relay, refuseRelay } = setup();
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;
    face.renderer().render(buffer, output, handlers, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.speak).not.toHaveBeenCalled();
    expect(log).toEqual(['end failed']);
    refuseRelay();
    face.renderer().render(buffer, output, handlers, audio);
    await vi.advanceTimersByTimeAsync(500);
    expect(log).toEqual(['end failed', 'end failed']);
    expect(context.sources).toHaveLength(0);
  });

  it('hands a unit back when it dropped before the unit was heard, and tells the call it is gone', async () => {
    const { face, output, buffer, log, handlers, tracks, audio, relay } = setup();
    const lost = vi.fn();
    face.onLost(lost);
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    face.renderer().render(buffer, output, handlers, audio);
    face.drop();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(tracks[0]?.readyState).toBe('ended');
    expect(face.renderer().ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(log).toEqual(['end failed']);
  });

  it('counts a video track that ended by itself as lost, once', async () => {
    const { face, tracks, relay } = setup();
    const lost = vi.fn();
    face.onLost(lost);
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;
    tracks[0]?.dispatchEvent(new Event('ended'));
    tracks[0]?.dispatchEvent(new Event('ended'));
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('draws every frame while live and releases the video when unmounted', async () => {
    const { face, frames, tracks, cancelFrame, relay } = setup();
    const connected = face.connect(SESSION, new AbortController().signal, relay);
    await vi.advanceTimersByTimeAsync(500);
    await connected;
    expect(frames).toHaveLength(1);
    frames[0]?.(16);
    expect(frames).toHaveLength(2);

    face.unmount();
    expect(cancelFrame).toHaveBeenCalled();
    expect(tracks[0]?.readyState).toBe('ended');
    expect(face.video()).toBeNull();
    frames[1]?.(32);
    expect(frames).toHaveLength(2);
  });
});
