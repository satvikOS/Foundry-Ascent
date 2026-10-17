import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  localEnglishVoice,
  readingTimeMs,
  SpeechPlayer,
  type FaceRenderer,
  type FaceRendererOutput,
  type FaceRenderHandlers,
  type PlayerAudio,
  type SpeechFetchResult,
  type SpeechUnitToPlay,
} from './playback';
import { FakeAudioContext, FakeSpeechSynthesis, FakeUtterance, fakeVoice, flush } from './testing';

const TURN = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

function unit(seq: number, text = `Sentence ${String(seq)}.`): SpeechUnitToPlay {
  return { turnId: TURN, seq, text, sig: `sig-${String(seq)}-0123456789abcdef` };
}

interface Pending {
  unit: SpeechUnitToPlay;
  signal: AbortSignal;
  resolve: (result: SpeechFetchResult) => void;
}

function setup(options: { synthesis?: boolean } = {}) {
  const context = new FakeAudioContext();
  const synthesis = new FakeSpeechSynthesis();
  const pending: Pending[] = [];
  const fetchSpeech = vi.fn(
    (u: SpeechUnitToPlay, signal: AbortSignal) =>
      new Promise<SpeechFetchResult>((resolve) => {
        pending.push({ unit: u, signal, resolve });
      }),
  );
  const audio = {
    context,
    fetchSpeech,
    synthesis: options.synthesis === false ? null : synthesis,
    createUtterance: (text: string) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    now: () => Date.now(),
  } as unknown as PlayerAudio;
  const log: string[] = [];
  const player = new SpeechPlayer(audio, {
    onUnitStart: (u, route) => log.push(`start ${String(u.seq)} ${route}`),
    onUnitEnd: (u, completed) => log.push(`end ${String(u.seq)} ${completed ? 'done' : 'cut'}`),
    onIdle: () => log.push('idle'),
  });
  const audioOf = (bytes: number): SpeechFetchResult => ({ kind: 'audio', data: new ArrayBuffer(bytes) });
  return { context, synthesis, pending, fetchSpeech, player, log, audioOf };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SpeechPlayer', () => {
  it('plays units in order and fetches the next one while the current one plays', async () => {
    const { context, pending, fetchSpeech, player, log, audioOf } = setup();
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    player.enqueue(unit(2));
    // Pipelined: the first two are fetched at once, the third waits its turn.
    expect(fetchSpeech).toHaveBeenCalledTimes(2);

    pending[1]?.resolve(audioOf(20));
    pending[0]?.resolve(audioOf(10));
    await flush();
    expect(log).toEqual(['start 0 server']);
    expect(context.sources[0]?.started).toBe(true);
    expect(fetchSpeech).toHaveBeenCalledTimes(3);

    context.sources[0]?.finish();
    await flush();
    expect(log).toEqual(['start 0 server', 'end 0 done', 'start 1 server']);
    context.sources[1]?.finish();
    pending[2]?.resolve(audioOf(5));
    await flush(10);
    context.sources[2]?.finish();
    await flush();
    expect(log.slice(-3)).toEqual(['start 2 server', 'end 2 done', 'idle']);
    expect(player.busy).toBe(false);
  });

  it('stops at once on barge-in and aborts what was prefetched', async () => {
    const { context, pending, player, log, audioOf } = setup();
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    pending[0]?.resolve(audioOf(10));
    await flush();
    expect(player.current?.seq).toBe(0);

    player.stop();
    await flush();
    expect(context.sources[0]?.stopped).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(true);
    expect(log).toEqual(['start 0 server', 'end 0 cut']);
    expect(player.busy).toBe(false);
  });

  it('ducks and restores the volume', async () => {
    const { context, pending, player, audioOf } = setup();
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    const gain = context.sources[0]?.connections[0] as unknown as { gain: { value: number } };
    player.duck();
    expect(gain.gain.value).toBeCloseTo(0.2);
    player.unduck();
    expect(gain.gain.value).toBe(1);
  });

  it('reads validated text with the browser voice when the server has no speech (501)', async () => {
    const { synthesis, pending, fetchSpeech, player, log } = setup();
    player.enqueue(unit(0, 'Hello Maya.'));
    player.enqueue(unit(1, 'How did the interviews go?'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['start 0 browser']);
    expect(synthesis.spoken.map((u) => u.text)).toEqual(['Hello Maya.']);

    synthesis.finish();
    await flush(10);
    // Once the server said 501, later units go straight to the browser voice.
    expect(log).toContain('start 1 browser');
    expect(synthesis.spoken.map((u) => u.text)).toEqual(['Hello Maya.', 'How did the interviews go?']);
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
  });

  it('never reads with an online browser voice: without a voice on the device, a 501 shows captions', async () => {
    const { synthesis, pending, player, log } = setup();
    // Chrome's "Google …" voices send the text to an online service.
    synthesis.voices = [fakeVoice('Google US English', false)];
    player.enqueue(unit(0, 'Hello Maya.'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['start 0 captions']);
    expect(synthesis.spoken).toHaveLength(0);
  });

  it('shows captions for a 501 when no browser synthesis is offered (production builds)', async () => {
    const { pending, player, log } = setup({ synthesis: false });
    player.enqueue(unit(0, 'Hello Maya.'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['start 0 captions']);
  });

  it('picks the local English voice, never an online one', () => {
    const synthesis = new FakeSpeechSynthesis();
    synthesis.voices = [
      fakeVoice('Google US English', false),
      fakeVoice('Thomas', true, 'fr-FR'),
      fakeVoice('Samantha', true),
    ];
    expect(localEnglishVoice(synthesis)?.name).toBe('Samantha');
    expect(localEnglishVoice(null)).toBeNull();
  });

  it('finishes a browser utterance that never reports its end', async () => {
    const { pending, player, log } = setup();
    player.enqueue(unit(0, 'Short.'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    vi.advanceTimersByTime(readingTimeMs('Short.') * 2);
    await flush();
    expect(log).toEqual(['start 0 browser', 'end 0 done', 'idle']);
  });

  it('shows a unit whose voice failed as words only, and asks for the voice again for the next one', async () => {
    const { context, synthesis, pending, fetchSpeech, player, log, audioOf } = setup();
    player.enqueue(unit(0, 'Twelve is a good start.'));
    player.enqueue(unit(1, 'What did they say about price?'));
    // A dropped connection or a busy synthesiser: this unit only.
    pending[0]?.resolve({ kind: 'failed' });
    await flush();
    expect(log).toEqual(['start 0 captions']);
    expect(synthesis.spoken).toHaveLength(0);
    pending[1]?.resolve(audioOf(10));
    vi.advanceTimersByTime(readingTimeMs('Twelve is a good start.'));
    await flush(10);
    expect(log).toEqual(['start 0 captions', 'end 0 done', 'start 1 server']);
    expect(context.sources[0]?.started).toBe(true);

    // A later unit after a transient failure is fetched from the server again.
    context.sources[0]?.finish();
    await flush();
    player.enqueue(unit(2));
    expect(fetchSpeech).toHaveBeenCalledTimes(3);
  });

  it('shows an already played unit as words, quietly, and never asks for it again (409)', async () => {
    const { context, pending, fetchSpeech, player, log, audioOf } = setup();
    player.enqueue(unit(0, 'Hi Maya.'));
    player.enqueue(unit(1, 'What did they say?'));
    pending[0]?.resolve({ kind: 'played' });
    pending[1]?.resolve(audioOf(10));
    await flush();
    // Heard already: its caption shows, and the call keeps saying it speaks (the route stays the server's).
    expect(log).toEqual(['start 0 server']);
    vi.advanceTimersByTime(readingTimeMs('Hi Maya.'));
    await flush(10);
    expect(log).toEqual(['start 0 server', 'end 0 done', 'start 1 server']);
    expect(context.sources).toHaveLength(1);
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
  });

  it('pauses the voice for the rest of the call when its speech budget is used up (429), and says so', async () => {
    const paused = vi.fn();
    const context = new FakeAudioContext();
    const pending: { resolve: (result: SpeechFetchResult) => void }[] = [];
    const fetchSpeech = vi.fn(
      () =>
        new Promise<SpeechFetchResult>((resolve) => {
          pending.push({ resolve });
        }),
    );
    const log: string[] = [];
    const player = new SpeechPlayer(
      {
        context,
        fetchSpeech,
        synthesis: null,
        createUtterance: (text: string) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
        setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
        clearTimeout: (handle: unknown) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
        now: () => Date.now(),
      } as unknown as PlayerAudio,
      {
        onUnitStart: (u, route) => log.push(`start ${String(u.seq)} ${route}`),
        onUnitEnd: () => undefined,
        onIdle: () => undefined,
        onVoicePaused: paused,
      },
    );
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    pending[0]?.resolve({ kind: 'paused' });
    await flush();
    expect(paused).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['start 0 captions']);
    vi.advanceTimersByTime(readingTimeMs('Sentence 0.'));
    await flush(10);
    // The rest of the call is words only, without asking for speech again.
    expect(log).toEqual(['start 0 captions', 'start 1 captions']);
    expect(fetchSpeech.mock.calls.length).toBeLessThanOrEqual(2);
    player.enqueue(unit(2));
    expect(fetchSpeech.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('keeps words only for the rest of the call when the server refuses its speech', async () => {
    const { synthesis, pending, fetchSpeech, player, log } = setup();
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    // The kill switch or a cap: no voice for this call any more, and no browser voice instead.
    pending[0]?.resolve({ kind: 'refused' });
    await flush();
    expect(log).toEqual(['start 0 captions']);
    // The prefetched unit is prepared again without asking the server.
    expect(pending[1]?.signal.aborted).toBe(true);
    vi.advanceTimersByTime(readingTimeMs('Sentence 0.'));
    await flush(10);
    expect(log).toEqual(['start 0 captions', 'end 0 done', 'start 1 captions']);
    player.enqueue(unit(2));
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
    expect(synthesis.spoken).toHaveLength(0);
  });

  it('falls back to captions when there is no browser voice either', async () => {
    const { pending, player, log } = setup({ synthesis: false });
    player.enqueue(unit(0));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['start 0 captions']);
  });

  it('treats undecodable audio as words only for that unit', async () => {
    const { context, pending, player, log, audioOf } = setup();
    context.decodeFails = true;
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    pending[0]?.resolve(audioOf(10));
    await flush();
    expect(log).toEqual(['start 0 captions']);
    context.decodeFails = false;
    pending[1]?.resolve(audioOf(10));
    vi.advanceTimersByTime(readingTimeMs('Sentence 0.'));
    await flush(10);
    expect(log.at(-1)).toBe('start 1 server');
  });

  it('reports the level of what is playing', async () => {
    const { context, pending, player, audioOf } = setup();
    expect(player.level()).toBe(0);
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    const analyser = context.analysers[0];
    if (analyser) analyser.level = 0.25;
    expect(player.level()).toBeCloseTo(0.25);
  });
});

/** A face whose every step the test drives (a vendor's speech-to-video, or the stand-in). */
class ScriptedFace implements FaceRenderer {
  live = true;
  readonly renders: {
    buffer: AudioBuffer;
    output: FaceRendererOutput;
    handlers: FaceRenderHandlers;
    stopped: boolean;
  }[] = [];
  ready(): boolean {
    return this.live;
  }
  render(buffer: AudioBuffer, output: FaceRendererOutput, handlers: FaceRenderHandlers): () => void {
    const entry = { buffer, output, handlers, stopped: false };
    this.renders.push(entry);
    return () => {
      entry.stopped = true;
    };
  }
}

describe('SpeechPlayer with a face that renders the call’s audio (voicing audio)', () => {
  it('hands each unit’s audio to the face and announces it at the face’s first sound', async () => {
    const { context, pending, player, log, audioOf } = setup();
    const face = new ScriptedFace();
    player.setFace(face);
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    // Handed over, not yet heard: no caption, nothing through the speakers.
    expect(face.renders).toHaveLength(1);
    expect(context.sources).toHaveLength(0);
    expect(log).toEqual([]);
    // The face plays into the player's own gain (→ analyser → speakers): ducking and loudness unchanged.
    const gain = face.renders[0]?.output.destination as unknown as { connections: unknown[] };
    expect(gain.connections[0]).toBe(context.analysers[0]);

    face.renders[0]?.handlers.onStart();
    expect(log).toEqual(['start 0 server']);
    face.renders[0]?.handlers.onEnd('ended');
    await flush();
    expect(log).toEqual(['start 0 server', 'end 0 done', 'idle']);
  });

  it('plays a unit itself when the face fails before its first sound, so no sentence is lost', async () => {
    const { context, pending, player, log, audioOf } = setup();
    const face = new ScriptedFace();
    player.setFace(face);
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    face.renders[0]?.handlers.onEnd('failed');
    expect(context.sources[0]?.started).toBe(true);
    expect(context.sources[0]?.buffer).toBe(face.renders[0]?.buffer);
    expect(log).toEqual(['start 0 server']);
    context.sources[0]?.finish();
    await flush();
    expect(log).toEqual(['start 0 server', 'end 0 done', 'idle']);
  });

  it('stops the face at once on barge-in, and never announces a unit it starts afterwards', async () => {
    const { pending, player, log, audioOf } = setup();
    const face = new ScriptedFace();
    player.setFace(face);
    player.enqueue(unit(0));
    player.enqueue(unit(1));
    pending[0]?.resolve(audioOf(10));
    await flush();
    face.renders[0]?.handlers.onStart();
    player.stop();
    await flush();
    expect(face.renders[0]?.stopped).toBe(true);
    expect(log).toEqual(['start 0 server', 'end 0 cut']);

    player.enqueue(unit(2));
    pending[2]?.resolve(audioOf(10));
    await flush();
    player.stop();
    face.renders[1]?.handlers.onStart();
    face.renders[1]?.handlers.onEnd('ended');
    await flush();
    expect(log).toEqual(['start 0 server', 'end 0 cut', 'end 2 cut']);
  });

  it('uses the speakers while the face is not ready or after it is removed', async () => {
    const { context, pending, player, log, audioOf } = setup();
    const face = new ScriptedFace();
    face.live = false;
    player.setFace(face);
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    expect(face.renders).toHaveLength(0);
    expect(context.sources[0]?.started).toBe(true);
    expect(log).toEqual(['start 0 server']);
    context.sources[0]?.finish();
    await flush();

    face.live = true;
    player.setFace(null);
    player.enqueue(unit(1));
    pending[1]?.resolve(audioOf(10));
    await flush();
    expect(face.renders).toHaveLength(0);
    expect(context.sources[1]?.started).toBe(true);
  });

  it('counts a unit as heard when the face never reports its end', async () => {
    const { pending, player, log, audioOf } = setup();
    const face = new ScriptedFace();
    player.setFace(face);
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(1000));
    await flush();
    face.renders[0]?.handlers.onStart();
    // One second of audio plus the face's allowance.
    vi.advanceTimersByTime(1000 + 3_999);
    await flush();
    expect(log).toEqual(['start 0 server']);
    vi.advanceTimersByTime(1);
    await flush();
    expect(log).toEqual(['start 0 server', 'end 0 done', 'idle']);
  });
});
