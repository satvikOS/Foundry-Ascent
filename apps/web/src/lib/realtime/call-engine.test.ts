import type { CallView, SttGrant, TurnView } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateTurnBody, StreamTurnOptions, TurnStreamEventT } from '../api/sse';
import { ApiError } from '../api/errors';
import type { HeartbeatResult, StartCallResult } from './call-api';
import { CallEngine, type CallAudioContext, type CallEngineApi } from './call-engine';
import { decodeMessage } from './event-stream';
import type { FaceRenderer, FaceRenderHandlers, SpeechFetchResult, SpeechUnitToPlay } from './playback';
import {
  FakeAudioContext,
  fakeMicStream,
  FakeSpeechSynthesis,
  FakeTrack,
  FakeUtterance,
  FakeWebSocket,
  flush,
  IDS,
  makeReply,
  makeVoiceTurn,
  transcriptEvent,
} from './testing';

const CALL_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01';
const TURN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c02';
const SIG = 'c2lnbmF0dXJlLW9mLXRoZS11bml0LTAx';

function callView(overrides: Partial<CallView> = {}): CallView {
  return {
    id: CALL_ID,
    sessionId: IDS.session,
    ventureId: IDS.venture,
    personaId: IDS.persona,
    status: 'live',
    provider: 'builtin',
    inputMode: 'transcribe',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    maxSeconds: 1200,
    durationSeconds: null,
    ...overrides,
  };
}

function grant(expiresInMs = 300_000): SttGrant {
  return {
    url: `wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket?n=${String(Math.random())}`,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    languageCode: 'en-US',
    sampleRateHertz: 16000,
    mediaEncoding: 'pcm',
  };
}

/** A turn stream the test drives event by event. */
class TurnScript {
  readonly calls: { body: CreateTurnBody; options: StreamTurnOptions }[] = [];
  private queue: TurnStreamEventT[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  readonly stream = (_sessionId: string, body: CreateTurnBody, options: StreamTurnOptions) => {
    this.calls.push({ body, options });
    this.queue = [];
    this.closed = false;
    const next = async (): Promise<IteratorResult<TurnStreamEventT>> => {
      for (;;) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const event = this.queue.shift();
        if (event) return { value: event, done: false };
        if (this.closed) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          options.signal?.addEventListener('abort', () => {
            resolve();
          });
        });
      }
    };
    return { [Symbol.asyncIterator]: () => ({ next }) };
  };

  push(...events: TurnStreamEventT[]): void {
    this.queue.push(...events);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }
}

function speech(seq: number, text: string, final = false): TurnStreamEventT {
  return { event: 'turn.speech', turnId: TURN_ID, seq, text, sig: SIG, final };
}

function completed(turn: Partial<TurnView> = {}): TurnStreamEventT {
  return { event: 'turn.completed', turn: makeVoiceTurn({ id: TURN_ID, ...turn }) };
}

interface SetupOptions {
  grant?: SttGrant | null;
  intro?: boolean;
  mic?: 'ok' | 'denied';
  /** How creating the Transcribe socket fails (a CSP block throws a SecurityError). */
  socketThrows?: string;
  /** The browser keeps the call's audio suspended until a gesture. */
  suspended?: boolean;
}

function setup(options: SetupOptions = {}) {
  const context = new FakeAudioContext();
  if (options.suspended) {
    context.state = 'suspended';
    context.resumeAllowed = false;
  }
  const synthesis = new FakeSpeechSynthesis();
  const script = new TurnScript();
  const track = new FakeTrack();
  vi.spyOn(track, 'stop');
  const { stream } = fakeMicStream(track);
  const getUserMedia = vi.fn((): Promise<MediaStream> =>
    options.mic === 'denied'
      ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
      : Promise.resolve(stream),
  );
  const deviceListeners = new Set<() => void>();
  const speechRequests: SpeechUnitToPlay[] = [];
  let speechResult: SpeechFetchResult = { kind: 'audio', data: new ArrayBuffer(16) };
  const beacon = { send: vi.fn() };
  const api = {
    startCall: vi.fn((): Promise<StartCallResult> =>
      Promise.resolve({
        call: callView(),
        sttGrant: options.grant === undefined ? grant() : options.grant,
        intro: options.intro ? { text: 'Hi Maya, good to hear you.', sig: SIG } : null,
      }),
    ),
    refreshSttGrant: vi.fn(() => Promise.resolve(grant())),
    heartbeat: vi.fn((): Promise<HeartbeatResult> =>
      Promise.resolve({ remainingSeconds: 900, action: 'continue', reason: null }),
    ),
    endCall: vi.fn(() =>
      Promise.resolve({
        call: callView({ status: 'ended', endReason: 'user', durationSeconds: 42 }),
        summary: {
          turnCount: 1,
          durationSeconds: 42,
          memoryProposalIds: [IDS.memory],
          nextActions: [],
          escalationIds: [],
        },
      }),
    ),
    interruptTurn: vi.fn(() => Promise.resolve()),
    streamTurn: vi.fn(script.stream),
    fetchSpeech: vi.fn((_sessionId: string, unit: SpeechUnitToPlay) => {
      speechRequests.push(unit);
      return Promise.resolve(speechResult);
    }),
    prepareEndBeacon: vi.fn(() => Promise.resolve(beacon)),
  } satisfies CallEngineApi;
  const settled: (TurnView | null)[] = [];
  const engine = new CallEngine({
    api,
    media: {
      createAudioContext: () => context as unknown as CallAudioContext,
      getUserMedia,
      watchDevices: (listener) => {
        deviceListeners.add(listener);
        return () => {
          deviceListeners.delete(listener);
        };
      },
      createWorkletNode: () => context.createWorkletNode() as unknown as AudioWorkletNode,
      createSocket: (url) => {
        if (options.socketThrows) throw new DOMException('Refused to connect', options.socketThrows);
        return new FakeWebSocket(url);
      },
      synthesis: synthesis as unknown as SpeechSynthesis,
      createUtterance: (text) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => {
        clearInterval(h as ReturnType<typeof setInterval>);
      },
    },
    onTurnSettled: (_sessionId, turn) => settled.push(turn),
  });
  const state = () => engine.getSnapshot();
  /** One 50 ms microphone frame at a level. */
  const frame = (rms: number) => {
    context.worklets[0]?.emit(new Int16Array(800).fill(rms > 0.01 ? 1000 : 0), rms);
  };
  const setSpeechResult = (result: SpeechFetchResult) => {
    speechResult = result;
  };
  /** The next `/speech` answers, one per request, before the default one. */
  const speechQueue: SpeechFetchResult[] = [];
  api.fetchSpeech.mockImplementation((_sessionId: string, unit: SpeechUnitToPlay) => {
    speechRequests.push(unit);
    return Promise.resolve(speechQueue.shift() ?? speechResult);
  });
  /** The browser's `devicechange`: a microphone was plugged in or out. */
  const devicesChanged = () => {
    for (const listener of [...deviceListeners]) listener();
  };
  return {
    engine,
    api,
    context,
    synthesis,
    script,
    track,
    getUserMedia,
    devicesChanged,
    deviceListeners,
    speechRequests,
    settled,
    beacon,
    state,
    frame,
    setSpeechResult,
    speechQueue,
  };
}

