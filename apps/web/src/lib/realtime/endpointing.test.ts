import { describe, expect, it } from 'vitest';

import {
  BARGE_SUSTAIN_MS,
  Endpointer,
  SLOW_DOWN_MAX,
  SLOW_DOWN_STEP,
  VoiceRun,
  backchannelOnly,
  classifyUtterance,
  floorWords,
} from './endpointing';
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

describe('Endpointer (fixed: one silence for everything, the switch back)', () => {
  it('waits for a stable transcript and the silence window before ending a turn', () => {
    const time = clock();
    const ep = new Endpointer(time.now, { mode: 'fixed', silenceMs: 600 });
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
    const ep = new Endpointer(time.now, { mode: 'fixed', silenceMs: 600 });
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
    const ep = new Endpointer(time.now, { mode: 'fixed', silenceMs: 600 });
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

  it('hears words added to a sent result even when Transcribe revised a sent word, and drops ones it retracts', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onResult({ resultId: 'a', text: 'How do I price the pilots', partial: true, stable: false });
    expect(ep.take()).toBe('How do I price the pilots');
    // A revision of the sent words alone is not new speech.
    ep.onResult({ resultId: 'a', text: 'How do I price the pilot', partial: true, stable: false });
    expect(ep.hasSpeech()).toBe(false);
    ep.onResult({
      resultId: 'a',
      text: 'How do I price the pilot for small clinics',
      partial: true,
      stable: false,
    });
    expect(ep.text()).toBe('for small clinics');
    // Transcribe takes the added words back.
    ep.onResult({ resultId: 'a', text: 'How do I price the pilot.', partial: false, stable: true });
    expect(ep.hasSpeech()).toBe(false);

    // A word split or joined differently is a revision, not new speech.
    ep.onResult({ resultId: 'b', text: 'We cannot afford it', partial: true, stable: false });
    expect(ep.take()).toBe('We cannot afford it');
    ep.onResult({ resultId: 'b', text: 'We can not afford it.', partial: false, stable: true });
    expect(ep.hasSpeech()).toBe(false);
    ep.onResult({
      resultId: 'b',
      text: 'We can not afford it. Not this year.',
      partial: false,
      stable: true,
    });
    expect(ep.text()).toBe('Not this year.');
  });

  it('gives back the latest take as Transcribe now has it, ahead of what followed', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onResult({ resultId: 'a', text: 'How do I price the pilots', partial: true, stable: false });
    const take = (ep.take(), ep.takeGeneration());
    ep.onResult({ resultId: 'a', text: 'How do I price the pilot for', partial: true, stable: false });
    ep.onResult({ resultId: 'b', text: 'small clinics', partial: true, stable: false });
    expect(ep.text()).toBe('for small clinics');
    expect(ep.untake(take)).toBe(true);
    expect(ep.text()).toBe('How do I price the pilot for small clinics');
    // Only once, and only the latest take.
    expect(ep.untake(take)).toBe(false);
    ep.onResult({ resultId: 'a', text: 'How do I price the pilot for', partial: false, stable: true });
    expect(ep.take()).toBe('How do I price the pilot for small clinics');
    const sent = ep.takeGeneration();
    ep.discard();
    expect(ep.untake(sent)).toBe(false);
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

describe('classifyUtterance', () => {
  it('reads a finished sentence, a question and a short answer as complete', () => {
    expect(classifyUtterance('We interviewed twelve clinics.')).toEqual({
      reason: 'sentence_end',
      class: 'complete',
    });
    expect(classifyUtterance('How do I price the pilot?')).toEqual({ reason: 'question', class: 'complete' });
    for (const answer of ['Yes', 'No.', 'Yeah.', 'yeah sure.', 'Thank you', 'Of course', 'I think so.']) {
      expect(classifyUtterance(answer).class, answer).toBe('complete');
    }
  });

  it('waits like an open line on a question that has no question mark yet: its opening says nothing of its end', () => {
    // Production 2026-11-08: "What are the unit economic" and "Could you explain me the value proposition can" were
    // sent 300 ms into a pause, as finished questions, and answered in half.
    for (const question of [
      'so how do I price the pilot',
      'can we raise this year',
      'is it worth it',
      'what should we charge',
      "what's the plan",
      'What are the unit economic',
      'Could you explain me the value proposition can',
    ]) {
      expect(classifyUtterance(question), question).toEqual({ reason: 'question', class: 'open' });
    }
  });

  it('never reads a statement that opens with a question word as a question', () => {
    for (const statement of [
      'When we launched last year',
      'How we got here was mostly luck',
      'Any clinic that signs up',
      'What I want to say is that',
      'Which clinics pay the most',
      'Do that first',
    ]) {
      expect(classifyUtterance(statement).class, statement).not.toBe('complete');
    }
    expect(classifyUtterance('When we launched last year')).toEqual({ reason: 'open', class: 'open' });
  });

  it('waits after a lone unpunctuated "yeah", "okay", "well" or "so": people often go on after it', () => {
    for (const lone of ['Yeah', 'Okay', 'Probably', 'You', 'not really', 'yeah sure']) {
      expect(classifyUtterance(lone), lone).toEqual({ reason: 'short_answer', class: 'open' });
    }
    expect(classifyUtterance('well').class).toBe('incomplete');
    expect(classifyUtterance('so').class).toBe('incomplete');
  });

  it('reads a line with no punctuation and no question as open', () => {
    expect(classifyUtterance('The clinics pay monthly today')).toEqual({ reason: 'open', class: 'open' });
  });

  it('reads fillers, conjunctions, self-corrections, trailing commas and fragments as incomplete', () => {
    const cases: [string, string][] = [
      ['I think the price is too high, um', 'filler'],
      ['and uh', 'filler'],
      ['We built the dashboard and', 'continuation'],
      // Transcribe's final result puts a full stop even after a dangling conjunction.
      ['We built the dashboard and.', 'continuation'],
      ['It failed because', 'continuation'],
      ['So the main thing is', 'continuation'],
      ['We should talk to the', 'continuation'],
      ['We need about fifty, I mean', 'self_correction'],
      ['twelve, sorry', 'self_correction'],
      ['We need about fifty,', 'trailing_comma'],
      ['Well...', 'trailing_comma'],
      ['The thing', 'fragment'],
      ['Twelve', 'fragment'],
      ['', 'fragment'],
    ];
    for (const [text, reason] of cases) {
      expect(classifyUtterance(text), text).toEqual({ reason, class: 'incomplete' });
    }
    // "so" closes "I think so"; elsewhere it carries on.
    expect(classifyUtterance('and the pilot so').reason).toBe('continuation');
    // A two-word line with its full stop is a whole answer.
    expect(classifyUtterance('Twelve clinics.').class).toBe('complete');
  });
});

describe('Endpointer (adaptive)', () => {
  it('waits 600 ms after a finished line, 1.5 s after an open one and 2 s after an unfinished one', () => {
    const cases: [string, number][] = [
      ['How do I price the pilot?', 600],
      ['The clinics pay monthly today', 1_500],
      ['What are the unit economic', 1_500],
      ['Hi, Thomas. How', 1_500],
      ['I think the price is too high, um', 2_000],
      ['Yeah, so my', 2_000],
    ];
    for (const [text, wait] of cases) {
      const time = clock();
      const ep = new Endpointer(time.now);
      ep.onVoice();
      ep.onResult({ resultId: 'a', text, partial: true, stable: true });
      time.advance(wait - 1);
      expect(ep.decide(), text).toBeNull();
      time.advance(1);
      expect(ep.decide(), text).toMatchObject({ waitMs: wait, quietMs: wait });
    }
  });

  it('waits for an unsettled partial to stop changing (250 ms at most)', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'How do I price', partial: true, stable: false });
    time.advance(400);
    ep.onResult({ resultId: 'a', text: 'How do I price it?', partial: true, stable: false });
    time.advance(200);
    expect(ep.decide(), 'quiet long enough, but changed 200 ms ago').toBeNull();
    time.advance(50);
    expect(ep.decide()).toMatchObject({ reason: 'question', quietMs: 650 });
  });

  it('keeps the fixed silence while the transcript is behind the voice', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onResult({ resultId: 'a', text: 'Our churn is eight percent', partial: true, stable: true });
    time.advance(600);
    ep.onVoice(); // words the transcript has not shown yet
    time.advance(1_400);
    expect(ep.decide()).toBeNull();
    time.advance(100);
    expect(ep.decide()).toMatchObject({ reason: 'catching_up', waitMs: 1_500 });
  });

  it('starts over when the founder speaks again within the wait', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'So the main thing is', partial: true, stable: true });
    time.advance(1_900);
    expect(ep.decide()).toBeNull();
    ep.onVoice();
    ep.onResult({ resultId: 'a', text: 'So the main thing is budget.', partial: false, stable: true });
    time.advance(599);
    expect(ep.decide()).toBeNull();
    time.advance(1);
    expect(ep.decide()).toMatchObject({ reason: 'sentence_end' });
    expect(ep.take()).toBe('So the main thing is budget.');
  });

  it('waits half as long again each time it is told the founder was cut off, up to twice the defaults', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    expect(ep.slowDown()).toBe(SLOW_DOWN_STEP);
    expect(ep.slowDown()).toBe(SLOW_DOWN_MAX);
    expect(ep.slowDown()).toBe(SLOW_DOWN_MAX);
    for (const [text, wait] of [
      ['How do I price the pilot?', 1_200],
      ['The clinics pay monthly today', 3_000],
      ['Yeah, so my', 4_000],
    ] as const) {
      ep.onVoice();
      ep.onResult({ resultId: text, text, partial: true, stable: true });
      time.advance(wait - 1);
      expect(ep.decide(), text).toBeNull();
      time.advance(1);
      expect(ep.decide(), text).toMatchObject({ waitMs: wait });
      ep.take();
    }
    // The fixed silence (the switch back) is not adaptive and never grows.
    const fixed = new Endpointer(time.now, { mode: 'fixed' });
    fixed.slowDown();
    fixed.onVoice();
    fixed.onResult({ resultId: 'f', text: 'Hello there.', partial: false, stable: true });
    time.advance(600);
    expect(fixed.decide()).toMatchObject({ waitMs: 600 });
  });

  it('tells when what is heard goes on from the line just taken', () => {
    const time = clock();
    const ep = new Endpointer(time.now);
    expect(ep.continues()).toBeNull();
    ep.onResult({
      resultId: 'a',
      text: 'Could you explain the value proposition',
      partial: true,
      stable: true,
    });
    expect(ep.continues(), 'nothing taken yet').toBeNull();
    expect(ep.take()).toBe('Could you explain the value proposition');
    // Transcribe adds the rest to the same result: one utterance.
    ep.onResult({
      resultId: 'a',
      text: 'Could you explain the value proposition canvas?',
      partial: false,
      stable: true,
    });
    expect(ep.text()).toBe('canvas?');
    expect(ep.continues()).toBe('Could you explain the value proposition');
    expect(ep.take()).toBe('canvas?');

    // A new result opening in lower case after a line that did not end a sentence.
    ep.onResult({ resultId: 'b', text: 'What are the unit economic', partial: true, stable: true });
    ep.take();
    ep.onResult({ resultId: 'c', text: 'for this.', partial: false, stable: true });
    expect(ep.continues()).toBe('What are the unit economic');
    ep.take();

    // Not after a finished sentence, nor when the new line opens with a capital ("I" always has one).
    ep.onResult({ resultId: 'd', text: 'We talked to twelve clinics.', partial: false, stable: true });
    ep.take();
    ep.onResult({ resultId: 'e', text: 'and three said yes.', partial: false, stable: true });
    expect(ep.continues()).toBeNull();
    ep.take();
    ep.onResult({ resultId: 'f', text: 'So my next', partial: true, stable: true });
    ep.take();
    ep.onResult({ resultId: 'g', text: 'I mean the pricing.', partial: false, stable: true });
    expect(ep.continues()).toBeNull();

    // A line given back is heard whole again: nothing goes on from it.
    const other = new Endpointer(time.now);
    other.onResult({ resultId: 'a', text: 'So my next', partial: true, stable: true });
    other.take();
    other.untake(other.takeGeneration());
    other.onResult({ resultId: 'b', text: 'question is pricing', partial: true, stable: true });
    expect(other.continues()).toBeNull();
    expect(other.text()).toBe('So my next question is pricing');
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

  it('tells a backchannel apart from the vEIR’s echo and from words that take the floor', () => {
    const spoken = 'Start with one library.';
    expect(backchannelOnly('Mm-hmm.', spoken)).toBe(true);
    expect(backchannelOnly('yeah, right', spoken)).toBe(true);
    expect(backchannelOnly('one library', spoken)).toBe(false);
    expect(backchannelOnly('yeah but', spoken)).toBe(false);
    expect(backchannelOnly('', spoken)).toBe(false);
  });

  it('never takes "sorry", "wait" or "actually" for a backchannel: they open a turn (LAB-V4)', () => {
    const spoken = 'Start with one library and a written success threshold.';
    expect(floorWords('Sorry to cut in', spoken)).toEqual(['sorry', 'to', 'cut', 'in']);
    expect(floorWords('wait, actually', spoken)).toEqual(['wait', 'actually']);
    for (const backchannel of ['mm', 'yeah', 'right', 'okay', 'mm-hmm', 'uh-huh', 'got it']) {
      expect(floorWords(backchannel, spoken), backchannel).toEqual([]);
    }
  });
});

