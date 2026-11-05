import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceRenderHandlers, SpeechUnitToPlay } from '../playback';
import { FakeLiteSocket } from './fake-lite-socket';
import { LiteControl } from './lite-socket';
import { LITE_KEEPALIVE_MS, LITE_STALL_MS, LiteSpeaker } from './lite-speaker';

const A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';

function unit(turnId: string | null, seq: number, extra: Partial<SpeechUnitToPlay> = {}): SpeechUnitToPlay {
  return {
    turnId,
    seq,
    text: `Sentence ${String(seq)}.`,
    sig: `sig-${String(seq)}-0123456789abcdef`,
    faceApproved: true,
    ...extra,
  };
}

/** A unit's PCM as `/speech` streams it: pushed in pieces, then ended. */
function body(rate = 24_000) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push(ms: number) {
      try {
        controller.enqueue(new Uint8Array(Math.round((ms / 1000) * rate) * 2).fill(3));
      } catch {
        /* cancelled */
      }
    },
    end() {
      try {
        controller.close();
      } catch {
        /* cancelled */
      }
    },
  };
}

function rig(options: { behaviour?: 'normal' | 'stall' } = {}) {
  /** One timeline of what happened, in order: the page's actions, the commands sent, the units heard. */
  const order: string[] = [];
  const socket = new FakeLiteSocket({
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    now: () => Date.now(),
    startDelayMs: 300,
    ...(options.behaviour === undefined ? {} : { behaviour: options.behaviour }),
    onCommand: (c) => {
      if (c.type !== 'agent.speak') order.push(`cmd ${c.type}`);
    },
  });
  let n = 0;
  const control = new LiteControl(socket, {
    ids: () => {
      n += 1;
      return `cmd-${String(n)}`;
    },
    now: () => Date.now(),
  });
  let u = 0;
  const broken: string[] = [];
  const admit = vi.fn((_unit: SpeechUnitToPlay, _signal: AbortSignal) => Promise.resolve());
  const speaker = new LiteSpeaker({
    control,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
    now: () => Date.now(),
    ids: () => {
      u += 1;
      return `utt-${String(u)}`;
    },
    admit,
    silence: () => order.push('silence'),
    unsilence: () => order.push('unsilence'),
    level: () => 0,
    onBroken: (reason) => broken.push(reason),
    onInterrupt: () => order.push('server interrupt'),
  });
  const handlers = (name: string): FaceRenderHandlers => ({
    onStart: () => order.push(`start ${name}`),
    onEnd: (outcome) => order.push(`end ${name} ${outcome}`),
  });
  /** Plays units one after another the way the call's player does: the next is rendered at the last one's end. */
  const play = (units: readonly { unit: SpeechUnitToPlay; name: string }[]) => {
    const stops: (() => void)[] = [];
    const next = (i: number) => {
      const item = units[i];
      if (item === undefined) return;
      const h = handlers(item.name);
      stops.push(
        speaker.render(item.unit, {
          onStart: () => {
            h.onStart();
          },
          onEnd: (outcome) => {
            h.onEnd(outcome);
            next(i + 1);
          },
        }),
      );
    };
    next(0);
    return () => {
      stops.at(-1)?.();
    };
  };
  const speaks = (id: string) => socket.commands.filter((c) => c.type === 'agent.speak' && c.eventId === id);
  return { socket, control, speaker, order, broken, admit, handlers, play, speaks };
}

