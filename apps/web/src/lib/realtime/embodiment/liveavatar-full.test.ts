import type { AvatarSessionResponse } from '@foundry/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FaceRelay } from '../avatar';
import { SpeechPlayer, type PlayerAudio, type SpeechFetchResult, type SpeechUnitToPlay } from '../playback';
import { FakeAudioContext, FakeTrack } from '../testing';
import { FakeLiveAvatarRoom } from './fake-liveavatar-room';
import { LIVEAVATAR_COMMAND_TOPIC, LiveAvatarFace, type LiveAvatarDeps } from './liveavatar';

/*
 * A FULL stock face (docs/architecture/calls.md §4) through the real call player: every unit is admitted by the
 * server first (`say`), then sent to the vendor as `avatar.speak_text` with exactly its words, one at a time, so it
 * makes no difference whether the vendor queues commands or a new one cuts off the current one (both behaviours of
 * the fake room run every test). Nothing refused is ever sent, no track is ever published, barge-in interrupts the
 * vendor, and a unit the face does not start is silenced at the vendor before the call speaks it itself.
 */

const TURN = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const SESSION: AvatarSessionResponse = {
  provider: 'heygen',
  token: 'eyJ.full.client.token',
  expiresAt: '2026-10-31T12:20:00.000Z',
  voiceId: 'Matthew',
  voicing: 'text',
  url: 'wss://heygen-feapbkvq.livekit.cloud',
  stockFace: true,
};

function unit(seq: number, text = `Sentence number ${String(seq)} of the reply.`): SpeechUnitToPlay {
  return { turnId: TURN, seq, text, sig: `sig-${String(seq)}-0123456789abcdef` };
}

const timers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