async function startLive(h: ReturnType<typeof setup>) {
  await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session });
  await flush(10);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CallEngine · typed fallback', () => {
  it('continues by typing when the server has no speech-to-text, and still answers aloud', async () => {
    const h = setup({ grant: null, intro: true });
    h.setSpeechResult({ kind: 'unavailable' });
    await startLive(h);

    expect(h.api.startCall).toHaveBeenCalledWith(IDS.session, 'transcribe', false);
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: 'live', input: 'typed', typedReason: 'stt_unavailable' });
    expect(FakeWebSocket.instances).toHaveLength(0);

    // The signed intro plays first: the server has no voice here (501), so the browser reads it.
    expect(h.speechRequests[0]).toMatchObject({ turnId: null, seq: 0, sig: SIG });
    expect(h.synthesis.spoken.map((u) => u.text)).toEqual(['Hi Maya, good to hear you.']);
    expect(h.state()).toMatchObject({ activity: 'speaking', voice: 'browser' });
    expect(h.state().captions.veir).toBe('Hi Maya, good to hear you.');
    h.synthesis.finish();
    await flush(10);
    expect(h.state().activity).toBe('listening');

    h.engine.sendText('  We interviewed twelve clinics.  ');
    await flush();
    expect(h.script.calls[0]?.body).toEqual({
      text: 'We interviewed twelve clinics.',
      channel: 'voice',
      callId: CALL_ID,
    });
    expect(h.state()).toMatchObject({ activity: 'thinking' });
    expect(h.state().captions.founder).toBe('We interviewed twelve clinics.');

    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Twelve is a good start.'),
      speech(1, 'What did they say about price?', true),
      completed(),
    );
    h.script.close();
    await flush(20);
    expect(h.synthesis.spoken.map((u) => u.text).slice(1)).toEqual(['Twelve is a good start.']);
    // After the server's 501, units go straight to the browser voice without asking again.
    expect(h.speechRequests).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
    h.synthesis.finish();
    await flush(10);
    expect(h.state().captions.veir).toBe('What did they say about price?');
    h.synthesis.finish();
    await flush(10);
    expect(h.state().activity).toBe('listening');
  });

  it('asks for a typed call when the microphone is refused', async () => {
    const h = setup({ mic: 'denied' });
    await startLive(h);
    expect(h.api.startCall).toHaveBeenCalledWith(IDS.session, 'typed', false);
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_denied' });
  });

  it('reports a call that could not start', async () => {
    const h = setup();
    h.api.startCall.mockRejectedValueOnce(
      new ApiError({ status: 503, code: 'ai_disabled', title: 'AI disabled' }),
    );
    await startLive(h);
    expect(h.state().phase).toBe('failed');
    expect(h.state().error).toEqual({
      message: expect.stringMatching(/paused by an administrator/) as string,
      retry: false,
    });
    expect(h.context.closed).toBe(true);
    expect(h.track.stop).toHaveBeenCalled();
  });
});

describe('CallEngine · speaking over the greeting (LAB-R1)', () => {
  /** The greeting's audio is still being fetched: its `/speech` request never answers. */
  function holdGreeting(h: ReturnType<typeof setup>): void {
    h.api.fetchSpeech.mockImplementationOnce((_sessionId: string, unit: SpeechUnitToPlay) => {
      h.speechRequests.push(unit);
      return new Promise<SpeechFetchResult>(() => undefined);
    });
  }

  it('a line typed while the greeting is still on its way stops it and is sent at once', async () => {
    // Lab: every call's first line waited 11–14 s for the greeting to play out.
    const h = setup({ grant: null, intro: true });
    holdGreeting(h);
    await startLive(h);
    expect(h.speechRequests[0]).toMatchObject({ turnId: null, seq: 0 });
    expect(h.state().activity).toBe('connecting');

    h.engine.sendText('We finished five library interviews.');
    await flush();
    expect(h.script.calls).toHaveLength(1);
    expect(h.script.calls[0]?.body.text).toBe('We finished five library interviews.');
    expect(h.state()).toMatchObject({ activity: 'thinking', queued: 0 });
    // The greeting never plays after the founder spoke.
    await flush(10);
    expect(h.synthesis.spoken).toEqual([]);
    expect(h.context.sources).toHaveLength(0);
  });

  it('a line typed while the greeting plays stops it and is sent at once', async () => {
    const h = setup({ grant: null, intro: true });
    h.setSpeechResult({ kind: 'audio', data: new ArrayBuffer(20_000) });
    await startLive(h);
    expect(h.state().activity).toBe('speaking');
    h.engine.sendText('Quick one: pricing.');
    await flush();
    expect(h.context.sources[0]?.stopped).toBe(true);
    expect(h.script.calls).toHaveLength(1);
    expect(h.state()).toMatchObject({ activity: 'thinking', queued: 0 });
  });

  it('a line spoken while the greeting is still on its way stops it and is sent at once', async () => {
    const h = setup({ intro: true });
    holdGreeting(h);
    await startLive(h);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    expect(h.speechRequests[0]).toMatchObject({ turnId: null, seq: 0 });
    h.frame(0.2);
    h.frame(0.2);
    socket.serverSend(transcriptEvent('r1', 'We finished five interviews', { partial: false }));
    for (let i = 0; i < 14; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.script.calls[0]?.body.text).toBe('We finished five interviews');
    expect(h.state()).toMatchObject({ activity: 'thinking', queued: 0 });
  });
});