async function connected(r: ReturnType<typeof rig>) {
  await vi.advanceTimersByTimeAsync(10);
  await r.control.ready();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiteSpeaker: one utterance per turn', () => {
  it('says a whole turn as one utterance: 200 ms first, then 1 s chunks, one speak_end after its last unit', async () => {
    const r = rig();
    await connected(r);
    const bodies = [body(), body(), body()];
    const units = [unit(A, 0), unit(A, 1), unit(A, 2)];
    units.forEach((un, i) => {
      expect(r.speaker.feed(un, bodies[i]?.stream ?? body().stream, 24_000)).toBe(true);
    });
    bodies[0]?.push(1_500);
    bodies[0]?.end();
    bodies[1]?.push(800);
    bodies[1]?.end();
    bodies[2]?.push(400);
    bodies[2]?.end();
    await vi.advanceTimersByTimeAsync(0);
    // Nothing goes to the vendor before the call reaches the turn.
    expect(r.socket.count('agent.speak')).toBe(0);
    r.play(units.map((un, i) => ({ unit: un, name: `a${String(i)}` })));
    r.speaker.endTurn(A, 2);
    await vi.advanceTimersByTimeAsync(0);
    // Every unit forwarded at once, appended to the one utterance (no gap between sentences), then sealed.
    expect(r.socket.utterances).toEqual(['utt-1']);
    expect(r.speaks('utt-1').map((c) => c.bytes)).toEqual([9_600, 48_000, 14_400, 38_400, 19_200]);
    expect(r.socket.count('agent.speak_end')).toBe(1);
    expect(r.socket.commands.at(-1)?.type).toBe('agent.speak_end');
    // Heard from the vendor's speak_started on, each unit where the audio before it ends, the last at speak_ended.
    await vi.advanceTimersByTimeAsync(300);
    expect(r.order).toContain('start a0');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.order.filter((e) => e.startsWith('start') || e.startsWith('end'))).toEqual([
      'start a0',
      'end a0 ended',
      'start a1',
      'end a1 ended',
      'start a2',
      'end a2 ended',
    ]);
    expect(r.socket.said).toEqual(['utt-1']);
    expect(r.socket.cuts).toEqual([]);
    expect(r.speaker.report()).toMatchObject({
      utterances: 1,
      utterancesByTurn: { [A]: 1 },
      unitsForwarded: 3,
      fallbacks: 0,
    });
  });

  it('never opens a second utterance while one is open: the next turn waits for speak_ended', async () => {
    const r = rig();
    await connected(r);
    const first = body();
    r.speaker.feed(unit(A, 0), first.stream, 24_000);
    first.push(1_000);
    first.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    r.speaker.endTurn(A, 0);
    await vi.advanceTimersByTimeAsync(400);
    // The next turn reaches the face while the first is still being said (sealed, not ended).
    const second = body();
    r.speaker.feed(unit(B, 0), second.stream, 24_000);
    second.push(600);
    second.end();
    r.speaker.render(unit(B, 0), r.handlers('b0'));
    await vi.advanceTimersByTimeAsync(500);
    expect(r.speaks('utt-2')).toHaveLength(0);
    // Once the first said speak_ended, the second opens.
    await vi.advanceTimersByTimeAsync(600);
    expect(r.socket.said).toEqual(['utt-1']);
    expect(r.speaks('utt-2').length).toBeGreaterThan(0);
    expect(r.socket.utterances).toEqual(['utt-1', 'utt-2']);
    expect(r.socket.cuts).toEqual([]);
  });

  it('closes a turn whose units stopped coming once its audio played out (a later unit opens a new one)', async () => {
    const r = rig();
    await connected(r);
    const only = body();
    r.speaker.feed(unit(A, 0), only.stream, 24_000);
    only.push(500);
    only.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    await vi.advanceTimersByTimeAsync(800);
    expect(r.socket.count('agent.speak_end')).toBe(0);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(r.socket.count('agent.speak_end')).toBe(1);
  });
});

