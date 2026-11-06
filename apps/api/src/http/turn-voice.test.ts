import { type TurnStreamEvent } from '@foundry/contracts';
import { type TurnVoice, type TurnVoiceAudio } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { MAX_FRAME_BYTES, TurnAudio, VOICE_AHEAD } from './turn-voice.js';

const TURN = '0b9f3c1e-8a52-4d6b-9e7f-2c1d0a3b4c5d';
const logger = createJsonLogger({ level: 'error', write: () => undefined });

function unit(seq: number, text = `Sentence ${String(seq)}.`, extra: Partial<TurnStreamEvent> = {}) {
  return {
    event: 'turn.speech',
    turnId: TURN,
    seq,
    text,
    sig: 's'.repeat(20),
    final: false,
    ...extra,
  } as Extract<TurnStreamEvent, { event: 'turn.speech' }>;
}

/** A PCM stream the test feeds by hand. */
function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const audio = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    audio,
    push: (bytes: Uint8Array) => {
      // A vendor stream already cancelled takes nothing more.
      if (!cancelled) controller.enqueue(bytes);
    },
    close: () => {
      controller.close();
    },
    fail: () => {
      controller.error(new Error('vendor stream broke'));
    },
    cancelled: () => cancelled,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A voice whose units answer what the test hands each (`answers[seq]`). */
function fakeVoice(answers: Map<number, () => Promise<TurnVoiceAudio>>, voices = (_: string) => true) {
  const calls: { seq: number; previousText: string | undefined; signal: AbortSignal | undefined }[] = [];
  const voice: TurnVoice = {
    voices,
    speak: (u, options) => {
      calls.push({ seq: u.seq, previousText: options.previousText, signal: options.signal });
      const answer = answers.get(u.seq);
      return answer === undefined ? Promise.resolve({ kind: 'failed' }) : answer();
    },
  };
  return { voice, calls };
}

function rig(
  voice: TurnVoice | null | Promise<TurnVoice | null>,
  controller = new AbortController(),
  prepareWaitMs?: number,
) {
  const out: TurnStreamEvent[] = [];
  const prepared = voice instanceof Promise ? voice : Promise.resolve(voice);
  const audio = new TurnAudio({
    voice: () => prepared,
    ...(prepareWaitMs === undefined ? {} : { prepareWaitMs }),
    signal: controller.signal,
    push: (event) => out.push(event),
    logger,
    requestId: 'req-1',
  });
  /** As the turn stream writes: the event, then its audio starts. */
  const write = async (event: TurnStreamEvent) => {
    const { event: written, start } = await audio.announce(event);
    out.push(written);
    start?.();
  };
  return { audio, out, write, controller };
}

const frames = (out: TurnStreamEvent[], seq: number) =>
  out.filter(
    (e): e is Extract<TurnStreamEvent, { event: 'turn.audio' }> => e.event === 'turn.audio' && e.seq === seq,
  );

