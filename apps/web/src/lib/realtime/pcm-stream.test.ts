import { describe, expect, it } from 'vitest';

import {
  FADE_MS,
  JITTER_MS,
  LinearResampler,
  PcmStream,
  SLICE_MS,
  STOP_FADE_MS,
  type PcmSink,
} from './pcm-stream';
import { FakeAudioContext, type FakeGain, FakeNode, flush } from './testing';

const RATE = 24_000;

/** A response body the test feeds: `push` hands over bytes, `end` closes it, `fail` breaks it. */
function body() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (bytes: Uint8Array) => {
      controller.enqueue(bytes);
    },
    end: () => {
      controller.close();
    },
    fail: () => {
      controller.error(new TypeError('network'));
    },
    cancelled: () => cancelled,
  };
}

/** `ms` of 16-bit PCM at {@link RATE} whose samples are all `value`. */
function pcm(ms: number, value = 1_000): Uint8Array {
  const samples = Math.round((ms / 1000) * RATE);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true);
  return bytes;
}

/** A context at the stream's own rate (no resampling), unless a rate is given. */
function audioContext(sampleRate = RATE): FakeAudioContext {
  const context = new FakeAudioContext();
  context.sampleRate = sampleRate;
  return context;
}

/** The unit's own gain (the one PcmStream made: the newest gain of the context). */
function unitGain(context: FakeAudioContext): FakeGain {
  const gain = context.gains.at(-1);
  if (gain === undefined) throw new Error('no unit gain');
  return gain;
}