describe('CallEngine · a call already live in another conversation', () => {
  it('asks to move the call here instead of failing, and starts again with replace', async () => {
    const h = setup({ grant: null });
    h.api.startCall.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: 'conflict',
        title: 'Conflict',
        detail: 'You are already in a call in another conversation. End it to start this one.',
      }),
    );
    await startLive(h);
    expect(h.api.startCall).toHaveBeenLastCalledWith(IDS.session, 'transcribe', false);
    expect(h.state()).toMatchObject({ phase: 'failed', error: { elsewhere: true, retry: false } });
    expect(h.state().error?.message).toMatch(/Move it here\?/);

    // The founder said yes.
    h.engine.reset();
    await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session, replace: true });
    await flush(10);
    expect(h.api.startCall).toHaveBeenLastCalledWith(IDS.session, 'transcribe', true);
    expect(h.state().phase).toBe('live');
  });
});

describe('CallEngine · voice', () => {
  it('opens the speech-to-text socket while the capture worklet is still loading (the grant expires fast)', async () => {
    const h = setup();
    let loaded: () => void = () => undefined;
    h.context.audioWorklet.addModule = (url: string) => {
      h.context.modules.push(url);
      return new Promise<void>((resolve) => {
        loaded = resolve;
      });
    };
    void h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session });
    await flush(10);
    expect(h.context.modules).toEqual(['/worklets/pcm-capture.js']);
    expect(h.context.worklets).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    loaded();
    await flush(10);
    expect(h.context.worklets).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('streams 16 kHz PCM to the presigned socket, captions partials and ends the turn after silence', async () => {
    const h = setup();
    await startLive(h);
    expect(h.context.modules).toEqual(['/worklets/pcm-capture.js']);
    const socket = FakeWebSocket.last();
    expect(socket.url).toMatch(/^wss:\/\/transcribestreaming/);
    socket.serverOpen();
    expect(h.state()).toMatchObject({ input: 'voice', activity: 'listening' });

    h.frame(0.08);
    h.frame(0.08);
    expect(socket.sent.length).toBe(2);
    expect(decodeMessage(socket.sent[0] ?? new Uint8Array()).payload.length).toBe(1600);

    socket.serverSend(transcriptEvent('r1', 'We interviewed twelve', { partial: true, stable: false }));
    expect(h.state().captions).toMatchObject({ founder: 'We interviewed twelve', founderLive: true });
    socket.serverSend(
      transcriptEvent('r1', 'We interviewed twelve clinics', { partial: true, stable: true }),
    );

    // Quiet frames: the turn ends once 600 ms of silence follow the stable partial.
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    expect(h.script.calls).toHaveLength(0);
    vi.advanceTimersByTime(100);
    h.frame(0.001);
    await flush();
    expect(h.script.calls[0]?.body.text).toBe('We interviewed twelve clinics');
    expect(h.state().activity).toBe('thinking');
  });

  it('barges in: ducks on voice, then stops the audio, aborts the turn and reports what was heard', async () => {
    const h = setup();
    await startLive(h);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    h.engine.sendText('How should we price it?');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Start with what they pay today.'),
      speech(1, 'Then test a pilot price.'),
    );
    await flush(20);
    expect(h.state().activity).toBe('speaking');
    h.context.sources[0]?.finish();
    await flush(10);
    expect(h.state().captions.veir).toBe('Then test a pilot price.');

    // The vEIR's own words coming back through the speakers do not interrupt it.
    socket.serverSend(transcriptEvent('r9', 'test a pilot', { partial: true }));
    expect(h.state().activity).toBe('speaking');

    h.frame(0.2);
    h.frame(0.2);
    socket.serverSend(transcriptEvent('r10', 'wait actually', { partial: true }));
    await flush();
    expect(h.state().activity).toBe('listening');
    expect(h.context.sources[1]?.stopped).toBe(true);
    expect(h.script.calls[0]?.options.signal?.aborted).toBe(true);
    // What was heard, as played, so the history carries only that.
    expect(h.api.interruptTurn).toHaveBeenCalledWith(TURN_ID, {
      callId: CALL_ID,
      heardSeq: 0,
      heard: [{ seq: 0, text: 'Start with what they pay today.', sig: SIG }],
    });
    expect(h.state().captions.founder).toBe('wait actually');
  });

  it('closes speech-to-text while muted and reconnects with a fresh grant on unmute', async () => {
    const h = setup({ grant: grant(10_000) });
    await startLive(h);
    const first = FakeWebSocket.last();
    first.serverOpen();
    h.engine.setMuted(true);
    expect(h.track.enabled).toBe(false);
    expect(decodeMessage(first.sent.at(-1) ?? new Uint8Array()).payload.length).toBe(0);
    h.frame(0.2);
    expect(first.sent.length).toBe(1);

    h.engine.setMuted(false);
    await flush();
    // The grant was about to expire: a new one is minted before reconnecting.
    expect(h.api.refreshSttGrant).toHaveBeenCalledWith(CALL_ID);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(h.track.enabled).toBe(true);
  });

  it('reconnects a dropped socket, then falls back to typing after 30 s', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    FakeWebSocket.last().serverDrop();
    expect(h.state().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last().serverOpen();
    expect(h.state().reconnecting).toBe(false);

    for (let i = 0; i < 12 && h.state().input === 'voice'; i++) {
      FakeWebSocket.last().serverDrop();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'stt_failed', reconnecting: false });
    expect(h.track.stop).toHaveBeenCalled();
  });

  it('stops reconnecting while muted, and gives an unmuted call a fresh reconnect window', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    FakeWebSocket.last().serverDrop();
    expect(h.state().reconnecting).toBe(true);
    h.engine.setMuted(true);
    // Muted (or on hold, or reading crisis support): nothing is reconnecting, so the call does not say so.
    expect(h.state()).toMatchObject({ muted: true, reconnecting: false });
    expect(h.engine.avatarState()).toBe('muted');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.state().reconnecting).toBe(false);

    // Unmuted long after: one failed grant is a fresh attempt, not the end of voice input.
    h.api.refreshSttGrant.mockRejectedValueOnce(new Error('offline'));
    h.engine.setMuted(false);
    await flush(10);
    expect(h.state()).toMatchObject({ input: 'voice', reconnecting: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last().serverOpen();
    expect(h.state()).toMatchObject({ input: 'voice', reconnecting: false });
  });

  it('lets go of push-to-talk on hold and on mute, so nothing said meanwhile is sent', async () => {
    const h = setup();
    await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session, talkMode: 'push_to_talk' });
    await flush(10);
    FakeWebSocket.last().serverOpen();
    h.engine.pushToTalk(true);
    h.engine.hold();
    expect(h.state()).toMatchObject({ held: true, talking: false });
    h.engine.resume();
    await flush(10);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    expect(h.state()).toMatchObject({ held: false, talking: false });
    // The side conversation after resuming is not sent: the stream carries silence until Space is held again.
    h.frame(0.2);
    expect(decodeMessage(socket.sent.at(-1) ?? new Uint8Array()).payload.every((b) => b === 0)).toBe(true);
    socket.serverSend(transcriptEvent('s1', 'not for the vEIR', { partial: false }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.script.calls).toHaveLength(0);

    h.engine.pushToTalk(true);
    h.engine.setMuted(true);
    expect(h.state()).toMatchObject({ muted: true, talking: false });
  });

  it('says when the microphone is unplugged, continues by typing and reconnects it on request', async () => {
    const h = setup();
    await startLive(h);
    const first = FakeWebSocket.last();
    first.serverOpen();
    h.track.unplug();
    // Not "Listening" to a dead microphone: typing, with the reason, and nothing left open.
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_lost', reconnecting: false });
    expect(h.track.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Plugged back in: Reconnect asks for the microphone again and goes back to voice.
    const plugged = fakeMicStream();
    h.getUserMedia.mockResolvedValueOnce(plugged.stream);
    await h.engine.reconnectMicrophone();
    await flush(10);
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ input: 'voice', typedReason: null });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.last();
    second.serverOpen();
    expect(h.state().activity).toBe('listening');
    h.context.worklets.at(-1)?.emit(new Int16Array(800).fill(1000), 0.2);
    expect(second.sent.length).toBe(1);
  });

  it('says so when a reconnect finds no microphone, and keeps the call typed', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    h.track.unplug();
    h.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    await h.engine.reconnectMicrophone();
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_unavailable' });
  });

  it('treats a microphone the system keeps silent as disconnected', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    // A short system mute (a notification sound, a device switch) passes.
    h.track.setMuted(true);
    await vi.advanceTimersByTimeAsync(2_000);
    h.track.setMuted(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state()).toMatchObject({ input: 'voice', typedReason: null });
    // One that lasts is a microphone that is gone.
    h.track.setMuted(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_lost' });
  });

  it('checks the microphone again when devices change', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    h.devicesChanged();
    expect(h.state().input).toBe('voice');
    // The device went away without its track firing `ended`.
    h.track.readyState = 'ended';
    h.devicesChanged();
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_lost' });
    expect(h.deviceListeners.size).toBe(0);
  });

  it('push-to-talk sends silence until held and ends the turn on release', async () => {
    const h = setup();
    await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session, talkMode: 'push_to_talk' });
    await flush(10);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    h.frame(0.2);
    const silent = decodeMessage(socket.sent.at(-1) ?? new Uint8Array()).payload;
    expect(silent.every((b) => b === 0)).toBe(true);

    h.engine.pushToTalk(true);
    h.frame(0.2);
    const spoken = decodeMessage(socket.sent.at(-1) ?? new Uint8Array()).payload;
    expect(spoken.some((b) => b !== 0)).toBe(true);
    socket.serverSend(transcriptEvent('p1', 'Next step please', { partial: true }));
    h.engine.pushToTalk(false);
    expect(h.script.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.script.calls[0]?.body.text).toBe('Next step please');
  });
});

