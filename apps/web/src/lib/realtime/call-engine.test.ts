import type { CallView, SttGrant, TurnView } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateTurnBody, StreamTurnOptions, TurnStreamEventT } from '../api/sse';
import { ApiError } from '../api/errors';
import type { HeartbeatResult, StartCallResult } from './call-api';
import { CallEngine, type CallAudioContext, type CallEngineApi } from './call-engine';
import { decodeMessage } from './event-stream';
import type { SpeechFetchResult, SpeechUnitToPlay } from './playback';
import {
  FakeAudioContext,
  FakeSpeechSynthesis,
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
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
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
      getUserMedia:
        options.mic === 'denied'
          ? () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
          : () => Promise.resolve(stream),
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
  return {
    engine,
    api,
    context,
    synthesis,
    script,
    track,
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

    expect(h.api.startCall).toHaveBeenCalledWith(IDS.session, 'transcribe');
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
    expect(h.api.startCall).toHaveBeenCalledWith(IDS.session, 'typed');
    expect(h.state()).toMatchObject({ input: 'typed', typedReason: 'mic_denied' });
  });

  it('reports a call that could not start', async () => {
    const h = setup();
    h.api.startCall.mockRejectedValueOnce(
      new ApiError({ status: 503, code: 'ai_disabled', title: 'AI disabled' }),
    );
    await startLive(h);
    expect(h.state().phase).toBe('failed');
    expect(h.state().error).toEqual({ message: expect.stringMatching(/turned off/) as string, retry: false });
    expect(h.context.closed).toBe(true);
    expect(h.track.stop).toHaveBeenCalled();
  });
});

describe('CallEngine · voice', () => {
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
