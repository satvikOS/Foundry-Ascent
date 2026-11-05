import { describe, expect, it } from 'vitest';

import { JITTER_MS, PcmStream, SLICE_MS, type PcmSink } from './pcm-stream';
import { FakeAudioContext, FakeNode, flush } from './testing';

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
    const context = new FakeAudioContext();
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
    expect(context.sources[0]?.connections[0]).toBe(destination);
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
    const context = new FakeAudioContext();
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

  it('joins a sample split across two chunks', async () => {
    const context = new FakeAudioContext();
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
    const context = new FakeAudioContext();
    const b = body();
    const stream = new PcmStream(b.stream, RATE);
    const events: string[] = [];
    const stop = stream.play(sink(context).sink, {
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
    });
    b.push(pcm(JITTER_MS + SLICE_MS));
    await flush();
    expect(context.sources).toHaveLength(1);
    stop();
    expect(context.sources[0]?.stopped).toBe(true);
    expect(context.sources[0]?.connections).toHaveLength(0);
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
    const context = new FakeAudioContext();
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
    const context = new FakeAudioContext();
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
});