describe('LiteSpeaker: barge-in', () => {
  it('silences the element first, then interrupts the vendor and tells the server; ignores the speak_ended after', async () => {
    const r = rig();
    await connected(r);
    const a = body();
    r.speaker.feed(unit(A, 0), a.stream, 24_000);
    a.push(3_000);
    a.end();
    const stop = r.play([{ unit: unit(A, 0), name: 'a0' }]);
    await vi.advanceTimersByTimeAsync(800);
    expect(r.order).toContain('start a0');
    stop();
    const after = r.order.slice(r.order.indexOf('start a0') + 1);
    expect(after).toEqual(['silence', 'cmd agent.interrupt', 'server interrupt']);
    // The next turn opens at once (the interrupt closed the last), and the interrupted one's late speak_ended does
    // not end it.
    const b = body();
    r.speaker.feed(unit(B, 0), b.stream, 24_000);
    b.push(2_000);
    b.end();
    r.play([{ unit: unit(B, 0), name: 'b0' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.speaks('utt-2').length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(r.order.filter((e) => e.startsWith('end'))).toEqual([]);
    // The element sounds again only at the new utterance's speak_started.
    const since = () => r.order.slice(r.order.indexOf('server interrupt'));
    expect(since()).not.toContain('unsilence');
    await vi.advanceTimersByTimeAsync(300);
    expect(since()).toContain('unsilence');
    expect(r.socket.cuts).toEqual([]);
    expect(r.speaker.report().interrupts).toBe(1);
  });
});

describe('LiteSpeaker: keep-alive', () => {
  it('sends session.keep_alive once a minute while idle, never while it is speaking', async () => {
    const r = rig();
    await connected(r);
    await vi.advanceTimersByTimeAsync(LITE_KEEPALIVE_MS + 15_000);
    expect(r.socket.count('session.keep_alive')).toBe(1);
    await vi.advanceTimersByTimeAsync(LITE_KEEPALIVE_MS);
    expect(r.socket.count('session.keep_alive')).toBe(2);
    // A long turn: the channel is in use, nothing else is sent.
    const long = body();
    r.speaker.feed(unit(A, 0), long.stream, 24_000);
    long.push(50_000);
    long.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    r.speaker.endTurn(A, 0);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.socket.count('session.keep_alive')).toBe(2);
  });
});

describe('LiteSpeaker: fallback, never both, never twice', () => {
  it('gives back a turn the vendor does not start in time: silent and interrupted first, then the call plays it', async () => {
    const r = rig({ behaviour: 'stall' });
    await connected(r);
    const a = body();
    r.speaker.feed(unit(A, 0), a.stream, 24_000);
    a.push(1_000);
    a.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    await vi.advanceTimersByTimeAsync(LITE_STALL_MS - 1);
    expect(r.order).not.toContain('silence');
    await vi.advanceTimersByTimeAsync(1);
    expect(r.order).toEqual(['silence', 'cmd agent.interrupt', 'server interrupt', 'end a0 failed']);
    // The rest of that turn stays with the call; the face goes on for the next turn.
    expect(r.speaker.feed(unit(A, 1), body().stream, 24_000)).toBe(false);
    expect(r.broken).toEqual([]);
    expect(r.speaker.ready).toBe(true);
    // A second stall ends the face's speaking for the call.
    const b = body();
    r.speaker.feed(unit(B, 0), b.stream, 24_000);
    b.push(500);
    b.end();
    r.play([{ unit: unit(B, 0), name: 'b0' }]);
    await vi.advanceTimersByTimeAsync(LITE_STALL_MS);
    expect(r.broken).toEqual(['speech_stalled']);
    expect(r.speaker.report()).toMatchObject({ stalls: 2, fallbacks: 2 });
  });

  it('when the channel drops mid-turn, a unit already heard ends as heard and only the rest goes back', async () => {
    const r = rig();
    await connected(r);
    const a0 = body();
    const a1 = body();
    r.speaker.feed(unit(A, 0), a0.stream, 24_000);
    r.speaker.feed(unit(A, 1), a1.stream, 24_000);
    a0.push(1_000);
    a0.end();
    a1.push(1_000);
    a1.end();
    r.play([
      { unit: unit(A, 0), name: 'a0' },
      { unit: unit(A, 1), name: 'a1' },
    ]);
    await vi.advanceTimersByTimeAsync(700);
    expect(r.order).toContain('start a0');
    r.socket.drop();
    await vi.advanceTimersByTimeAsync(0);
    // a0 was being heard: never repeated. a1 was not: the call plays it.
    expect(r.order.filter((e) => e.startsWith('start') || e.startsWith('end'))).toEqual([
      'start a0',
      'end a0 ended',
      'end a1 failed',
    ]);
    expect(r.order).toContain('silence');
    expect(r.socket.count('agent.interrupt')).toBe(0);
    expect(r.broken).toEqual(['control_lost']);
    expect(r.speaker.ready).toBe(false);
  });

  it('forwards only units the server admitted: unsigned ones never, others once face/say said yes', async () => {
    const r = rig();
    await connected(r);
    expect(r.speaker.feed(unit(null, 0, { sig: undefined }), body().stream, 24_000)).toBe(false);
    // The intro (not pre-approved): asked for first.
    r.admit.mockImplementationOnce(() => Promise.reject(new Error('422')));
    const intro = body();
    expect(r.speaker.feed(unit(null, 0, { faceApproved: undefined }), intro.stream, 24_000)).toBe(true);
    intro.push(800);
    intro.end();
    r.play([{ unit: unit(null, 0), name: 'intro' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.admit).toHaveBeenCalledTimes(1);
    expect(r.order).toEqual(['end intro failed']);
    expect(r.socket.count('agent.speak')).toBe(0);
    // Admitted: forwarded.
    const next = body();
    r.speaker.feed(unit(A, 0, { faceApproved: undefined }), next.stream, 24_000);
    next.push(500);
    next.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.admit).toHaveBeenCalledTimes(2);
    // 500 ms: the utterance's 200 ms first chunk, then the rest.
    expect(r.speaks('utt-1').map((c) => c.bytes)).toEqual([9_600, 14_400]);
    // A failed turn's pre-approval is withdrawn from what was not forwarded yet.
    const w = body();
    r.speaker.feed(unit(B, 0), w.stream, 24_000);
    r.speaker.withdraw(B);
    r.speaker.render(unit(B, 0), r.handlers('b0'));
    await vi.advanceTimersByTimeAsync(10);
    expect(r.order).toContain('end b0 failed');
  });

  it('resamples a Polly unit (16 kHz) to the vendor’s 24 kHz', async () => {
    const r = rig();
    await connected(r);
    const polly = body(16_000);
    r.speaker.feed(unit(A, 0), polly.stream, 16_000);
    polly.push(1_000);
    polly.end();
    r.play([{ unit: unit(A, 0), name: 'a0' }]);
    await vi.advanceTimersByTimeAsync(0);
    const total = r.speaks('utt-1').reduce((n, c) => n + c.bytes, 0);
    expect(Math.abs(total - 48_000)).toBeLessThanOrEqual(4);
  });
});