function sink(context: FakeAudioContext) {
  const timers: { cb: () => void; ms: number }[] = [];
  const destination = new FakeNode();
  const s = {
    context,
    destination,
    setTimeout: (cb: () => void, ms: number) => {
      const timer = { cb, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      const i = timers.indexOf(handle as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  } as unknown as PcmSink;
  return { sink: s, destination, timers };
}

describe('PcmStream: a unit played as its PCM arrives', () => {
  it('holds a small jitter buffer, then schedules each piece right after the one before', async () => {
    const context = audioContext();
    const { sink: out, destination } = sink(context);
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    const events: string[] = [];
    stream.play(out, {
      onStart: () => events.push('start'),
      onEnd: (heard) => events.push(`end ${String(heard)}`),
    });

    // Less than the jitter buffer: nothing plays yet.
    b.push(pcm(JITTER_MS / 2));
    await flush();
    expect(context.sources).toHaveLength(0);
    // The jitter buffer is full: the first piece starts, before the unit has finished arriving.
    b.push(pcm(JITTER_MS / 2));
    await flush();
    expect(events).toEqual(['start']);
    expect(context.sources).toHaveLength(1);
    // source → the unit's gain (its fades) → the player's gain.
    expect(context.sources[0]?.connections[0]).toBe(unitGain(context));
    expect(unitGain(context).connections[0]).toBe(destination);
    expect(context.sources[0]?.startAt).toBeCloseTo(0.01, 5);
    expect(context.buffers[0]?.sampleRate).toBe(RATE);
    expect(context.buffers[0]?.samples.length).toBe((JITTER_MS / 1000) * RATE);
    expect(context.buffers[0]?.samples[0]).toBeCloseTo(1_000 / 32_768, 6);

    // Each later slice is queued back to back (no gap, no overlap).
    b.push(pcm(SLICE_MS));
    await flush();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1]?.startAt).toBeCloseTo(0.01 + JITTER_MS / 1000, 5);

    // The rest arrives and the stream ends: what is left is scheduled, and the unit ends after its last piece.
    b.push(pcm(10));
    b.end();
    await flush(10);
    expect(context.sources).toHaveLength(3);
    for (const source of context.sources) source.finish();
    expect(events).toEqual(['start', 'end true']);
  });

  it('plays at once what arrived before its turn (prefetched), and a stream shorter than the buffer whole', async () => {
    const context = audioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    b.push(pcm(30));
    b.end();
    await flush(10);
    expect(stream.received).toBe(0.03 * RATE);
    const events: string[] = [];
    stream.play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: (heard) => events.push(`end ${String(heard)}`),
    });
    expect(context.sources).toHaveLength(1);
    context.sources[0]?.finish();
    expect(events).toEqual(['start', 'end true']);
  });

  it('skips the start a face already made heard: what arrived and what is still to come, never more', async () => {
    const context = audioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    // 30 ms arrived (in two pieces), 50 ms more to come; the first 40 ms were heard elsewhere.
    b.push(pcm(10, 1));
    b.push(pcm(20, 2));
    await flush(10);
    stream.skip(40);
    b.push(pcm(50, 3));
    b.end();
    await flush(10);
    const events: string[] = [];
    stream.play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: (heard) => events.push(`end ${String(heard)}`),
    });
    const samples = context.sources.flatMap((source) => [...(source.buffer?.getChannelData(0) ?? [])]);
    // 80 ms in all, 40 ms skipped: the last 40 ms, every one from the third piece.
    expect(samples).toHaveLength(0.04 * RATE);
    expect(samples.every((v) => Math.abs(v - 3 / 32_768) < 1e-9)).toBe(true);
    expect(stream.received).toBe(0.08 * RATE);
  });

  it('a skip past everything plays nothing and ends unheard', async () => {
    const context = audioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    b.push(pcm(30));
    b.end();
    await flush(10);
    stream.skip(500);
    const events: string[] = [];
    stream.play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: (heard) => events.push(`end ${String(heard)}`),
    });
    expect(context.sources).toHaveLength(0);
    expect(events).toEqual(['end false']);
  });

  it('joins a sample split across two chunks', async () => {
    const context = audioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    stream.play(sink(context).sink, { onStart: () => undefined, onEnd: () => undefined });
    const bytes = pcm(JITTER_MS, -2_000);
    b.push(bytes.slice(0, 3));
    b.push(bytes.slice(3));
    b.end();
    await flush(10);
    const samples = context.buffers.flatMap((buffer) => [...buffer.samples]);
    expect(samples).toHaveLength(bytes.length / 2);
    expect(samples.every((s) => Math.abs(s - -2_000 / 32_768) < 1e-6)).toBe(true);
  });

  it('stops at once: scheduled pieces stop, the read is cancelled, and nothing arriving later is scheduled', async () => {
    const context = audioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    const events: string[] = [];
    const out = sink(context);
    const stop = stream.play(out.sink, {
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
    });
    b.push(pcm(JITTER_MS + SLICE_MS));
    await flush();
    expect(context.sources).toHaveLength(1);
    context.currentTime = 0.05;
    stop();
    // Every scheduled piece stops at the end of a short fade (no click), which starts now.
    expect(context.sources[0]?.stopped).toBe(true);
    expect(context.sources[0]?.stopAt).toBeCloseTo(0.05 + STOP_FADE_MS / 1000, 9);
    const gain = unitGain(context).gain;
    expect(gain.valueAt(0.05 + STOP_FADE_MS / 1000)).toBe(0);
    expect(gain.valueAt(1)).toBe(0);
    // Once the fade has played, the unit's nodes leave the graph.
    const cleanup = out.timers.at(-1);
    cleanup?.cb();
    expect(context.sources[0]?.connections).toHaveLength(0);
    expect(unitGain(context).connections).toHaveLength(0);
    await flush();
    expect(b.cancelled()).toBe(true);
    // Stale audio after the stop is never scheduled (the read was cancelled; even a late chunk is dropped).
    try {
      b.push(pcm(200));
    } catch {
      /* the body was cancelled */
    }
    await flush(10);
    expect(context.sources).toHaveLength(1);
    expect(events).toEqual(['start']);
  });

  it('a stream that brings no audio ends unheard; one that breaks plays what came', async () => {
    const context = audioContext();
    const empty = body();
    const events: string[] = [];
    new PcmStream(empty.stream, RATE).play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: (heard) => events.push(`end ${String(heard)}`),
    });
    empty.end();
    await flush(10);
    expect(events).toEqual(['end false']);

    const broken = body();
    const heard: string[] = [];
    new PcmStream(broken.stream, RATE).play(sink(context).sink, {
      onStart: () => heard.push('start'),
      onEnd: (h) => heard.push(`end ${String(h)}`),
    });
    broken.push(pcm(20));
    await flush();
    broken.fail();
    await flush(10);
    expect(heard).toEqual(['start']);
    context.sources.at(-1)?.finish();
    expect(heard).toEqual(['start', 'end true']);
  });

  it('a suspended context that never ends its pieces is guarded', async () => {
    const context = audioContext();
    const { sink: out, timers } = sink(context);
    const b = body();
    const events: string[] = [];
    new PcmStream(b.stream, RATE).play(out, { onStart: () => undefined, onEnd: () => events.push('end') });
    b.push(pcm(JITTER_MS));
    b.end();
    await flush(10);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeGreaterThan(JITTER_MS);
    timers[0]?.cb();
    expect(events).toEqual(['end']);
  });

  it('on a 44.1 kHz context (macOS Safari) resamples once, at the context rate, and joins pieces on whole frames', async () => {
    const context = audioContext(44_100);
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    stream.play(sink(context).sink, { onStart: () => undefined, onEnd: () => undefined });
    // A 440 Hz tone in uneven network chunks.
    const total = Math.round(0.4 * RATE);
    const tone = new Uint8Array(total * 2);
    const view = new DataView(tone.buffer);
    for (let i = 0; i < total; i += 1)
      view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 16_000), true);
    for (const [from, to] of [
      [0, 1_001],
      [1_001, 5_003],
      [5_003, 5_004],
      [5_004, 9_999],
      [9_999, tone.length],
    ] as const) {
      b.push(tone.slice(from, to));
      await flush();
    }
    b.end();
    await flush(10);
    expect(context.sources.length).toBeGreaterThan(2);
    // Every buffer is at the context's rate: the browser resamples nothing.
    expect(context.buffers.every((buffer) => buffer.sampleRate === 44_100)).toBe(true);
    // Each piece starts on a whole frame, exactly where the one before ended.
    let frame = Math.round((context.sources[0]?.startAt ?? 0) * 44_100);
    context.sources.forEach((source, i) => {
      const at = (source.startAt ?? 0) * 44_100;
      expect(Math.abs(at - Math.round(at))).toBeLessThan(1e-6);
      expect(Math.round(at)).toBe(frame);
      frame += context.buffers[i]?.samples.length ?? 0;
    });
    // The pieces together are one continuous signal: the same as resampling the whole unit in one pass.
    const played = context.buffers.flatMap((buffer) => [...buffer.samples]);
    const whole = new Float32Array(total);
    for (let i = 0; i < total; i += 1) whole[i] = view.getInt16(i * 2, true) / 32_768;
    const reference = new LinearResampler(RATE, 44_100).push(whole);
    expect(played).toHaveLength(reference.length);
    expect(played.every((v, i) => Math.abs(v - (reference[i] ?? NaN)) < 1e-6)).toBe(true);
    // No step at any join: neighbouring samples of a 440 Hz tone differ by far less than a click would.
    const maxStep = Math.max(...played.slice(1).map((v, i) => Math.abs(v - (played[i] ?? 0))));
    expect(maxStep).toBeLessThan(0.04);
  });

  it('fades in at the start, keeps a join seamless, and fades out and back in around an underrun', async () => {
    const context = audioContext(48_000);
    const b = body();
    new PcmStream(b.stream, RATE).play(sink(context).sink, {
      onStart: () => undefined,
      onEnd: () => undefined,
    });
    const gain = unitGain(context).gain;
    b.push(pcm(JITTER_MS));
    await flush();
    const firstAt = context.sources[0]?.startAt ?? NaN;
    const length = (i: number) => (context.buffers[i]?.samples.length ?? NaN) / 48_000;
    const firstEnd = firstAt + length(0);
    // The first piece fades in over FADE_MS, and (as the newest) out at its end.
    expect(gain.valueAt(firstAt)).toBeCloseTo(0, 9);
    expect(gain.valueAt(firstAt + FADE_MS / 1000)).toBe(1);
    expect(gain.valueAt(firstEnd - FADE_MS / 2000)).toBeCloseTo(0.5, 6);
    expect(gain.valueAt(firstEnd)).toBeCloseTo(0, 9);

    // The next piece arrives in time: joined on, the fade-out between them is cancelled (full level through the join).
    b.push(pcm(SLICE_MS));
    await flush();
    const secondAt = context.sources[1]?.startAt ?? NaN;
    expect(secondAt).toBeCloseTo(firstEnd, 9);
    for (const t of [firstEnd - 0.003, firstEnd - 0.0005, firstEnd, firstEnd + 0.002]) {
      expect(gain.valueAt(t)).toBe(1);
    }
    const secondEnd = secondAt + length(1);
    expect(gain.valueAt(secondEnd)).toBeCloseTo(0, 9);

    // The network falls behind: the second piece has played out (faded to silence, no hard stop) before the third
    // arrives, which starts fresh on a whole frame and fades in.
    context.currentTime = secondEnd + 0.05;
    b.push(pcm(SLICE_MS));
    await flush();
    const thirdAt = context.sources[2]?.startAt ?? NaN;
    expect(thirdAt).toBeGreaterThan(context.currentTime);
    expect(Math.abs(thirdAt * 48_000 - Math.round(thirdAt * 48_000))).toBeLessThan(1e-6);
    expect(gain.valueAt(secondEnd - FADE_MS / 2000)).toBeCloseTo(0.5, 6);
    expect(gain.valueAt(thirdAt)).toBeCloseTo(0, 9);
    expect(gain.valueAt(thirdAt + FADE_MS / 1000)).toBe(1);
  });

  it('schedules nothing after a stop: a late chunk, a resolved read or the stream end schedules no stale audio', async () => {
    const context = audioContext(44_100);
    const b = body();
    const events: string[] = [];
    const stream = new PcmStream(b.stream, RATE);
    const stop = stream.play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
    });
    b.push(pcm(JITTER_MS + SLICE_MS));
    b.push(pcm(SLICE_MS));
    await flush();
    const scheduled = context.sources.length;
    expect(scheduled).toBeGreaterThan(0);
    stop();
    expect(context.sources.every((source) => source.stopped)).toBe(true);
    try {
      b.push(pcm(300));
      b.end();
    } catch {
      /* the body was cancelled */
    }
    await flush(20);
    expect(context.sources).toHaveLength(scheduled);
    expect(context.buffers).toHaveLength(scheduled);
    expect(events).toEqual(['start']);
  });
});