async function setup(behaviour: 'queue' | 'cut', options: { startDelayMs?: number } = {}) {
  /** What happened, in order, across the server, the vendor and the call's own speakers. */
  const events: string[] = [];
  const room = new FakeLiveAvatarRoom({
    ...timers,
    behaviour,
    startDelayMs: options.startDelayMs ?? 100,
    msPerCharacter: 20,
    video: () => Promise.resolve(new FakeTrack() as unknown as MediaStreamTrack),
    onPublish: (command) =>
      events.push(`vendor ${command.eventType}${command.text ? ` ${command.text}` : ''}`),
  });
  let ids = 0;
  const tapAudio = vi.fn(() => ({ level: () => 0, disconnect: vi.fn() }));
  const deps: LiveAvatarDeps = {
    createRoom: () => room,
    createStream: (tracks) => ({ getTracks: () => tracks }) as unknown as MediaStream,
    tapAudio,
    ...timers,
    eventId: () => {
      ids += 1;
      return `evt-${String(ids)}`;
    },
  };
  const refused = new Set<number>();
  const relay = {
    speak: vi.fn(() => Promise.reject(new Error('a FULL face never hands audio over'))),
    say: vi.fn((u: SpeechUnitToPlay) => {
      events.push(`server say ${String(u.seq)}`);
      return refused.has(u.seq) ? Promise.reject(new Error('422')) : Promise.resolve();
    }),
    interrupt: vi.fn(() => {
      events.push('server interrupt');
    }),
  } satisfies FaceRelay;
  const face = new LiveAvatarFace(deps, { voicing: 'text', provider: 'heygen' });
  const lost = vi.fn();
  face.onLost(lost);
  await face.connect(SESSION, new AbortController().signal, relay);

  const context = new FakeAudioContext();
  const fetchSpeech = vi.fn((u: SpeechUnitToPlay) => {
    events.push(`speakers fetch ${String(u.seq)}`);
    return Promise.resolve<SpeechFetchResult>({ kind: 'audio', data: new ArrayBuffer(500) });
  });
  const audio = {
    context,
    fetchSpeech,
    synthesis: null,
    createUtterance: () => ({}) as SpeechSynthesisUtterance,
    ...timers,
    now: () => Date.now(),
  } as unknown as PlayerAudio;
  const log: string[] = [];
  const player = new SpeechPlayer(audio, {
    onUnitStart: (u, route) => log.push(`start ${String(u.seq)} ${route}`),
    onUnitEnd: (u, completed) => log.push(`end ${String(u.seq)} ${completed ? 'done' : 'cut'}`),
    onIdle: () => log.push('idle'),
  });
  player.setFace(face.renderer());
  return { room, face, relay, refused, events, player, log, fetchSpeech, context, lost, tapAudio };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(['queue', 'cut'] as const)('LiveAvatarFace FULL, with a vendor that %s', (behaviour) => {
  it('says each unit once, after the server admitted it, with exactly its words, never cutting one off', async () => {
    const s = await setup(behaviour);
    const units = [unit(0), unit(1), unit(2)];
    for (const u of units) s.player.enqueue(u);
    await vi.advanceTimersByTimeAsync(0);
    // The next units are admitted (in order) while the first is still being said: no round trip at their turn.
    expect(s.relay.say.mock.calls.map(([u]) => u.seq)).toEqual([0, 1, 2]);
    expect(s.room.published.filter((c) => c.eventType === 'avatar.speak_text')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.relay.say.mock.calls.map(([u]) => u.seq)).toEqual([0, 1, 2]);
    const spoken = s.room.published.filter((c) => c.eventType === 'avatar.speak_text');
    expect(spoken.map((c) => c.text)).toEqual(units.map((u) => u.text));
    expect(s.room.said).toEqual(units.map((u) => u.text));
    expect(s.room.cutOff).toEqual([]);
    // Each word sent only after its admission, one unit at a time.
    for (const u of units) {
      expect(s.events.indexOf(`server say ${String(u.seq)}`)).toBeLessThan(
        s.events.indexOf(`vendor avatar.speak_text ${u.text}`),
      );
    }
    // The face spoke them: the call fetched no audio, and the captions followed the vendor.
    expect(s.fetchSpeech).not.toHaveBeenCalled();
    expect(s.log).toEqual([
      'start 0 server',
      'end 0 done',
      'start 1 server',
      'end 1 done',
      'start 2 server',
      'end 2 done',
      'idle',
    ]);
    // Commands only, on the command topic: no track was ever published (the fake room has no way to).
    expect(s.room.published.every((c) => c.topic === LIVEAVATAR_COMMAND_TOPIC)).toBe(true);
    expect(s.tapAudio).not.toHaveBeenCalled();
  });

  it('sends nothing the server refused, and speaks that unit itself', async () => {
    const s = await setup(behaviour);
    s.refused.add(1);
    for (const u of [unit(0), unit(1), unit(2)]) s.player.enqueue(u);
    await vi.advanceTimersByTimeAsync(4_000);
    const texts = s.room.published.filter((c) => c.eventType === 'avatar.speak_text').map((c) => c.text);
    expect(texts).not.toContain(unit(1).text);
    expect(s.fetchSpeech.mock.calls.map(([u]) => u.seq)).toEqual([1]);
    // Its own audio plays through the call's speakers; the face takes the next unit.
    s.context.sources[0]?.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.room.said).toEqual([unit(0).text, unit(2).text]);
    expect(s.room.cutOff).toEqual([]);
    expect(s.log.filter((l) => l.startsWith('start'))).toEqual([
      'start 0 server',
      'start 1 server',
      'start 2 server',
    ]);
  });

  it('interrupts the vendor and the server on barge-in', async () => {
    const s = await setup(behaviour);
    s.player.enqueue(unit(0, 'A long sentence that is still being said when the founder speaks over it.'));
    s.player.enqueue(unit(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(s.log).toEqual(['start 0 server']);
    s.player.stop();
    expect(s.room.published.at(-1)?.eventType).toBe('avatar.interrupt');
    expect(s.relay.interrupt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.room.published.filter((c) => c.eventType === 'avatar.speak_text')).toHaveLength(1);
    expect(s.log).toEqual(['start 0 server', 'end 0 cut']);
  });
});

describe('LiveAvatarFace FULL: when the face cannot say a unit', () => {
  it('silences the vendor first, then the call speaks the unit itself (two voices never overlap)', async () => {
    const s = await setup('queue', { startDelayMs: 60_000 });
    s.player.enqueue(unit(0));
    await vi.advanceTimersByTimeAsync(3_200);
    const interrupt = s.events.indexOf('vendor avatar.interrupt');
    expect(interrupt).toBeGreaterThan(s.events.indexOf(`vendor avatar.speak_text ${unit(0).text}`));
    expect(interrupt).toBeLessThan(s.events.indexOf('speakers fetch 0'));
    expect(s.log).toEqual(['start 0 server']);
    expect(s.context.sources[0]?.started).toBe(true);
  });

  it('takes the listening pose while the founder may speak, and gives the face up when the vendor stops', async () => {
    const s = await setup('queue');
    s.face.setState('listening');
    s.face.setState('listening');
    s.face.setState('speaking');
    expect(s.room.published.map((c) => c.eventType)).toEqual([
      'avatar.start_listening',
      'avatar.stop_listening',
    ]);
    s.room.stopSession('MAX_DURATION_REACHED');
    expect(s.lost).toHaveBeenCalledTimes(1);
    expect(s.face.renderer().ready()).toBe(false);
  });

  it('never says an unsigned passage (the call speaks it as before)', async () => {
    const s = await setup('queue');
    s.player.enqueue({ turnId: TURN, seq: 0, text: 'A passage of a stored reply.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.relay.say).not.toHaveBeenCalled();
    expect(s.fetchSpeech).toHaveBeenCalledTimes(1);
  });
});
