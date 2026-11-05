import { describe, expect, it, vi } from 'vitest';

import { LIVE, fakeEngine } from '../testing';
import { CallTimeline } from './call-timeline';

/** A frame loop the test steps by hand (16.7 ms per frame). */
function frames() {
  let next: FrameRequestCallback | null = null;
  let now = 0;
  let visible = true;
  return {
    deps: {
      request: (callback: FrameRequestCallback) => {
        next = callback;
        return 1;
      },
      cancel: () => {
        next = null;
      },
      now: () => now,
      visible: () => visible,
    },
    run(count: number) {
      for (let i = 0; i < count && next; i++) {
        now += 1000 / 60;
        const callback = next;
        next = null;
        callback(now);
      }
    },
    running: () => next !== null,
    hide: () => {
      visible = false;
    },
  };
}

const CALL = { ...LIVE, call: { id: 'call-1' } } as unknown as typeof LIVE;

describe('CallTimeline', () => {
  it('runs one frame loop while the call is live, feeding the presence and the timeline', () => {
    const fake = fakeEngine({ ...CALL, activity: 'speaking' });
    fake.engine.levels.mockReturnValue({ veir: 0.08, founder: 0.2 });
    const loop = frames();
    const timeline = new CallTimeline(fake.asEngine, loop.deps);
    const presence = vi.fn();
    timeline.onFrame(presence);
    loop.run(30);
    expect(presence).toHaveBeenCalledWith({ veir: 0.08, founder: 0.2 });
    // The vEIR spoke: a blue turn from the playback level. Its echo in the microphone is not the founder.
    const turns = timeline.recorder.turns();
    expect(turns.map((turn) => turn.speaker)).toEqual(['veir']);
    expect(turns[0]?.bins[0]).toBeCloseTo(0.08, 5);
  });

  it('draws the founder only while their voice is detected, never when muted or silent', () => {
    const fake = fakeEngine({ ...CALL, activity: 'listening' });
    fake.engine.levels.mockReturnValue({ veir: 0, founder: 0.05 });
    const loop = frames();
    const timeline = new CallTimeline(fake.asEngine, loop.deps);
    loop.run(20);
    expect(timeline.recorder.turns()).toEqual([]);
    fake.engine.founderVoiced.mockReturnValue(true);
    loop.run(20);
    expect(timeline.recorder.turns().map((turn) => turn.speaker)).toEqual(['student']);
  });

  it('stops when the page is hidden or the call ends, and starts afresh for the next call', () => {
    const fake = fakeEngine({ ...CALL, activity: 'speaking' });
    fake.engine.levels.mockReturnValue({ veir: 0.1, founder: 0 });
    const loop = frames();
    const timeline = new CallTimeline(fake.asEngine, loop.deps);
    loop.run(10);
    loop.hide();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(loop.running()).toBe(false);
    fake.setSnapshot({ ...CALL, phase: 'ended' });
    expect(timeline.recorder.turns()[0]?.endMs).not.toBeNull();
    fake.setSnapshot({ ...LIVE, phase: 'starting' });
    expect(timeline.recorder.turns()).toEqual([]);
    timeline.dispose();
  });

  it('keeps the words of each turn from the captions', () => {
    const speakers: ((unit: { text: string }) => void)[] = [];
    const fake = fakeEngine({ ...CALL, activity: 'speaking' });
    fake.engine.onSpeak.mockImplementation(((listener: (unit: { text: string }) => void) => {
      speakers.push(listener);
      return () => undefined;
    }) as never);
    fake.engine.levels.mockReturnValue({ veir: 0.1, founder: 0 });
    const loop = frames();
    const timeline = new CallTimeline(fake.asEngine, loop.deps);
    loop.run(10);
    for (const speak of speakers) speak({ text: 'Finish the pilot first.' });
    expect(timeline.recorder.turns()[0]?.text).toBe('Finish the pilot first.');
  });
});