describe('CallEngine · replies', () => {
  it('speaks the stored validated reply when no units were streamed', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('Hello');
    await flush();
    h.script.push(
      completed({
        response: makeReply({ answer: 'Long answer [E1].', spoken: 'Short spoken reply. Second line.' }),
      }),
    );
    h.script.close();
    await flush(20);
    expect(h.speechRequests.map((u) => [u.turnId, u.seq, u.text, u.sig])).toEqual([
      [TURN_ID, 0, 'Short spoken reply.', undefined],
      [TURN_ID, 1, 'Second line.', undefined],
    ]);
  });

  it('shows (never voices) the opening of a reply that has no spoken form', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('Hello');
    await flush();
    const sentence = 'This sentence has exactly ten words in it for counting.';
    h.script.push(
      completed({ response: makeReply({ spoken: null, answer: Array(12).fill(sentence).join(' ') }) }),
    );
    h.script.close();
    await flush(20);
    // Only the stored spoken form may be voiced unsigned: nothing is asked of /speech.
    expect(h.speechRequests).toHaveLength(0);
    expect(h.state().captions.veir).toBe(Array(4).fill(sentence).join(' '));
    expect(h.state().activity).toBe('listening');
  });

  it('mutes the microphone when a turn is blocked, so the founder can read the support', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    h.engine.sendText('I am not okay');
    await flush();
    h.script.push({
      event: 'turn.blocked',
      turnId: TURN_ID,
      reason: 'crisis_support',
      escalationId: null,
      supportMessage: 'Call or text **988**.',
    });
    h.script.close();
    await flush(10);
    expect(h.state().muted).toBe(true);
    expect(h.track.enabled).toBe(false);
  });

  it('explains a refused voice turn in the server’s words', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.api.streamTurn.mockImplementationOnce(() => {
      throw new ApiError({
        status: 409,
        code: 'conflict',
        title: 'Conflict',
        detail: 'This call reached its turn limit. Start a new call to keep talking.',
      });
    });
    h.engine.sendText('Hello');
    await flush(10);
    expect(h.state().notice).toEqual({
      kind: 'turn_error',
      message:
        'Sorry, I couldn’t answer that. This call reached its turn limit. Start a new call to keep talking.',
    });
  });

  it('queues lines said while the vEIR is still thinking and sends them together', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('First');
    await flush();
    h.engine.sendText('Also this');
    h.engine.sendText('And that');
    expect(h.state().queued).toBe(2);
    h.script.push(completed({ response: makeReply({ spoken: 'Ok.' }) }));
    h.script.close();
    await flush(10);
    h.context.sources[0]?.finish();
    await flush(10);
    expect(h.script.calls[1]?.body.text).toBe('Also this And that');
  });

  it('shows support and stops speaking when a turn is blocked', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('I am not okay');
    await flush();
    h.script.push({
      event: 'turn.blocked',
      turnId: TURN_ID,
      reason: 'crisis_support',
      escalationId: null,
      supportMessage: 'Call or text **988**.',
    });
    h.script.close();
    await flush(10);
    expect(h.state().blocked).toEqual({
      reason: 'crisis_support',
      escalationId: null,
      supportMessage: 'Call or text **988**.',
    });
    expect(h.speechRequests).toHaveLength(0);
    expect(h.state().activity).toBe('listening');
    // The next line clears the panel.
    h.engine.sendText('Thank you');
    await flush();
    expect(h.state().blocked).toBeNull();
  });

  it('shows (never speaks) a failed turn', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('Hello');
    await flush();
    h.script.push({
      event: 'turn.error',
      turnId: null,
      code: 'model_unavailable',
      message: 'Try again.',
      retryable: true,
    });
    h.script.close();
    await flush(10);
    expect(h.state().notice).toMatchObject({ kind: 'turn_error' });
    expect(h.speechRequests).toHaveLength(0);
  });

  it('shows a sentence whose voice failed on screen, then speaks the next turn again', async () => {
    const h = setup({ grant: null });
    // A network blip or a busy synthesiser on the first sentence only.
    h.speechQueue.push({ kind: 'failed' });
    await startLive(h);
    h.engine.sendText('Hello');
    await flush();
    h.script.push(speech(0, 'Twelve is a good start.'));
    await flush(10);
    expect(h.state()).toMatchObject({ voice: 'captions', activity: 'speaking', notice: null });
    expect(h.synthesis.spoken).toHaveLength(0);
    h.script.push(completed());
    h.script.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.state().activity).toBe('listening');

    h.engine.sendText('And then?');
    await flush();
    h.script.push(speech(0, 'Test a pilot price.'));
    await flush(10);
    expect(h.speechRequests.map((u) => u.text)).toEqual(['Twelve is a good start.', 'Test a pilot price.']);
    expect(h.state()).toMatchObject({ voice: 'server', activity: 'speaking' });
  });

  it('stays on screen for the rest of the call when the server refuses its speech', async () => {
    const h = setup({ grant: null });
    h.speechQueue.push({ kind: 'refused' });
    await startLive(h);
    h.engine.sendText('Hello');
    await flush();
    h.script.push(speech(0, 'Twelve is a good start.'));
    h.script.push(completed());
    h.script.close();
    await vi.advanceTimersByTimeAsync(5_000);
    h.engine.sendText('And then?');
    await flush();
    h.script.push(speech(0, 'Test a pilot price.'));
    await flush(10);
    expect(h.speechRequests).toHaveLength(1);
    expect(h.state()).toMatchObject({ voice: 'captions', activity: 'speaking' });
    expect(h.state().captions.veir).toBe('Test a pilot price.');
  });

  it('lets the crisis support line play when a turn is blocked for crisis support', async () => {
    const h = setup();
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    h.engine.sendText('I am not okay');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'You deserve support from a person.', true),
    );
    await flush(20);
    h.script.push({
      event: 'turn.blocked',
      turnId: TURN_ID,
      reason: 'crisis_support',
      escalationId: IDS.escalation,
      supportMessage: 'Call or text **988**.',
    });
    h.script.close();
    await flush(20);
    expect(h.context.sources[0]?.stopped).toBe(false);
    expect(h.state()).toMatchObject({ activity: 'speaking', muted: true });
    expect(h.state().blocked?.escalationId).toBe(IDS.escalation);
    // Nothing cuts the support line off: not Esc or Interrupt, and no interrupt is recorded.
    h.engine.interrupt();
    await flush();
    expect(h.context.sources[0]?.stopped).toBe(false);
    expect(h.api.interruptTurn).not.toHaveBeenCalled();
    h.context.sources[0]?.finish();
    await flush(10);
    expect(h.state().activity).toBe('listening');
  });

  it('stops a reply that a safety check held back', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.engine.sendText('Tell me about BenchTally');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Start with what they pay today.'),
    );
    await flush(20);
    expect(h.state().activity).toBe('speaking');
    h.script.push({
      event: 'turn.blocked',
      turnId: TURN_ID,
      reason: 'policy',
      escalationId: null,
      supportMessage: null,
    });
    h.script.close();
    await flush(20);
    expect(h.context.sources[0]?.stopped).toBe(true);
    expect(h.state()).toMatchObject({ activity: 'listening', blocked: { reason: 'policy' } });
  });
});

