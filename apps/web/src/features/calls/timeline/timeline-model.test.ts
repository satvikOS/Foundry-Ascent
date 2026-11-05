import { describe, expect, it, vi } from 'vitest';

import { pastTimeline, TimelineRecorder, turnEnd } from './timeline-model';

const SILENT = { veir: null, student: null };

describe('TimelineRecorder', () => {
  it('opens a turn when a speaker is heard and closes it after a silence', () => {
    const recorder = new TimelineRecorder();
    for (let i = 0; i < 5; i++) recorder.step({ veir: 0.1, student: null });
    expect(recorder.turns()).toHaveLength(1);
    expect(recorder.turns()[0]).toMatchObject({ speaker: 'veir', startMs: 0, endMs: null });
    // A breath shorter than the merge gap stays inside the turn, as silent bins.
    for (let i = 0; i < 3; i++) recorder.step(SILENT);
    recorder.step({ veir: 0.2, student: null });
    expect(recorder.turns()).toHaveLength(1);
    expect(recorder.turns()[0]?.bins).toEqual([0.1, 0.1, 0.1, 0.1, 0.1, 0, 0, 0, 0.2]);
    // A long silence ends it where the speaker was last heard.
    for (let i = 0; i < 8; i++) recorder.step(SILENT);
    expect(recorder.turns()[0]?.endMs).toBe(900);
    expect(recorder.elapsedMs()).toBe(1700);
  });

  it('hands over without overlap: the silent speaker ends where they were last heard', () => {
    const recorder = new TimelineRecorder();
    recorder.step({ veir: 0.1, student: null });
    recorder.step({ veir: 0.1, student: null });
    recorder.step(SILENT);
    recorder.step({ veir: null, student: 0.05 });
    const [veir, student] = recorder.turns();
    expect(veir).toMatchObject({ speaker: 'veir', endMs: 200 });
    expect(student).toMatchObject({ speaker: 'student', startMs: 300, endMs: null, bins: [0.05] });
  });

  it('averages the frames of each 100 ms into one bin, from real levels only', () => {
    const recorder = new TimelineRecorder();
    const listener = vi.fn();
    recorder.subscribe(listener);
    // 60 Hz frames: the student speaks at 0.1 then 0.3.
    let now = 1_000;
    for (let i = 0; i < 6; i++) {
      recorder.sample(now, { veir: null, student: 0.1 });
      now += 1000 / 60;
    }
    for (let i = 0; i < 6; i++) {
      recorder.sample(now, { veir: null, student: 0.3 });
      now += 1000 / 60;
    }
    recorder.sample(now, SILENT);
    const [turn] = recorder.turns();
    expect(turn?.speaker).toBe('student');
    expect(turn?.bins[0]).toBeCloseTo(0.1, 5);
    expect(turn?.bins[1]).toBeCloseTo(0.3, 5);
    // It notifies once per bin (10 Hz), not per frame.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('bumps its structure only when turns change, so React renders at turn boundaries', () => {
    const recorder = new TimelineRecorder();
    const start = recorder.structure();
    recorder.step({ veir: 0.1, student: null });
    const opened = recorder.structure();
    expect(opened).toBeGreaterThan(start);
    recorder.step({ veir: 0.2, student: null });
    expect(recorder.structure()).toBe(opened);
  });

  it('keeps the words of a turn in memory and closes open turns at the end', () => {
    const recorder = new TimelineRecorder();
    recorder.step({ veir: 0.1, student: null });
    recorder.annotate('veir', 'Finish the pilot first.');
    recorder.annotate('veir', 'Then raise.');
    recorder.annotate('student', 'Nobody spoke yet.');
    expect(recorder.turns()[0]?.text).toBe('Finish the pilot first. Then raise.');
    expect(recorder.turns()).toHaveLength(1);
    recorder.finish();
    expect(recorder.turns()[0]?.endMs).toBe(100);
  });

  it('gives a sentence announced as it starts playing to the turn its first bin opens', () => {
    const recorder = new TimelineRecorder();
    recorder.annotate('veir', 'Hi Maya.', { upcoming: true });
    expect(recorder.turns()).toEqual([]);
    recorder.step({ veir: 0.1, student: null });
    recorder.annotate('veir', 'Where shall we start?', { upcoming: true });
    expect(recorder.turns()[0]?.text).toBe('Hi Maya. Where shall we start?');
  });

  it('is bounded: the oldest turns go beyond the cap', () => {
    const recorder = new TimelineRecorder({ maxBins: 10, mergeGapMs: 100 });
    for (let turn = 0; turn < 6; turn++) {
      for (let i = 0; i < 4; i++) recorder.step({ veir: 0.1, student: null });
      recorder.step(SILENT);
    }
    const kept = recorder.turns().reduce((sum, turn) => sum + turn.bins.length, 0);
    expect(kept).toBeLessThanOrEqual(10);
    expect(recorder.turns().at(-1)?.startMs).toBe(2_500);
  });

  it('treats frames that stopped (a hidden page, a hold) as time with nothing heard', () => {
    const recorder = new TimelineRecorder();
    recorder.sample(0, { veir: 0.1, student: null });
    recorder.sample(120, { veir: 0.1, student: null });
    recorder.sample(5_000, { veir: null, student: null });
    expect(recorder.turns()[0]?.endMs).not.toBeNull();
    expect(recorder.elapsedMs()).toBeGreaterThanOrEqual(4_800);
  });

  it('forgets everything on reset', () => {
    const recorder = new TimelineRecorder();
    recorder.step({ veir: 0.1, student: null });
    recorder.reset();
    expect(recorder.turns()).toEqual([]);
    expect(recorder.elapsedMs()).toBe(0);
  });
});

describe('pastTimeline', () => {
  it('has segments from turn times and no amplitude at all', () => {
    const source = pastTimeline([
      { speaker: 'veir', startMs: 0, endMs: 4_000, text: 'Hello.' },
      { speaker: 'student', startMs: 4_500, endMs: 9_000 },
      { speaker: 'student', startMs: 9_000, endMs: 9_000 },
    ]);
    expect(source.measured).toBe(false);
    expect(source.turns()).toHaveLength(2);
    expect(source.turns().every((turn) => turn.bins.length === 0)).toBe(true);
    expect(source.elapsedMs()).toBe(9_000);
    const last = source.turns()[1];
    expect(last && turnEnd(last)).toBe(9_000);
  });
});