describe('LinearResampler', () => {
  const signal = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5);

  it('is the identity at equal rates', () => {
    const input = signal(100);
    expect(new LinearResampler(24_000, 24_000).push(input)).toBe(input);
  });

  it.each([
    [24_000, 44_100],
    [24_000, 48_000],
    [16_000, 44_100],
    [16_000, 48_000],
  ])('%i → %i: the same samples however the input is cut', (from, to) => {
    const input = signal(4_801);
    const whole = new LinearResampler(from, to).push(input);
    const pieces = new LinearResampler(from, to);
    const cut = [0, 1, 2, 333, 334, 1_000, 2_999, 4_800, 4_801];
    const out: number[] = [];
    for (let i = 0; i < cut.length - 1; i += 1) {
      out.push(...pieces.push(input.slice(cut[i], cut[i + 1])));
    }
    expect(out).toHaveLength(whole.length);
    expect(out.every((v, i) => Math.abs(v - (whole[i] ?? NaN)) < 1e-6)).toBe(true);
    // As many output samples as the duration needs (the last input sample included).
    expect(whole.length).toBe(Math.floor(((input.length - 1) * to) / from) + 1);
    // The first sample and every exact input instant are the input's own.
    expect(whole[0]).toBeCloseTo(input[0] ?? NaN, 6);
  });
});