describe('CallEngine · barge-in', () => {
  async function speaking(h: ReturnType<typeof setup>) {
    // Twenty seconds of reply audio, so the vEIR is still speaking throughout.
    h.setSpeechResult({ kind: 'audio', data: new ArrayBuffer(20_000) });
    await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session });
    await flush(10);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    h.engine.sendText('Tell me about pilots.');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Start with one library and a written success threshold.'),
    );
    await flush(20);
    expect(h.state().activity).toBe('speaking');
    return socket;
  }

  it('does not cut the vEIR off for a backchannel', async () => {
    const h = setup();
    const socket = await speaking(h);
    socket.serverSend(transcriptEvent('r1', 'mm-hmm right', { partial: false }));
    socket.serverSend(transcriptEvent('r2', 'yeah', { partial: true, stable: false }));
    socket.serverSend(transcriptEvent('r2', 'yeah', { partial: true, stable: true }));
    await flush();
    expect(h.state().activity).toBe('speaking');
    expect(h.api.interruptTurn).not.toHaveBeenCalled();
    expect(h.state().captions.founder).toBe('Tell me about pilots.');

    // Nor is the backchannel sent as a turn once the vEIR is done.
    h.script.push(completed({ response: makeReply({ spoken: 'Start with one library.' }) }));
    h.script.close();
    h.context.sources[0]?.finish();
    await flush(10);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.script.calls).toHaveLength(1);
  });

  it('never turns the vEIR’s own settled echo into a turn of the founder', async () => {
    const h = setup();
    const socket = await speaking(h);
    socket.serverSend(transcriptEvent('r1', 'one library and a written', { partial: true, stable: true }));
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.state()).toMatchObject({ activity: 'speaking', queued: 0 });
    h.script.push(completed());
    h.script.close();
    h.context.sources[0]?.finish();
    await flush(10);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.script.calls).toHaveLength(1);
    expect(h.api.interruptTurn).not.toHaveBeenCalled();
  });

  it('ignores the echo of a sentence heard after it ended, while the reply goes on', async () => {
    const h = setup();
    const socket = await speaking(h);
    // The first sentence ends before the next one has arrived: the vEIR is still answering.
    h.context.sources[0]?.finish();
    await flush(10);
    expect(h.state().activity).toBe('thinking');
    socket.serverSend(
      transcriptEvent('r1', 'Start with one library and a written success threshold.', { partial: false }),
    );
    socket.serverSend(transcriptEvent('r2', 'okay', { partial: false }));
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.state()).toMatchObject({ activity: 'thinking', queued: 0 });
    expect(h.state().captions.founder).toBeNull();
    h.script.push(completed());
    h.script.close();
    await flush(10);
    expect(h.state().activity).toBe('listening');
    expect(h.script.calls).toHaveLength(1);
  });

  it('keeps what the founder says between the sentences of a reply, and sends it after', async () => {
    const h = setup();
    const socket = await speaking(h);
    h.context.sources[0]?.finish();
    await flush(10);
    socket.serverSend(transcriptEvent('r1', 'What about pricing?', { partial: false }));
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      h.frame(0.001);
    }
    await flush();
    expect(h.state().queued).toBe(1);
    h.script.push(completed());
    h.script.close();
    await flush(10);
    expect(h.script.calls[1]?.body.text).toBe('What about pricing?');
  });

  it('waits for a settled word, or two words, before taking the floor', async () => {
    const h = setup();
    const socket = await speaking(h);
    socket.serverSend(transcriptEvent('r1', 'stop', { partial: true, stable: false }));
    await flush();
    expect(h.state().activity).toBe('speaking');
    socket.serverSend(transcriptEvent('r1', 'stop', { partial: true, stable: true }));
    await flush();
    expect(h.state().activity).toBe('listening');
    expect(h.api.interruptTurn).toHaveBeenCalledTimes(1);
  });

  /** 50 ms microphone frames: 'x' the founder's voice, '.' quiet. */
  async function voice(h: ReturnType<typeof setup>, pattern: string): Promise<void> {
    for (const c of pattern) {
      vi.advanceTimersByTime(50);
      h.frame(c === 'x' ? 0.2 : 0.001);
    }
    await flush();
  }

  it('stops on the founder’s voice running on over it, in under a second, before any word (LAB-V4)', async () => {
    // Lab: 2.0 s from the start of a barge-in to the reply stopping, waiting for confirmed words.
    const h = setup();
    await speaking(h);
    await voice(h, 'xxxxxxxxxx'); // 0.5 s: ducked, still speaking
    expect(h.state().activity).toBe('speaking');
    expect(h.api.interruptTurn).not.toHaveBeenCalled();
    await voice(h, 'xxxxx'); // 0.75 s
    expect(h.state().activity).toBe('listening');
    expect(h.context.sources[0]?.stopped).toBe(true);
    expect(h.api.interruptTurn).toHaveBeenCalledTimes(1);
  });

  it('never cuts the vEIR off for backchannels, short or strung together', async () => {
    const h = setup();
    const socket = await speaking(h);
    // "Yeah." … "Mm-hmm.": short sounds with pauses between them.
    await voice(h, 'xxxxxx........xxxxxxxx........');
    expect(h.state().activity).toBe('speaking');
    // A long "mm-hmm, yeah, right": the voice runs on, but its words say it is only listening.
    socket.serverSend(transcriptEvent('r1', 'mm-hmm yeah right', { partial: true, stable: false }));
    await voice(h, 'xxxxxxxxxxxxxxxxxxxx');
    expect(h.state().activity).toBe('speaking');
    expect(h.api.interruptTurn).not.toHaveBeenCalled();
  });

  it('stops on one word Transcribe already marked stable that is not a backchannel ("Sorry, with…")', async () => {
    const h = setup();
    const socket = await speaking(h);
    // "with" is the vEIR's own echo; "sorry" opens a turn and Transcribe will not revise it.
    socket.serverSend(transcriptEvent('r1', 'sorry with', { partial: true, stableWords: 1 }));
    await flush();
    expect(h.state().activity).toBe('listening');
    expect(h.api.interruptTurn).toHaveBeenCalledTimes(1);
  });

  it('stops on one unsettled word that is not a backchannel once the voice has run on', async () => {
    const h = setup();
    const socket = await speaking(h);
    socket.serverSend(transcriptEvent('r1', 'actually', { partial: true, stable: false }));
    await flush();
    expect(h.state().activity).toBe('speaking');
    await voice(h, 'xxxxxxx');
    socket.serverSend(transcriptEvent('r1', 'actually', { partial: true, stable: false }));
    await flush();
    expect(h.state().activity).toBe('listening');
  });

  it('needs words on a call where voice alone stopped the vEIR once and no word followed (speakers)', async () => {
    const h = setup();
    const socket = await speaking(h);
    await voice(h, 'xxxxxxxxxxxxxxx');
    expect(h.state().activity).toBe('listening');
    // Nothing is said: the sound was the room, not the founder.
    await vi.advanceTimersByTimeAsync(3_100);
    h.engine.sendText('Go on.');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 2 },
      speech(0, 'Start with one library.'),
    );
    await flush(20);
    expect(h.state().activity).toBe('speaking');
    await voice(h, 'xxxxxxxxxxxxxxxxxxxx');
    expect(h.state().activity).toBe('speaking');
    // Words still stop it.
    socket.serverSend(transcriptEvent('r9', 'wait stop', { partial: true }));
    await flush();
    expect(h.state().activity).toBe('listening');
  });

  it('suggests push-to-talk after repeated sound without words', async () => {
    const h = setup();
    await speaking(h);
    for (let i = 0; i < 3; i++) {
      h.frame(0.2);
      h.frame(0.2);
      h.frame(0.001);
      await vi.advanceTimersByTimeAsync(1_300);
    }
    expect(h.state().notice).toMatchObject({ kind: 'barge_hint' });
    expect(h.state().activity).toBe('speaking');
    // The hint stays through the next turn.
    h.context.sources[0]?.finish();
    h.script.push(completed());
    h.script.close();
    await flush(10);
    h.engine.sendText('Ok');
    await flush();
    expect(h.state().notice?.kind).toBe('barge_hint');
  });

  it('closes the microphone while the vEIR speaks in half duplex', async () => {
    const h = setup();
    await h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session, halfDuplex: true });
    await flush(10);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    h.engine.sendText('Tell me about pilots.');
    await flush();
    h.script.push(speech(0, 'Start with one library.'));
    await flush(20);
    h.frame(0.2);
    h.frame(0.2);
    const sent = decodeMessage(socket.sent.at(-1) ?? new Uint8Array()).payload;
    expect(sent.every((b) => b === 0)).toBe(true);
    socket.serverSend(transcriptEvent('r1', 'wait stop that', { partial: false }));
    await flush();
    expect(h.state()).toMatchObject({ activity: 'speaking', halfDuplex: true });
    h.engine.interrupt();
    expect(h.state().activity).toBe('listening');
  });
});

