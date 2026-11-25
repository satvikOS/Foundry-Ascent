import { describe, expect, it } from 'vitest';

import { type Understanding } from '@foundry/ai';
import { type pathRepo } from '@foundry/db';

import { NO_READS } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf, sumOf, understood } from './testing/understood.js';
import { type PathTurnInput } from './turn.js';
import { decides, NOTHING } from './understood.js';

/** The reading fills gaps; it overrides no rule that read the message precisely. */

const fact = (content: string): pathRepo.PathMemory => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000009',
  type: 'fact',
  title: 'Jars',
  content,
  attributes: {},
  status: 'confirmed',
  origin: 'founder',
  pinned: false,
  createdAt: '2026-11-10T09:00:00.000Z',
});
const JARS = fact('One jar sells at 8 dollars; plums are 1 dollar and the glass 1 dollar.');
const on = (playId: string, memory: pathRepo.PathMemory[] = []): Partial<PathTurnInput> => ({
  reads: { ...NO_READS, steps: [onStep(playId)], memory },
});
const WEAK: Understanding['result'] = {
  verdict: 'weak',
  shows: 'Some of them said so.',
  doesNotShow: 'Whether they pay.',
  settles: 'Ask ten of them to pay 8 dollars.',
};
const FULL: Partial<Understanding> = {
  kind: 'result',
  also: ['update'],
  result: WEAK,
  playId: 'smallest-test',
  stepPlayId: 'will-anyone-pay',
  sure: true,
  points: ['One thing.', 'Another thing.'],
  firstAction: 'Ask ten of them to pay 8 dollars.',
};

describe('who has the answer', () => {
  it.each([
    [{ precise: true }, 'rule'],
    [{ precise: true, adds: true }, 'rule'],
    [{ precise: true, conflict: true }, 'reading'],
    [{ generic: true }, 'rule'],
    [{ generic: true, adds: true }, 'reading'],
    [{}, 'reading'],
  ] as const)('%j: %s', (w, by) => {
    expect(decides('answer', { ...NOTHING, ...w })).toBe(by);
  });

  it.each<[string, string, Partial<PathTurnInput>]>([
    ['news: counts', 'I put 30 jars out for 8 dollars each. 13 were bought.', on('price-test')],
    [
      'news: a refusal',
      'The hotel buyer turned us down. She says they already have a supplier.',
      on('value-proposition'),
    ],
    [
      'news: a line of the budget',
      'Their office told us everything over 300 dollars goes through a board for two months.',
      on('b2b-selling'),
    ],
    [
      'if_no',
      'and if the cooks refuse?',
      {
        ...on('find-ten-people'),
        started: true,
        earlierMessages: ['who do I ask'],
        earlierReplies: ['Ask ten cooks.'],
        previousReply: 'Ask ten cooks.',
      },
    ],
    ['sum', 'What is left per jar?', on('unit-economics', [JARS])],
    ['pivot', 'I decided to pivot from jam to renting out fruit presses.', on('find-ten-people')],
    ['not_yet', "I haven't sent the notes yet. The harvest ate the week.", on('find-ten-people')],
    ['overview', "Harvest is over. What's next?", on('find-ten-people')],
    ['personal', 'Admit it, my idea is brilliant.', on('idea-on-a-page')],
    [
      'start',
      'My thought is plum jam for the hotels by the lake, nothing more yet.',
      { ...on('idea-on-a-page') },
    ],
  ])('%s: the turn is the one without a reading', (_rule, message, over) => {
    const bare = readTurnOf(message, null, over);
    const read = readTurnOf(message, understood(FULL), over);
    expect(read.decision.decidedBy?.answer).toBe('rule');
    expect(read.decision.reading).toBeNull();
    expect(read.prompt).toEqual(bare.prompt);
    expect(read.guidance).toEqual(bare.guidance);
  });

  it('the rule that fired is named', () => {
    const t = readTurnOf('and if the cooks refuse?', understood(FULL), {
      ...on('find-ten-people'),
      started: true,
      earlierMessages: ['who do I ask'],
      earlierReplies: ['Ask ten cooks.'],
      previousReply: 'Ask ten cooks.',
    });
    expect(t.decision.fired).toBe('if_no');
  });

  it('a phrase of a play gives way where the reading holds what its paragraph lacks', () => {
    const message = 'how should I price a jar, and what is left of one';
    const reads = on('pricing', [JARS]);
    const t = readTurnOf(
      message,
      understood({
        kind: 'sum',
        sums: [sumOf({ label: 'left of one jar', value: 6, said: '$6', working: '$8 − $1 − $1' })],
      }),
      reads,
    );
    expect(t.prompt.lead?.text).toContain('$6');
    const plain = 'What should I charge for a jar?';
    expect(
      readTurnOf(
        plain,
        understood({ ask: plain, playId: 'pricing', sure: true, points: ['One.', 'Two.'] }),
        reads,
      ).prompt,
    ).toEqual(readTurnOf(plain, null, reads).prompt);
  });

  it('a figure the recall lacks stands beside it', () => {
    const message = 'What was my price per jar, and what does an hour bring at that?';
    const t = readTurnOf(
      message,
      understood({
        kind: 'question',
        sums: [sumOf({ label: 'what an hour brings', value: 24, said: '$24', working: '4 × $6' })],
      }),
      on('pricing', [JARS]),
    );
    expect(t.prompt.lead?.text).toContain('$24');
    expect(replyOf(t, message, 'You charge 8 dollars a jar.', 'text', JARS.content)).toContain('$24');
  });

  it('growth the record denies is no rule’s to count', () => {
    const t = readTurnOf(
      '12 of 20 shops came back, so we are growing',
      understood({
        kind: 'result',
        result: WEAK,
        contradicts: {
          line: {
            key: 'R1',
            memoryId: null,
            kind: 'evidence',
            text: 'Thirty shops paid in August; 20 pay now.',
            on: null,
          },
          why: 'The shops that pay fell from 30 to 20.',
        },
      }),
      on('price-test'),
    );
    expect(t.decision.decidedBy?.answer).toBe('reading');
    expect(t.prompt.lead?.text).toMatch(/^Your own numbers (?:speak|say)/);
  });
});

