import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readingTimeMs,
  SpeechPlayer,
  type PlayerAudio,
  type SpeechFetchResult,
  type SpeechUnitToPlay,
} from './playback';
import { FakeAudioContext, FakeSpeechSynthesis, FakeUtterance, flush } from './testing';

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
    onRouteChange: (route) => log.push(`route ${route}`),
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

  it('ducks and restores the volume', () => {
    const { player } = setup();
    player.duck();
    // The gain node is the first one created by the player.
    player.unduck();
    expect(player.voice).toBe('server');
  });

  it('reads validated text with the browser voice when the server has no speech (501)', async () => {
    const { synthesis, pending, fetchSpeech, player, log } = setup();
    player.enqueue(unit(0, 'Hello Maya.'));
    player.enqueue(unit(1, 'How did the interviews go?'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['route browser', 'start 0 browser']);
    expect(synthesis.spoken.map((u) => u.text)).toEqual(['Hello Maya.']);

    synthesis.finish();
    await flush(10);
    // Once the server said 501, later units go straight to the browser voice.
    expect(log).toContain('start 1 browser');
    expect(synthesis.spoken.map((u) => u.text)).toEqual(['Hello Maya.', 'How did the interviews go?']);
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
  });

  it('finishes a browser utterance that never reports its end', async () => {
    const { pending, player, log } = setup();
    player.enqueue(unit(0, 'Short.'));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    vi.advanceTimersByTime(readingTimeMs('Short.') * 2);
    await flush();
    expect(log).toEqual(['route browser', 'start 0 browser', 'end 0 done', 'idle']);
  });

  it('shows the words without a voice when synthesis fails, never another voice', async () => {
    const { synthesis, pending, player, log } = setup();
    player.enqueue(unit(0, 'Twelve is a good start.'));
    pending[0]?.resolve({ kind: 'failed' });
    await flush();
    expect(log).toEqual(['route captions', 'start 0 captions']);
    expect(synthesis.spoken).toHaveLength(0);
    vi.advanceTimersByTime(readingTimeMs('Twelve is a good start.'));
    await flush();
    expect(log.at(-1)).toBe('idle');
  });

  it('falls back to captions when there is no browser voice either', async () => {
    const { pending, player, log } = setup({ synthesis: false });
    player.enqueue(unit(0));
    pending[0]?.resolve({ kind: 'unavailable' });
    await flush();
    expect(log).toEqual(['route captions', 'start 0 captions']);
  });

  it('treats undecodable audio as captions only', async () => {
    const { context, pending, player, log, audioOf } = setup();
    context.decodeFails = true;
    player.enqueue(unit(0));
    pending[0]?.resolve(audioOf(10));
    await flush();
    expect(log).toEqual(['route captions', 'start 0 captions']);
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