describe('CallEngine · a face that renders the call’s audio', () => {
  /** A vendor face (voicing `audio`) the test drives step by step. */
  function scriptedFace() {
    const renders: { handlers: FaceRenderHandlers; stopped: boolean }[] = [];
    const face: FaceRenderer = {
      ready: () => true,
      render: (_buffer, _output, handlers) => {
        const entry = { handlers, stopped: false };
        renders.push(entry);
        return () => {
          entry.stopped = true;
        };
      },
    };
    return { face, renders };
  }

  it('hands the validated reply to the face, follows its timing, and reports what was heard on barge-in', async () => {
    const h = setup();
    const { face, renders } = scriptedFace();
    // Attached before the call starts: the call's player takes it over.
    h.engine.attachFace(face);
    await startLive(h);
    const socket = FakeWebSocket.last();
    socket.serverOpen();
    h.engine.sendText('How should we price it?');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Start with what they pay today.'),
      speech(1, 'Then test a pilot price.'),
    );
    await flush(20);
    // Only signed units are fetched from /speech, and their audio goes to the face, not the speakers.
    expect(h.speechRequests.map((u) => u.sig)).toEqual([SIG, SIG]);
    expect(renders).toHaveLength(1);
    expect(h.context.sources).toHaveLength(0);
    // Not heard yet: the caption waits for the face's first sound.
    expect(h.state().captions.veir).toBeNull();

    renders[0]?.handlers.onStart();
    expect(h.state()).toMatchObject({ activity: 'speaking', voice: 'server' });
    expect(h.state().captions.veir).toBe('Start with what they pay today.');
    renders[0]?.handlers.onEnd('ended');
    await flush(10);
    renders[1]?.handlers.onStart();
    expect(h.state().captions.veir).toBe('Then test a pilot price.');

    h.frame(0.2);
    h.frame(0.2);
    socket.serverSend(transcriptEvent('r10', 'wait actually', { partial: true }));
    await flush();
    expect(h.state().activity).toBe('listening');
    expect(renders[1]?.stopped).toBe(true);
    expect(h.api.interruptTurn).toHaveBeenCalledWith(TURN_ID, {
      callId: CALL_ID,
      heardSeq: 0,
      heard: [{ seq: 0, text: 'Start with what they pay today.', sig: SIG }],
    });
  });

  it('plays through the speakers again once the face is detached', async () => {
    const h = setup();
    const { face, renders } = scriptedFace();
    await startLive(h);
    h.engine.attachFace(face);
    h.engine.attachFace(null);
    h.engine.sendText('Hello');
    await flush();
    h.script.push(speech(0, 'Hello Maya.'));
    await flush(20);
    expect(renders).toHaveLength(0);
    expect(h.context.sources[0]?.started).toBe(true);
  });
});

