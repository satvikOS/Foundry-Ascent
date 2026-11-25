import { type retrievalRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { decide, guidanceOf, type DecideInput, type Decision } from './engine.js';
import { PLAYBOOK } from './playbook/index.js';
import {
  intentOfPlay,
  PLAY_MATCH_PROFILES,
  pickPlay,
  playAsks,
  playMatchProfile,
  type PlayMatchProfile,
} from './semantic.js';
import { FIXTURE_PLAYBOOK } from './testing/fixture-playbook.js';
import { fresh, input, withHistory } from './testing/inputs.js';

const MODEL = 'amazon.titan-embed-text-v2:0';
const known = playMatchProfile(MODEL);
if (known === null) throw new Error('no constants');
const profile: PlayMatchProfile = known;
const near = (...plays: [playId: string, score: number][]): retrievalRepo.NearPlays => ({
  modelId: MODEL,
  plays: plays.map(([playId, score]) => ({ playId, score })),
});
const pick = (message: string, found: retrievalRepo.NearPlays, open: 'ask' | 'guarded' = 'ask') => {
  const { intent, referral } = pickPlay(FIXTURE_PLAYBOOK, message, found, open);
  return [intent?.id ?? null, referral?.who ?? null];
};
const OFFICE = 'The technology transfer office';
const ASKED = 'What number do I put on the sticker?';

describe('choosing a play by meaning', () => {
  const { floor, margin, referralFloor, guard } = profile;

  it('takes the nearest play at the floor, with room to the next one', () => {
    expect(pick(ASKED, near(['price-it', floor], ['unit-economics', floor - margin - 0.001]))).toEqual([
      'pricing',
      null,
    ]);
    expect(pick(ASKED, near(['price-it', floor - 0.001], ['unit-economics', 0.1]))).toEqual([null, null]);
    expect(pick(ASKED, near(['price-it', 0.9], ['unit-economics', 0.9 - margin + 0.001]))).toEqual([
      null,
      null,
    ]);
    expect(pick(ASKED, near(['price-it', 0.9]))).toEqual(['pricing', null]);
    expect(pick(ASKED, near())).toEqual([null, null]);
  });

  it('asks more of a message that is no plain first question', () => {
    const found = near(['price-it', floor + guard - 0.001], ['unit-economics', 0.1]);
    expect(pick(ASKED, found, 'guarded')).toEqual([null, null]);
    expect(pick(ASKED, found)).toEqual(['pricing', null]);
    expect(pick(ASKED, near(['price-it', floor + guard]), 'guarded')).toEqual(['pricing', null]);
  });

  it('a referral play needs a higher floor to be the answer, and brings its person when it is about as near', () => {
    expect(pick(ASKED, near(['who-owns-it', referralFloor], ['price-it', 0.2]))).toEqual(['ownership', null]);
    // Near, not near enough to be the answer.
    expect(pick(ASKED, near(['who-owns-it', referralFloor - 0.001], ['price-it', 0.2]))).toEqual([
      null,
      OFFICE,
    ]);
    // About as near as another play: neither is the answer, and who decides comes with the reply.
    const tie = near(['price-it', 0.7], ['who-owns-it', 0.7 - margin + 0.001], ['unit-economics', 0.2]);
    expect(pick(ASKED, tie)).toEqual([null, OFFICE]);
    // Third, and still about as near.
    expect(pick(ASKED, near(['price-it', 0.7], ['unit-economics', 0.695], ['who-owns-it', 0.69]))).toEqual([
      null,
      OFFICE,
    ]);
    // Further off, or under the floor: nobody is named.
    expect(pick(ASKED, near(['price-it', 0.7], ['unit-economics', 0.69], ['who-owns-it', 0.6]))).toEqual([
      null,
      null,
    ]);
    expect(pick(ASKED, near(['price-it', floor - 0.01], ['who-owns-it', floor - 0.02]))).toEqual([
      null,
      null,
    ]);
    // The play that answers comes alone.
    expect(pick(ASKED, near(['price-it', 0.8], ['who-owns-it', 0.6]))).toEqual(['pricing', null]);
  });

  it('leaves out plays it does not know, and an ask the play’s own rules say is another one', () => {
    expect(pick(ASKED, near(['no-such-play', 0.95], ['price-it', 0.7]))).toEqual(['pricing', null]);
    expect(pick('What does a conference seat cost me?', near(['price-it', 0.9]))).toEqual([null, null]);
  });

  it('is the same whatever order equal plays come in, and reads no more than the nearest three', () => {
    const a = near(['unit-economics', 0.8], ['price-it', 0.8], ['channel-choice', 0.2]);
    const b = near(['channel-choice', 0.2], ['price-it', 0.8], ['unit-economics', 0.8]);
    expect(pickPlay(FIXTURE_PLAYBOOK, ASKED, a, 'ask')).toEqual(pickPlay(FIXTURE_PLAYBOOK, ASKED, b, 'ask'));
    const zero = { floor: 0.1, margin: 0, referralFloor: 0.1, guard: 0 };
    expect(pickPlay(FIXTURE_PLAYBOOK, ASKED, a, 'ask', zero).intent?.id).toBe('pricing');
    expect(
      pick(
        ASKED,
        near(['price-it', 0.7], ['unit-economics', 0.699], ['channel-choice', 0.698], ['who-owns-it', 0.697]),
      ),
    ).toEqual([null, null]);
  });

  it('matches nothing with a model it has no constants for; an inference profile has its model’s', () => {
    expect(playMatchProfile('model-of-tomorrow')).toBeNull();
    expect(playMatchProfile('us.cohere.embed-v4:0')).toBe(PLAY_MATCH_PROFILES['cohere.embed-v4:0']);
    const found = { ...near(['price-it', 0.99]), modelId: 'model-of-tomorrow' };
    expect(pick(ASKED, found)).toEqual([null, null]);
  });

  it('has constants that make sense: a referral and an unclear message need more, never less', () => {
    for (const [id, p] of Object.entries(PLAY_MATCH_PROFILES)) {
      expect(p.floor, id).toBeGreaterThan(0);
      expect(p.margin, id).toBeGreaterThan(0);
      expect(p.referralFloor, id).toBeGreaterThan(p.floor);
      expect(p.guard, id).toBeGreaterThan(0);
    }
  });
});

describe('when a message is matched by meaning', () => {
  const openOf = (message: string, over: Partial<DecideInput> = withHistory()) =>
    decide(input(message, over)).open;
  const guidance = guidanceOf(FIXTURE_PLAYBOOK, decide(input('What should I charge?', withHistory())));

  it('only when no rule names a play, for what asks something', () => {
    expect(openOf('What number do I put on the sticker?')).toBe('ask');
    expect(openOf('I keep wondering about the number on the sticker')).toBe('guarded');
    expect(openOf('What should I charge?')).toBeNull();
    expect(openOf('Who owns the idea?')).toBeNull();
  });

  it.each([
    ['a greeting', 'Hi there!'],
    ['thanks', 'Thanks so much, this was great'],
    ['a recall', 'What did we decide yesterday?'],
    ['the path', 'What should I do next?'],
    ['a report', 'I emailed four lab managers yesterday'],
    ['a report of nothing done', 'I did not get around to it'],
    ['a commitment', "I'll email the five labs by Friday"],
    ['a rehearsal', 'Can we practice my pitch?'],
    ['less to do', 'That is too much for this week'],
    ['another idea', 'My idea is a drone network that delivers insulin to rural clinics'],
    ['a change of direction', 'We decided to pivot to renting lab freezers to biotech clubs'],
    ['distress', 'I feel hopeless and I cannot stop crying, why does any of it matter'],
    ['nothing said', 'why?'],
  ])('never %s', (_, message) => {
    expect(openOf(message)).toBeNull();
  });

  it('never a crisis, a conflict or a message the classifier says is about safety', () => {
    expect(openOf(ASKED, withHistory({ crisis: true }))).toBeNull();
    for (const category of ['safety_wellbeing', 'conflict_harassment'] as const)
      expect(openOf(ASKED, withHistory({ riskCategories: [category] }))).toBeNull();
  });

  it('never a follow-up: what goes on about the step before, or points at what was just said', () => {
    const on = withHistory({ previous: guidance, started: true, previousReply: 'Ask three labs for $40.' });
    expect(openOf('How would I do that with my class schedule?', on)).toBeNull();
    expect(openOf('And when I email them, should the number go in the subject line?', on)).toBeNull();
    expect(openOf('Mostly nursing students in their second year', on)).toBeNull();
    expect(openOf('sticker number', on)).toBeNull();
    // A question of its own may be.
    expect(openOf('How do I get the dean to notice the lab?', on)).toBe('guarded');
  });

  it('never what answers the coach’s question, or tells the idea', () => {
    expect(
      openOf('Mostly nursing students in their second year', { previousReply: 'Who is it for?' }),
    ).toBeNull();
    expect(openOf('We sell barcode labels to university research labs', fresh())).toBeNull();
  });
});

describe('the decision', () => {
  const decided = (message: string, found: retrievalRepo.NearPlays | null, over = withHistory()): Decision =>
    decide(input(message, { ...over, near: found }));

  it('answers with the play it means, as a rule would have: the same step, evidence and guidance', () => {
    const found = near(['price-it', 0.8], ['unit-economics', 0.3]);
    const by = decided(ASKED, found);
    const rule = decide(input('What should I charge?', withHistory()));
    expect([by.intent, by.matched, by.score, by.play?.id]).toEqual(['pricing', 'semantic', 0.8, 'price-it']);
    expect([rule.matched, rule.score, rule.open]).toEqual(['phrase', null, null]);
    expect(by.step).toEqual(rule.step);
    expect(guidanceOf(FIXTURE_PLAYBOOK, by)).toEqual(guidanceOf(FIXTURE_PLAYBOOK, rule));
    expect(decided(ASKED, found)).toEqual(by);
  });

  it('is what it was without one: no scores, none near enough, or two about as near', () => {
    const plain = decide(input(ASKED, withHistory()));
    expect([plain.intent, plain.matched, plain.play]).toEqual([null, null, null]);
    expect(decided(ASKED, null)).toEqual(plain);
    for (const found of [near(['price-it', 0.2]), near(['price-it', 0.8], ['unit-economics', 0.79])]) {
      const by = decided(ASKED, found);
      expect({ ...by, score: null }).toEqual(plain);
      expect(by.score).toBe(found.plays[0]?.score);
    }
  });

  it('never changes what a rule names', () => {
    const found = near(['ten-interviews', 0.99], ['price-it', 0.1]);
    for (const message of ['What should I charge?', 'Who owns the idea?', 'What next?', 'thanks!'])
      expect(decided(message, found), message).toEqual(decide(input(message, withHistory())));
  });

  it('a referral play close by brings its person, and the step stays the path’s', () => {
    const plain = decide(input(ASKED, withHistory()));
    const by = decided(ASKED, near(['price-it', 0.7], ['who-owns-it', 0.69]));
    expect([by.intent, by.matched, by.referral?.who]).toEqual([null, null, OFFICE]);
    expect(by.step).toEqual(plain.step);
    const chosen = decided(ASKED, near(['who-owns-it', 0.8], ['price-it', 0.3]));
    expect([chosen.intent, chosen.matched, chosen.referral?.who]).toEqual(['ownership', 'semantic', OFFICE]);
  });
});

describe('when its meaning could not be asked', () => {
  const first = (message: string, near: DecideInput['near'], over: Partial<DecideInput> = {}) =>
    decide(input(message, fresh({ playbook: PLAYBOOK, near, ...over })));
  const PLAIN = 'How do I work out how big the market is';

  it('the nearest words stand in, only where they are plain, and say so', () => {
    const d = first(PLAIN, 'unavailable');
    expect([d.intent, d.matched, d.score, d.open]).toEqual(['market-size', 'lexical', null, 'ask']);
    expect(first('How do I know the crowd for this is worth it?', 'unavailable').intent).toBeNull();
  });

  it('they are never asked while meaning is, whatever it says', () => {
    expect([first(PLAIN, null).intent, first(PLAIN, null).open]).toEqual([null, 'ask']);
    const none = near(['pricing', 0.1]);
    expect([first(PLAIN, none).intent, first(PLAIN, none).matched]).toEqual([null, null]);
    const other = near(['pricing', 0.9], ['market-size', 0.2]);
    expect([first(PLAIN, other).intent, first(PLAIN, other).matched]).toEqual(['pricing', 'semantic']);
    // A model without constants cannot say.
    expect(first(PLAIN, { ...none, modelId: 'model-of-tomorrow' }).matched).toBe('lexical');
  });

  it('a question beside a report is asked about; the report alone is not', () => {
    expect(first('I talked to a professor about it today. How do I log what she said?', null).open).toBe(
      'guarded',
    );
    expect(first('I talked to a professor about it today', null).open).toBeNull();
  });
});

describe('what founders ask each play for', () => {
  const { version, asks } = playAsks(PLAYBOOK);

  it('is one to three short texts of each play, every phrase in one of them', () => {
    expect(version).toBe(PLAYBOOK.version);
    const of = (id: string) => asks.filter((a) => a.playId === id).map((a) => a.text);
    for (const play of PLAYBOOK.plays) {
      const texts = of(play.id);
      expect(texts.length, play.id).toBeGreaterThanOrEqual(1);
      expect(texts.length, play.id).toBeLessThanOrEqual(3);
      expect(texts[0], play.id).toContain(play.title);
      for (const text of texts) {
        expect(text.length, play.id).toBeLessThanOrEqual(900);
        expect(text, play.id).not.toMatch(/\.\.\.|…|\*|\n/);
      }
      const intent = intentOfPlay(PLAYBOOK, play.id);
      for (const phrase of intent?.phrases ?? [])
        expect(texts.join(' '), `${play.id}: ${phrase}`).toContain(
          phrase.replace(/\s*\.\.\.\s*/g, ' ').trim(),
        );
    }
    expect(new Set(asks.map((a) => a.text)).size).toBe(asks.length);
  });

  it('is the same every time, and leaves out what is only said in passing', () => {
    expect(playAsks(PLAYBOOK)).toEqual({ version, asks });
    for (const note of PLAYBOOK.intents.filter((i) => i.note === true))
      for (const phrase of note.phrases)
        expect(
          asks.some((a) => a.text.includes(`${phrase}.`)),
          phrase,
        ).toBe(false);
  });
});
