import { describe, expect, it } from 'vitest';

import { Endpointer, floorWords } from './endpointing';
import { VoiceActivityDetector } from './vad';

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Endpointer', () => {
  it('waits for a stable transcript and the silence window before ending a turn', () => {
    const time = clock();
    const ep = new Endpointer(time.now, { silenceMs: 600 });
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'We interviewed', partial: true, stable: false });
    expect(ep.isComplete()).toBe(false);

    time.advance(300);
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'We interviewed twelve clinics', partial: true, stable: true });
    time.advance(500);
    expect(ep.isComplete(), 'only 500 ms of quiet').toBe(false);
    time.advance(100);
    expect(ep.isComplete()).toBe(true);
    expect(ep.take()).toBe('We interviewed twelve clinics');
    expect(ep.hasSpeech()).toBe(false);
  });

  it('treats a partial that stopped changing as stable', () => {
    const time = clock();
    const ep = new Endpointer(time.now, { silenceMs: 600 });
    ep.onResult({ resultId: 'a', text: 'Hello there', partial: true, stable: false });
    time.advance(400);
    ep.onResult({ resultId: 'a', text: 'Hello there', partial: true, stable: false });
    time.advance(199);
    expect(ep.isComplete()).toBe(false);
    time.advance(1);
    expect(ep.isComplete()).toBe(true);
  });

  it('joins finished segments with the live partial', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onResult({ resultId: 'a', text: 'First part.', partial: false, stable: true });
    ep.onResult({ resultId: 'b', text: 'and the', partial: true, stable: false });
    expect(ep.text()).toBe('First part. and the');
  });

  it('ignores late updates of a segment already sent, but keeps words added after it', () => {
    const time = clock();
    const ep = new Endpointer(time.now, { silenceMs: 600 });
    ep.onResult({ resultId: 'a', text: 'Can we talk pricing', partial: true, stable: true });
    time.advance(700);
    expect(ep.take()).toBe('Can we talk pricing');

    // Transcribe finalises the same segment a moment later: no new turn.
    ep.onResult({ resultId: 'a', text: 'Can we talk pricing?', partial: false, stable: true });
    expect(ep.hasSpeech()).toBe(false);

    // The founder kept going within the same segment: only the new words count.
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'Can we talk pricing? For the pilot', partial: true, stable: true });
    expect(ep.text()).toBe('For the pilot');
    time.advance(700);
    expect(ep.take()).toBe('For the pilot');
    ep.onResult({ resultId: 'a', text: 'Can we talk pricing? For the pilot', partial: false, stable: true });
    expect(ep.hasSpeech()).toBe(false);
  });

  it('discards what was heard (mute, typing instead)', () => {
    const ep = new Endpointer(clock().now);
    ep.onResult({ resultId: 'a', text: 'never mind', partial: true, stable: false });
    ep.discard();
    expect(ep.text()).toBe('');
    ep.onResult({ resultId: 'a', text: 'never mind', partial: false, stable: true });
    expect(ep.hasSpeech()).toBe(false);
  });
});

describe('floorWords', () => {
  it('keeps only words that are neither the vEIR’s own echo nor a backchannel', () => {
    const spoken = 'Twelve is a good start. What did they say?';
    expect(floorWords('twelve is a good', spoken)).toEqual([]);
    expect(floorWords('yeah mm-hmm, right', spoken)).toEqual([]);
    expect(floorWords('uh-huh got it, I see', spoken)).toEqual([]);
    expect(floorWords('wait, stop', spoken)).toEqual(['wait', 'stop']);
    expect(floorWords('yeah but price', spoken)).toEqual(['but', 'price']);
    expect(floorWords('twelve', '')).toEqual(['twelve']);
    expect(floorWords('  ', spoken)).toEqual([]);
  });
});

describe('VoiceActivityDetector', () => {
  it('needs consecutive loud frames for an onset and ends on a quiet frame', () => {
    const vad = new VoiceActivityDetector({ minRms: 0.01, onsetFrames: 2 });
    expect(vad.update(0.002)).toEqual({ voiced: false, onset: false });
    expect(vad.update(0.05)).toEqual({ voiced: true, onset: false });
    expect(vad.update(0.05)).toEqual({ voiced: true, onset: true });
    expect(vad.update(0.05)).toEqual({ voiced: true, onset: false });
    expect(vad.update(0.001)).toEqual({ voiced: false, onset: false });
    // A new onset after the quiet frame.
    vad.update(0.05);
    expect(vad.update(0.05)).toEqual({ voiced: true, onset: true });
  });

  it('adapts to a steady background so it is not mistaken for speech', () => {
    const vad = new VoiceActivityDetector({ minRms: 0.005, floorRatio: 3, floorAdapt: 0.2 });
    // A loud fan: once the floor has followed it, the fan alone is not voiced.
    for (let i = 0; i < 200; i++) vad.update(i % 2 === 0 ? 0.004 : 0.006);
    expect(vad.update(0.006).voiced).toBe(false);
    expect(vad.update(0.08).voiced).toBe(true);
  });

  it('ignores invalid levels', () => {
    const vad = new VoiceActivityDetector();
    expect(vad.update(Number.NaN).voiced).toBe(false);
  });
});
