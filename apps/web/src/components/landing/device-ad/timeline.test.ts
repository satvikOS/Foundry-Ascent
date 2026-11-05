import { describe, expect, it, vi } from 'vitest';

import { BEATS, frameAt } from './script';
import { FrameTimeline } from './timeline';

describe('the ad’s timeline source', () => {
  it('gives the call’s timeline the ad’s turns and the time since the call started', () => {
    const source = new FrameTimeline();
    const frame = frameAt(BEATS.veirAt + 1_000);
    source.set(frame.turns, frame.t - BEATS.phoneAt);
    expect(source.measured).toBe(true);
    expect(source.turns()).toBe(frame.turns);
    expect(source.turns()[0]).toMatchObject({ speaker: 'veir', endMs: null });
    expect(source.elapsedMs()).toBe(BEATS.veirAt + 1_000 - BEATS.phoneAt);
    // Before the call (the phone still dark) no time has passed on it.
    source.set([], -500);
    expect(source.elapsedMs()).toBe(0);
  });

  it('bumps its structure only when a turn opens, closes or the loop restarts, and notifies on every bin', () => {
    const source = new FrameTimeline();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    const at = (t: number) => {
      const frame = frameAt(t);
      source.set(frame.turns, frame.t - BEATS.phoneAt);
      return source.structure();
    };
    const opened = at(BEATS.veirAt + 200);
    expect(at(BEATS.veirAt + 300)).toBe(opened); // one more bin of the same turn
    const closed = at(BEATS.veirEnd + 100);
    expect(closed).toBeGreaterThan(opened);
    const restarted = at(0);
    expect(restarted).toBeGreaterThan(closed);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    at(BEATS.end);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