describe('VoiceRun (LAB-V4: barge-in on the voice, before the transcript)', () => {
  /** Feeds 50 ms frames of the pattern ('x' voiced, '.' quiet); returns the run's length after each. */
  function feed(run: VoiceRun, time: ReturnType<typeof clock>, pattern: string): number[] {
    return pattern.split('').map((c) => {
      time.advance(50);
      return run.frame(c === 'x');
    });
  }

  it('measures a run of voice across the short gaps between words', () => {
    const time = clock();
    const run = new VoiceRun(time.now);
    const lengths = feed(run, time, 'xxxxxx.xxxxxxxx');
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(BARGE_SUSTAIN_MS);
    expect(Math.max(...lengths.slice(0, 10))).toBeLessThan(BARGE_SUSTAIN_MS);
  });

  it('ends a run at a real pause, so backchannels never add up to one', () => {
    const time = clock();
    const run = new VoiceRun(time.now);
    // "Yeah." … "Right." … "Mm-hmm.": each shorter than a barge-in, with pauses between them.
    const lengths = feed(run, time, 'xxxxxx......xxxxx......xxxxxxxxx......');
    expect(Math.max(...lengths)).toBeLessThan(BARGE_SUSTAIN_MS);
    expect(run.duration()).toBe(0);
    run.reset();
    expect(feed(run, time, 'x')).toEqual([0]);
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