describe('CallEngine · resilience', () => {
  it('continues by typing at once when the browser refuses the speech-to-text host', async () => {
    const h = setup({ socketThrows: 'SecurityError' });
    await expect(startLive(h)).resolves.toBeUndefined();
    expect(h.state()).toMatchObject({
      phase: 'live',
      input: 'typed',
      typedReason: 'stt_unavailable',
      activity: 'listening',
      reconnecting: false,
    });
    expect(h.track.stop).toHaveBeenCalled();
  });

  it('retries a socket that could not be created, then continues by typing', async () => {
    const h = setup({ socketThrows: 'SyntaxError' });
    await startLive(h);
    expect(h.state().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'stt_failed', reconnecting: false });
    expect(h.track.stop).toHaveBeenCalled();
  });

  it('never rejects: a browser API that throws ends in a failed call with the microphone closed', async () => {
    const h = setup();
    h.context.createGain = () => {
      throw new Error('boom');
    };
    await expect(startLive(h)).resolves.toBeUndefined();
    expect(h.state()).toMatchObject({ phase: 'failed', error: { retry: true } });
    expect(h.api.startCall).not.toHaveBeenCalled();
  });

  it('offers Turn on sound when the browser keeps the audio suspended, and clears it once resumed', async () => {
    const h = setup({ suspended: true, grant: null });
    await startLive(h);
    expect(h.state()).toMatchObject({ phase: 'live', audioBlocked: true });
    h.context.resumeAllowed = true;
    h.engine.resumeAudio();
    await flush();
    expect(h.state().audioBlocked).toBe(false);
    // The browser suspends it again later (another tab took the audio device): the offer comes back.
    h.context.setState('suspended');
    expect(h.state().audioBlocked).toBe(true);
  });

  it('holds while the page is hidden and resumes on a tap', async () => {
    const h = setup();
    await startLive(h);
    const first = FakeWebSocket.last();
    first.serverOpen();
    h.engine.hold();
    expect(h.state()).toMatchObject({ held: true, muted: true });
    expect(h.track.enabled).toBe(false);
    h.engine.resume();
    await flush();
    expect(h.state()).toMatchObject({ held: false, muted: false });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('CallEngine · the crisis support line is never cut off', () => {
  const SUPPORT = 'Call or text **988**.';

  /** A call whose vEIR is saying the crisis support line (a minute of audio). */
  async function sayingSupport(h: ReturnType<typeof setup>, maxSeconds = 1200) {
    h.setSpeechResult({ kind: 'audio', data: new ArrayBuffer(60_000) });
    h.api.startCall.mockResolvedValueOnce({ call: callView({ maxSeconds }), sttGrant: grant(), intro: null });
    await startLive(h);
    FakeWebSocket.last().serverOpen();
    h.engine.sendText('I am not okay');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'You deserve support from a person right now.', true),
      {
        event: 'turn.blocked',
        turnId: TURN_ID,
        reason: 'crisis_support',
        escalationId: IDS.escalation,
        supportMessage: SUPPORT,
      },
    );
    h.script.close();
    await flush(20);
    expect(h.state()).toMatchObject({ activity: 'speaking', blocked: { reason: 'crisis_support' } });
    expect(h.context.sources[0]?.started).toBe(true);
  }

  it.each([
    ['the time limit', 'timeout', 11_000],
    ['the server ending the call', 'disabled', 15_000],
    ['three missed heartbeats', 'error', 45_000],
  ] as const)(
    'plays to its end through %s, and the support stays with the summary',
    async (_, reason, after) => {
      const h = setup();
      if (reason === 'disabled') {
        h.api.heartbeat.mockResolvedValue({ remainingSeconds: 0, action: 'terminate', reason: 'disabled' });
      } else if (reason === 'error') {
        h.api.heartbeat.mockRejectedValue(new Error('offline'));
      } else {
        // The server's countdown never arrives: the client enforces the limit itself.
        h.api.heartbeat.mockImplementation(() => new Promise(() => undefined));
      }
      await sayingSupport(h, reason === 'timeout' ? 10 : 1200);
      await vi.advanceTimersByTimeAsync(after);
      await flush(10);
      expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ reason }));
      expect(h.state().phase).toBe('ended');
      // The microphone and speech-to-text closed with the call; the line did not.
      expect(h.track.stop).toHaveBeenCalled();
      expect(h.context.sources[0]?.stopped).toBe(false);
      expect(h.context.closed).toBe(false);
      // The support is still what the founder sees, above the summary.
      expect(h.state().ended?.blocked).toEqual({
        reason: 'crisis_support',
        escalationId: IDS.escalation,
        supportMessage: SUPPORT,
      });
      // Dismissing the summary does not cut it off either.
      h.engine.reset();
      expect(h.context.sources[0]?.stopped).toBe(false);
      expect(h.context.closed).toBe(false);
      // Heard to its end, the call's audio is released.
      h.context.sources[0]?.finish();
      await flush(10);
      expect(h.context.closed).toBe(true);
    },
  );

  it('plays to its end when the founder ends the call', async () => {
    const h = setup();
    await sayingSupport(h);
    await h.engine.end('user');
    expect(h.state()).toMatchObject({ phase: 'ended', ended: { blocked: { reason: 'crisis_support' } } });
    expect(h.context.sources[0]?.stopped).toBe(false);
    h.context.sources[0]?.finish();
    await flush(10);
    expect(h.context.closed).toBe(true);
    expect(h.state().phase).toBe('ended');
  });

  it('keeps no support on the summary after an ordinary call, and stops a held-back reply', async () => {
    const h = setup();
    await startLive(h);
    h.engine.sendText('Tell me about BenchTally');
    await flush();
    h.script.push(
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      speech(0, 'Start with what they pay today.'),
      { event: 'turn.blocked', turnId: TURN_ID, reason: 'policy', escalationId: null, supportMessage: null },
    );
    h.script.close();
    await flush(20);
    await h.engine.end('user');
    expect(h.state().ended?.blocked).toBeNull();
    expect(h.context.closed).toBe(true);
  });
});

