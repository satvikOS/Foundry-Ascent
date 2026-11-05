import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeLiteSocket } from './fake-lite-socket';
import {
  bytesToBase64,
  LITE_CHUNK_BYTES,
  LITE_FIRST_CHUNK_BYTES,
  LiteChunker,
  LiteControl,
  liteAudioMs,
  type LiteEvent,
} from './lite-socket';

/** `ms` of 16-bit mono PCM at `rate`, each sample `value`. */
function pcm(ms: number, rate = 24_000, value = 1000): Uint8Array {
  const samples = Math.round((ms / 1000) * rate);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true);
  return out;
}

describe('LiteChunker: ~1 s chunks of 24 kHz 16-bit mono, the utterance’s first one 200 ms', () => {
  it('passes ElevenLabs’ pcm_24000 through byte for byte, in a 200 ms first chunk and then 1 s chunks', () => {
    expect(LITE_FIRST_CHUNK_BYTES).toBe(9_600);
    expect(LITE_CHUNK_BYTES).toBe(48_000);
    const audio = new Uint8Array(2_500 * 48).map((_, i) => i % 251);
    const chunker = new LiteChunker(24_000, { first: true });
    const out = [...chunker.push(audio.subarray(0, 30_000)), ...chunker.push(audio.subarray(30_000))];
    const rest = chunker.flush();
    const all = rest === null ? out : [...out, rest];
    expect(all.map((c) => c.byteLength)).toEqual([9_600, 48_000, 48_000, 14_400]);
    // Exactly the bytes in, in order.
    const joined = new Uint8Array(all.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of all) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    expect(joined).toEqual(audio);
    expect(chunker.flush()).toBeNull();
  });

  it('cuts a later unit of the utterance in whole seconds from its start (no small first chunk)', () => {
    const chunker = new LiteChunker(24_000, { first: false });
    expect(chunker.push(pcm(900))).toEqual([]);
    expect(chunker.held).toBe(43_200);
    const [second] = chunker.push(pcm(300));
    expect(second?.byteLength).toBe(48_000);
    expect(chunker.flush()?.byteLength).toBe(9_600);
  });

  it('keeps a byte that splits a sample for the next piece', () => {
    const chunker = new LiteChunker(24_000, { first: true });
    const audio = pcm(200);
    expect(chunker.push(audio.subarray(0, 4_801))).toEqual([]);
    expect(chunker.held).toBe(4_800);
    const [first] = chunker.push(audio.subarray(4_801));
    expect(first).toEqual(audio);
  });

  it('resamples Amazon Polly’s 16 kHz to 24 kHz in one continuous pass', () => {
    const chunker = new LiteChunker(16_000, { first: false });
    // One second of 16 kHz, in uneven pieces.
    const audio = pcm(1_000, 16_000, 4_000);
    const out = [
      ...chunker.push(audio.subarray(0, 10_001)),
      ...chunker.push(audio.subarray(10_001, 20_000)),
      ...chunker.push(audio.subarray(20_000)),
    ];
    const rest = chunker.flush();
    const total = out.reduce((n, c) => n + c.byteLength, 0) + (rest?.byteLength ?? 0);
    // 1 s at 24 kHz, within the interpolator's last sample.
    expect(Math.abs(total - 48_000)).toBeLessThanOrEqual(4);
    expect(total % 2).toBe(0);
    // A constant signal stays that constant (no seams at the piece boundaries).
    const sample = new DataView((rest ?? out[0] ?? new Uint8Array(2)).buffer).getInt16(0, true);
    expect(sample).toBe(4_000);
  });

  it('frames base64 at 4 characters per 3 bytes: 64,000 for a second, 12,800 for the first 200 ms', () => {
    expect(bytesToBase64(new Uint8Array(LITE_CHUNK_BYTES))).toHaveLength(64_000);
    expect(bytesToBase64(new Uint8Array(LITE_FIRST_CHUNK_BYTES))).toHaveLength(12_800);
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 255]))).toBe('AAEC/w==');
    expect(liteAudioMs(48_000)).toBe(1_000);
  });
});

describe('LiteControl: the page’s one speak channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rig(behaviour: 'normal' | 'refuse' = 'normal') {
    const sent: string[] = [];
    const socket = new FakeLiteSocket({
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
      now: () => Date.now(),
      behaviour,
      onCommand: (c) => sent.push(c.type),
    });
    let n = 0;
    const control = new LiteControl(socket, {
      ids: () => {
        n += 1;
        return `cmd-${String(n)}`;
      },
      now: () => Date.now(),
    });
    const events: LiteEvent[] = [];
    control.on((e) => events.push(e));
    return { socket, control, sent, events };
  }

  it('sends nothing before the vendor says connected, then speaks with the utterance’s id', async () => {
    const { socket, control, sent, events } = rig();
    expect(control.open).toBe(false);
    expect(() => {
      control.speak('utt-1', pcm(200));
    }).toThrow('lite_not_open');
    const ready = control.ready();
    await vi.advanceTimersByTimeAsync(10);
    await ready;
    expect(control.open).toBe(true);
    control.speak('utt-1', pcm(200));
    control.speak('utt-1', pcm(1_000));
    control.speakEnd('utt-1');
    expect(sent).toEqual(['agent.speak', 'agent.speak', 'agent.speak_end']);
    expect(socket.commands.map((c) => c.eventId)).toEqual(['utt-1', 'utt-1', 'utt-1']);
    expect(socket.commands.map((c) => c.bytes)).toEqual([9_600, 48_000, 0]);
    // One appended per chunk and one committed, by the utterance's id.
    expect(events.filter((e) => e.kind === 'appended')).toHaveLength(2);
    expect(events).toContainEqual({ kind: 'committed', source: 'utt-1' });
    expect(control.counts).toMatchObject({
      chunks: 2,
      bytes: 57_600,
      speakEnds: 1,
      appended: 2,
      committed: 1,
    });
  });

  it('never connects when the vendor does not say so, and reports a channel the vendor closed', async () => {
    const refused = rig('refuse');
    const waiting = refused.control.ready();
    waiting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(refused.control.open).toBe(false);
    refused.socket.drop();
    await expect(waiting).rejects.toThrow('lite_closed');
    expect(refused.events).toEqual([{ kind: 'closed' }]);

    // Closed by the page itself: no event (the face is ending anyway).
    const mine = rig();
    await vi.advanceTimersByTimeAsync(10);
    mine.control.close();
    expect(mine.events).toEqual([]);
    expect(mine.control.open).toBe(false);
  });

  it('interrupts with its own id and keeps alive, reporting the vendor’s plain error type only', async () => {
    const { control, sent, events, socket } = rig();
    await vi.advanceTimersByTimeAsync(10);
    const id = control.interrupt();
    expect(id).toBe('cmd-1');
    control.keepAlive();
    expect(sent).toEqual(['agent.interrupt', 'session.keep_alive']);
    expect(events).toContainEqual({ kind: 'cleared', source: 'cmd-1' });
    // An error event: its type, never its message.
    (socket as unknown as { emit(e: Record<string, unknown>): void }).emit({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'audio: <echoed content>' },
    });
    expect(events.at(-1)).toEqual({ kind: 'error', errorType: 'invalid_request_error' });
    expect(JSON.stringify(events)).not.toContain('echoed');
  });
});
