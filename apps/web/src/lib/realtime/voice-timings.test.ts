import { describe, expect, it } from 'vitest';
import { VoiceTimings, VOICE_TIMING_LIMIT } from './voice-timings';
describe('bounded voice measurements', () => {
  it('retains slow successful turns, excludes missing samples and labels the boundary honestly', () => {
    const timing = new VoiceTimings();
    timing.record('vadEndToPlayback', NaN);
    timing.record('vadEndToPlayback', -1);
    for (let i = 1; i <= 100; i++) timing.record('vadEndToPlayback', i);
    timing.record('vadEndToPlayback', 20000);
    expect(timing.report().stages.vadEndToPlayback).toEqual({ n: 101, p50: 51, p95: 96, p99: 100 });
    expect(timing.report().audibleOutputVerified).toBe(false);
    expect(timing.report().stages.sessionSetup).toEqual({ n: 0, p50: null, p95: null, p99: null });
  });
  it('bounds long-call storage and clears between sessions', () => {
    const timing = new VoiceTimings();
    for (let i = 0; i < 1000; i++) timing.record('endpointing', i);
    expect(timing.report().stages.endpointing?.n).toBe(VOICE_TIMING_LIMIT);
    timing.clear();
    expect(timing.report().stages.endpointing?.n).toBe(0);
  });
});