describe('CallEngine · limits and ending', () => {
  it('ends when the server says terminate on a heartbeat', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.api.heartbeat.mockResolvedValueOnce({ remainingSeconds: 0, action: 'terminate', reason: 'disabled' });
    await vi.advanceTimersByTimeAsync(15_000);
    await flush(10);
    expect(h.api.heartbeat).toHaveBeenCalledWith(CALL_ID, { state: 'listening', micOpenSeconds: 0 });
    expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ reason: 'disabled' }));
    expect(h.state().phase).toBe('ended');
    expect(h.state().ended?.summary?.memoryProposalIds).toEqual([IDS.memory]);
    expect(h.context.closed).toBe(true);
  });

  it('warns near the limit and ends at it', async () => {
    const h = setup({ grant: null });
    h.api.startCall.mockResolvedValueOnce({
      call: callView({ maxSeconds: 125 }),
      sttGrant: null,
      intro: null,
    });
    // The server's countdown never arrives: the client enforces the limit itself.
    h.api.heartbeat.mockImplementation(() => new Promise(() => undefined));
    await startLive(h);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.state().notice).toMatchObject({ kind: 'time_warning', message: '2 minutes left on this call.' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ reason: 'timeout' }));
  });

  it('ends after three missed heartbeats', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.api.heartbeat.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ reason: 'error' }));
  });

  it('sends numbers-only client stats when ending', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    await h.engine.end('user');
    expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, {
      reason: 'user',
      clientStats: { firstAudioMsP50: null, firstAudioMsP95: null, bargeIns: 0, reconnects: 0 },
    });
    expect(h.state().ended).toMatchObject({ reason: 'user', durationSeconds: 42, turnCount: 1 });
  });

  it('keeps the call over even when the summary cannot be loaded', async () => {
    const h = setup({ grant: null });
    await startLive(h);
    h.api.endCall.mockRejectedValueOnce(new ApiError({ status: 0, code: 'network_error', title: 'x' }));
    await h.engine.end('user');
    expect(h.state().phase).toBe('ended');
    expect(h.state().ended?.summaryError).toMatch(/connection/);
  });

  it('ends with a keepalive beacon when the page goes away', async () => {
    const h = setup();
    await startLive(h);
    h.engine.dispose();
    expect(h.beacon.send).toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.state().phase).toBe('idle');
  });

  it('closes a call that the server opened after the founder already ended it', async () => {
    const h = setup();
    let resolveStart: (value: StartCallResult) => void = () => undefined;
    h.api.startCall.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const starting = h.engine.start({ ventureId: IDS.venture, sessionId: IDS.session });
    await flush();
    await h.engine.end('user');
    resolveStart({ call: callView(), sttGrant: null, intro: null });
    await starting;
    expect(h.api.endCall).toHaveBeenCalledWith(CALL_ID, { reason: 'user' });
    expect(h.state().phase).toBe('idle');
  });
});
