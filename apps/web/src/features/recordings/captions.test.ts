import { describe, expect, it } from 'vitest';

import { CaptionRecorder, cuesAt, parseWebVtt, toWebVtt, vttTime } from './captions';

const NAMES = { veir: 'Thomas', founder: 'Maya' } as const;

describe('CaptionRecorder', () => {
  it('times each unit the vEIR says until the next one, and each line the founder finishes', () => {
    const r = new CaptionRecorder();
    r.observe({ veir: 'Good to see you.', founder: null, founderLive: false }, 0);
    r.observe({ veir: 'What changed this week?', founder: null, founderLive: false }, 1_800);
    r.observe({ veir: null, founder: null, founderLive: false }, 4_000);
    r.observe({ veir: null, founder: 'We ran', founderLive: true }, 5_000);
    r.observe({ veir: null, founder: 'We ran the pilot', founderLive: true }, 6_000);
    r.observe({ veir: null, founder: 'We ran the pilot.', founderLive: false }, 7_500);
    // A typed line arrives whole: it stays long enough to read.
    r.observe({ veir: null, founder: 'And it worked', founderLive: false }, 9_000);
    expect(r.finish(20_000)).toEqual([
      { speaker: 'veir', startMs: 0, endMs: 1_800, text: 'Good to see you.' },
      { speaker: 'veir', startMs: 1_800, endMs: 4_000, text: 'What changed this week?' },
      { speaker: 'founder', startMs: 5_000, endMs: 7_500, text: 'We ran the pilot.' },
      { speaker: 'founder', startMs: 9_000, endMs: 10_200, text: 'And it worked' },
    ]);
  });

  it('closes what is still showing when the recording stops, and ignores blank lines', () => {
    const r = new CaptionRecorder();
    r.observe({ veir: '   ', founder: null, founderLive: false }, 0);
    r.observe({ veir: 'Still   talking', founder: null, founderLive: false }, 3_000);
    expect(r.finish(9_000)).toEqual([
      { speaker: 'veir', startMs: 3_000, endMs: 9_000, text: 'Still talking' },
    ]);
  });
});

describe('WebVTT', () => {
  it('writes and reads the cues back with whose words they are', () => {
    const cues = [
      { speaker: 'veir' as const, startMs: 0, endMs: 1_800, text: 'Pricing <first> & then reach?' },
      { speaker: 'founder' as const, startMs: 3_723_004, endMs: 3_725_000, text: 'Reach.' },
    ];
    const vtt = toWebVtt(cues, NAMES);
    expect(
      vtt.startsWith(
        'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.800\n<v.veir Thomas>Pricing &lt;first&gt; &amp; then reach?',
      ),
    ).toBe(true);
    expect(vtt).toContain('01:02:03.004 --> 01:02:05.000\n<v.founder Maya>Reach.');
    expect(parseWebVtt(vtt)).toEqual([
      { ...cues[0], name: 'Thomas' },
      { ...cues[1], name: 'Maya' },
    ]);
    expect(vttTime(61_500)).toBe('00:01:01.500');
  });

  it('reads plain WebVTT and skips malformed cues', () => {
    expect(
      parseWebVtt(
        'WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHello\r\n\r\nnot a cue\r\n\r\n00:05.000 --> 00:04.000\r\nBackwards',
      ),
    ).toEqual([{ speaker: 'founder', startMs: 1_000, endMs: 2_000, text: 'Hello', name: '' }]);
  });

  it('finds the cue of each voice showing at a moment', () => {
    const cues = parseWebVtt(
      toWebVtt(
        [
          { speaker: 'veir', startMs: 0, endMs: 2_000, text: 'One' },
          { speaker: 'founder', startMs: 1_000, endMs: 3_000, text: 'Two' },
          { speaker: 'veir', startMs: 2_500, endMs: 4_000, text: 'Three' },
        ],
        NAMES,
      ),
    );
    expect(cuesAt(cues, 1_500).map((c) => c.text)).toEqual(['One', 'Two']);
    expect(cuesAt(cues, 2_700).map((c) => c.text)).toEqual(['Two', 'Three']);
    expect(cuesAt(cues, 5_000)).toEqual([]);
  });
});