describe('TurnAudio', () => {
  it('announces a voiced unit, then streams its PCM after it, its rate first and a closing frame last', async () => {
    const a = feed();
    const { voice, calls } = fakeVoice(
      new Map([
        [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
      ]),
    );
    const r = rig(voice);
    await r.write(unit(0));
    expect(r.out[0]).toMatchObject({ event: 'turn.speech', seq: 0, audio: true });
    a.push(new Uint8Array([1, 2, 3, 4]));
    a.push(new Uint8Array([5, 6]));
    a.close();
    await r.audio.drained();
    const sent = frames(r.out, 0);
    expect(sent.map((f) => [f.pcm, f.sampleRate, f.end])).toEqual([
      [Buffer.from([1, 2, 3, 4]).toString('base64'), 24_000, undefined],
      [Buffer.from([5, 6]).toString('base64'), undefined, undefined],
      [undefined, undefined, 'done'],
    ]);
    expect(r.out.indexOf(sent[0] as TurnStreamEvent)).toBeGreaterThan(0);
    expect(calls.map((c) => [c.seq, c.previousText])).toEqual([[0, undefined]]);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    // The turn's own signal, aborted with the stream's.
    expect(calls[0]?.signal?.aborted).toBe(false);
    r.controller.abort();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(r.audio.stats).toMatchObject({ units: 1, frames: 2, bytes: 6, failed: 0 });
  });

  it('cuts a large piece into frames of at most MAX_FRAME_BYTES', async () => {
    const a = feed();
    const r = rig(
      fakeVoice(
        new Map([
          [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 16_000 } as const)],
        ]),
      ).voice,
    );
    await r.write(unit(0));
    a.push(new Uint8Array(MAX_FRAME_BYTES * 2 + 10));
    a.close();
    await r.audio.drained();
    const sizes = frames(r.out, 0)
      .filter((f) => f.pcm !== undefined)
      .map((f) => Buffer.from(f.pcm ?? '', 'base64').byteLength);
    expect(sizes).toEqual([MAX_FRAME_BYTES, MAX_FRAME_BYTES, 10]);
  });

  it('hands each unit the words of the one before it in the same reply, and voices at most VOICE_AHEAD at once', async () => {
    const streams = [feed(), feed(), feed()];
    const answers = new Map(
      streams.map((s, seq) => [
        seq,
        () => Promise.resolve({ kind: 'audio', audio: s.audio, sampleRateHertz: 24_000 } as const),
      ]),
    );
    const { voice, calls } = fakeVoice(answers);
    const r = rig(voice);
    await r.write(unit(0, 'First one.'));
    await r.write(unit(1, 'Second one.'));
    await r.write(unit(2, 'Third one.'));
    await tick();
    expect(VOICE_AHEAD).toBe(2);
    // The third waits until one of the first two is sent whole.
    expect(calls.map((c) => c.seq)).toEqual([0, 1]);
    for (const s of streams) s.push(new Uint8Array([0, 0]));
    streams[0]?.close();
    await tick();
    await tick();
    expect(calls.map((c) => [c.seq, c.previousText])).toEqual([
      [0, undefined],
      [1, 'First one.'],
      [2, 'Second one.'],
    ]);
    streams[1]?.close();
    streams[2]?.close();
    await r.audio.drained();
    expect(frames(r.out, 2).at(-1)?.end).toBe('done');
  });

  it('leaves to POST /speech a unit it does not voice: the crisis line, a turn without a voice here', async () => {
    const { voice, calls } = fakeVoice(new Map(), (text) => text !== 'Crisis line.');
    const r = rig(voice);
    await r.write(unit(1, 'Crisis line.'));
    await r.write({ event: 'turn.delta', turnId: TURN, seq: 0, text: 'Hello.' });
    await r.audio.drained();
    expect(r.out.map((e) => (e.event === 'turn.speech' ? e.audio : e.event))).toEqual([
      undefined,
      'turn.delta',
    ]);
    expect(calls).toEqual([]);

    const none = rig(null);
    await none.write(unit(0));
    await none.audio.drained();
    expect(none.out).toEqual([unit(0)]);
  });

  it('voices a unit a LITE face the page feeds was admitted to (face: true): the face plays this same PCM', async () => {
    const a = feed();
    const r = rig(
      fakeVoice(
        new Map([
          [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
        ]),
      ).voice,
    );
    await r.write(unit(0, 'Hello there.', { face: true }));
    expect(r.out[0]).toMatchObject({ face: true, audio: true });
    a.push(new Uint8Array([1, 2]));
    a.close();
    await r.audio.drained();
    expect(frames(r.out, 0).at(-1)?.end).toBe('done');
  });

  it('closes a unit it could not voice with why, so the page asks POST /speech or pauses the voice', async () => {
    const { voice } = fakeVoice(
      new Map<number, () => Promise<TurnVoiceAudio>>([
        [0, () => Promise.resolve({ kind: 'failed' })],
        [1, () => Promise.resolve({ kind: 'paused' })],
        [2, () => Promise.reject(new Error('boom'))],
      ]),
    );
    const r = rig(voice);
    await r.write(unit(0));
    await r.write(unit(1));
    await r.write(unit(2));
    await r.audio.drained();
    expect([0, 1, 2].map((seq) => frames(r.out, seq).map((f) => f.end))).toEqual([
      ['failed'],
      ['paused'],
      ['failed'],
    ]);
    expect(r.audio.stats.failed).toBe(3);
  });

  it('ends a unit whose voice broke after its first audio where the audio stopped', async () => {
    const a = feed();
    const r = rig(
      fakeVoice(
        new Map([
          [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
        ]),
      ).voice,
    );
    await r.write(unit(0));
    a.push(new Uint8Array([1, 2]));
    await tick();
    a.fail();
    await r.audio.drained();
    expect(frames(r.out, 0).map((f) => f.end ?? 'pcm')).toEqual(['pcm', 'done']);
  });

  it('a barge-in (the stream aborted) cancels the synthesis at once and sends nothing more of it', async () => {
    const a = feed();
    const r = rig(
      fakeVoice(
        new Map([
          [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
        ]),
      ).voice,
    );
    await r.write(unit(0));
    a.push(new Uint8Array([1, 2]));
    await tick();
    r.controller.abort();
    a.push(new Uint8Array([3, 4]));
    await r.audio.drained();
    expect(a.cancelled()).toBe(true);
    expect(frames(r.out, 0).filter((f) => f.pcm !== undefined)).toHaveLength(1);
    // Nothing is announced with audio after it.
    await r.write(unit(1));
    expect(r.out.at(-1)).toEqual(unit(1));
  });

  it('a turn withdrawn (blocked or failed) synthesizes, bills and sends nothing more: every open unit is refused', async () => {
    const a = feed();
    // Unit 1 is still being synthesized when the turn is withdrawn; it honours the signal it was handed.
    const inFlight = (signal: AbortSignal | undefined) =>
      new Promise<TurnVoiceAudio>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    const calls: { seq: number; signal: AbortSignal | undefined }[] = [];
    const voice: TurnVoice = {
      voices: () => true,
      speak: (u, options) => {
        calls.push({ seq: u.seq, signal: options.signal });
        if (u.seq === 0)
          return Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const);
        return inFlight(options.signal);
      },
    };
    const r = rig(voice);
    await r.write(unit(0));
    await r.write(unit(1));
    await r.write(unit(2)); // waits for a slot (VOICE_AHEAD)
    a.push(new Uint8Array([1, 2]));
    await tick();
    expect(frames(r.out, 0).filter((f) => f.pcm !== undefined)).toHaveLength(1);

    r.audio.withdraw(TURN.toUpperCase());
    r.out.push({
      event: 'turn.blocked',
      turnId: TURN,
      reason: 'identity',
      escalationId: null,
      supportMessage: null,
    });
    a.push(new Uint8Array([3, 4]));
    await r.audio.drained();
    const terminal = r.out.findIndex((e) => e.event === 'turn.blocked');
    // No PCM after the terminal event; each unit closed once, refused.
    expect(r.out.slice(terminal).filter((e) => e.event === 'turn.audio' && e.pcm !== undefined)).toEqual([]);
    expect(
      [0, 1, 2].map((seq) =>
        frames(r.out, seq)
          .filter((f) => f.end !== undefined)
          .map((f) => f.end),
      ),
    ).toEqual([['refused'], ['refused'], ['refused']]);
    // The vendor stream was cancelled, the synthesis in flight aborted, the waiting unit never synthesized.
    expect(a.cancelled()).toBe(true);
    expect(calls.map((c) => c.seq)).toEqual([0, 1]);
    expect(calls.every((c) => c.signal?.aborted === true)).toBe(true);
    expect(r.audio.stats).toMatchObject({ withdrawn: 3, failed: 0 });
    // The stream itself was not aborted, and nothing more of the turn is announced with audio.
    expect(r.controller.signal.aborted).toBe(false);
    await r.write(unit(3));
    expect(r.out.at(-1)).toEqual(unit(3));
  });

  it('withdraw(null) (a failed turn with no id) withdraws every unit of the stream', async () => {
    const a = feed();
    const r = rig(
      fakeVoice(
        new Map([
          [0, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
        ]),
      ).voice,
    );
    await r.write(unit(0));
    await tick();
    r.audio.withdraw(null);
    await r.audio.drained();
    expect(frames(r.out, 0).map((f) => f.end)).toEqual(['refused']);
  });

  it('a slow prepare holds the stream back once per turn at most, never once per unit, and is used once it is done', async () => {
    let resolve!: (voice: TurnVoice | null) => void;
    const prepared = new Promise<TurnVoice | null>((r) => {
      resolve = r;
    });
    const a = feed();
    const { voice, calls } = fakeVoice(
      new Map([
        [2, () => Promise.resolve({ kind: 'audio', audio: a.audio, sampleRateHertz: 24_000 } as const)],
      ]),
    );
    const r = rig(prepared, new AbortController(), 50);
    const started = performance.now();
    await r.write(unit(0));
    const first = performance.now() - started;
    await r.write(unit(1));
    await r.write({ event: 'turn.delta', turnId: TURN, seq: 0, text: 'Hello.' });
    const rest = performance.now() - started - first;
    expect(first).toBeGreaterThanOrEqual(40);
    expect(rest).toBeLessThan(20);
    // Written while the checks were unfinished: left to POST /speech.
    expect(r.out.slice(0, 2).map((e) => (e.event === 'turn.speech' ? e.audio : 'x'))).toEqual([
      undefined,
      undefined,
    ]);
    // Done later: the next unit is voiced here.
    resolve(voice);
    await tick();
    await r.write(unit(2));
    expect(r.out.at(-1)).toMatchObject({ seq: 2, audio: true });
    a.close();
    await r.audio.drained();
    expect(calls.map((c) => c.seq)).toEqual([2]);
  });

  it('a prepare that never finishes costs one bounded wait for the whole turn', async () => {
    const r = rig(new Promise<TurnVoice | null>(() => undefined), new AbortController(), 60);
    const started = performance.now();
    for (let seq = 0; seq < 4; seq += 1) await r.write(unit(seq));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(150);
    expect(r.out.every((e) => e.event === 'turn.speech' && e.audio === undefined)).toBe(true);
  });
});