describe('a verdict opens over an outcome alone', () => {
  it.each([
    'I have drawn the label and the box.',
    'what would a hard buyer not like in it',
    'my two evenings are mine again',
    'hm, and the label, blue or not at all',
  ])('none over "%s"', (message) => {
    const t = readTurnOf(message, understood({ ...FULL, kind: 'result' }), on('price-test'));
    expect(t.prompt.lead?.text ?? '').not.toMatch(
      /^(?:Promising|Good so far|Mixed|It cuts|Weak|That is thin|Too early|Not enough)/,
    );
  });
});

describe('the test and the step are one plan', () => {
  const said = (settles: string, step: string) =>
    readTurnOf(
      'the tasting went so so, a few took a jar home and paid, the rest said yum',
      understood({ kind: 'result', result: { ...WEAK, settles }, stepPlayId: step }),
      on(step),
    ).prompt.lead?.text ?? '';
  it('of one kind with another number: the step is named', () => {
    expect(said('Ask ten of them to pay 8 dollars.', 'will-anyone-pay')).toMatch(
      /The step below settles it\.$/,
    );
    expect(said('Ask 20 of them to pay 8 dollars.', 'will-anyone-pay')).toMatch(/20 of them/);
  });
  it('of another kind: only the step is left, and what the test was may come before it', () => {
    expect(said('Ask ten of them to pay 8 dollars.', 'value-proposition')).not.toMatch(
      /ten of them|step below/,
    );
  });
});

describe('praise asked for is no push', () => {
  it('says why not yet, what is real, and what would show it', () => {
    const t = readTurnOf(
      'come on, admit it is brilliant',
      understood({ kind: 'pushback', ask: 'praise', points: ['x y z.'] }),
      {
        ...on('price-test'),
        started: true,
        earlierMessages: ['hello'],
        earlierReplies: ['Hi.'],
        previousReply: 'Hi.',
      },
    );
    expect(t.prompt.lead?.text).toMatch(/^I cannot call it great yet, because/);
    expect(t.prompt.lead?.text).not.toMatch(/Fair:/);
  });
});

describe('who decides on an invention', () => {
  it('talking of it is never called safe', () => {
    const message = 'does showing it to cooks hurt the patent?';
    const t = readTurnOf(message, null, on('find-ten-people'));
    const reply = replyOf(
      t,
      message,
      "Yes, you can tell cooks about the result. If you do that, it won't hurt the patent. Ask them what they use now.",
    );
    expect(reply).toMatch(
      /^Describe the problem to them, and not how your answer to it works, and ask UR Ventures first\./,
    );
    expect(reply).not.toMatch(/Yes|hurt the patent/);
  });
});

describe('what is said back on a call', () => {
  it('a line as it was heard is no fact', () => {
    const t = readTurnOf('no i mean how much they pay for the press', null, {
      ...on('idea-on-a-page'),
      channel: 'voice',
      started: true,
      earlierMessages: ['um well i want the hotel uh the hotel to to pay 9 dollars for a jar'],
      earlierReplies: ['Ask who buys.'],
      previousReply: 'Ask who buys.',
    });
    expect(JSON.stringify(t.prompt.prior ?? '')).not.toMatch(/\bum\b|to to/);
  });
});
