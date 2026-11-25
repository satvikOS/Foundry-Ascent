import { describe, expect, it } from 'vitest';

import { findPhrase, nearestAsks, nearestWords, phraseIntent } from './match.js';
import { PLAYBOOK } from './playbook/index.js';
import { FIXTURE_PLAYBOOK } from './testing/fixture-playbook.js';
import { type Playbook } from './types.js';
import { BREAK, contentStems, countsIn, plain, singular, tokens } from './words.js';

describe('words as the engine compares them', () => {
  it('normalises case, quotes, full-width forms, contractions and spellings', () => {
    expect(plain('What’s NEXT?')).toBe('what is next?');
    expect(plain('I’m not sure, I don’t know')).toBe('i am not sure, i do not know');
    expect(plain('can’t, cannot, won’t')).toBe('can not, can not, will not');
    expect(plain('Help me get organised')).toBe('help me get organized');
    expect(plain('ＡＰＰ')).toBe('app');
    expect(plain('We’re at 1,400 items')).toBe('we are at 1400 items');
    expect(plain('the founder’s plan')).toBe('the founder plan');
    expect(plain('we were there')).toBe('we were there');
  });

  it('drops plural endings and nothing else', () => {
    expect(
      ['labs', 'companies', 'boxes', 'processes', 'business', 'this', 'status', 'gas'].map(singular),
    ).toEqual(['lab', 'company', 'box', 'process', 'business', 'this', 'status', 'gas']);
  });

  it('keeps sentence ends between words', () => {
    expect(tokens('Set a price. Table for two?')).toEqual([
      'set',
      'a',
      'price',
      BREAK,
      'table',
      'for',
      'two',
      BREAK,
    ]);
  });

  it('counts people and things, never money, years or percentages', () => {
    expect(countsIn('I talked to 5 people and three said yes')).toEqual([5, 3]);
    expect(countsIn('$2,300 in 2026, 19% of 200 students')).toEqual([200]);
  });

  it('gives the subject words once, in order', () => {
    expect(contentStems('The labs and the lab managers')).toEqual(['lab', 'manager']);
  });
});

describe('intent phrases', () => {
  const phrase = (text: string) => ({
    words: tokens(text),
    open: tokens(text).map(() => false),
    weight: 1,
  });

  it('matches whole words in order, with fillers, and one word between when the phrase is long enough', () => {
    expect(findPhrase(tokens('how should I price the product'), phrase('price product'))).toBe(0);
    expect(findPhrase(tokens('how do I price the actual pilot product'), phrase('price product'))).toBeNull();
    expect(findPhrase(tokens('talk to some angry customers today'), phrase('talk to customers'))).toBe(1);
    expect(findPhrase(tokens('talk to three angry customers'), phrase('talk to customers'))).toBeNull();
    expect(findPhrase(tokens('enterprise'), phrase('price'))).toBeNull();
  });

  it('never matches across a sentence end', () => {
    expect(findPhrase(tokens('That is the price. Product is ready'), phrase('price product'))).toBeNull();
  });

  it('reads a gap where the phrase leaves one', () => {
    expect(phraseIntent(FIXTURE_PLAYBOOK, 'What do I ask the first ten customers?')?.intent.id).toBe(
      'interviews',
    );
  });

  it('leaves an intent out when one of its "unless" words is there', () => {
    expect(phraseIntent(FIXTURE_PLAYBOOK, 'What should I charge?')?.intent.id).toBe('pricing');
    expect(phraseIntent(FIXTURE_PLAYBOOK, 'What should I charge for the conference ticket?')).toBeNull();
  });

  it('puts a referral before every other ask', () => {
    const match = phraseIntent(FIXTURE_PLAYBOOK, 'What should I charge, and who owns the idea?');
    expect(match?.intent.id).toBe('ownership');
  });

  it('prefers the more specific phrase, then the order of the table', () => {
    const two: Playbook = {
      ...FIXTURE_PLAYBOOK,
      intents: [
        { id: 'a', playId: 'price-it', phrases: ['price'] },
        { id: 'b', playId: 'price-it', phrases: ['price my product'] },
        { id: 'c', playId: 'price-it', phrases: ['price my product'] },
      ],
    };
    expect(phraseIntent(two, 'Help me price my product')?.intent.id).toBe('b');
  });

  it('is plainly nearest to one ask by its words, or to none', () => {
    const near = (text: string, guarded = false) =>
      nearestWords(PLAYBOOK, text, { guarded })?.intent.id ?? null;
    expect(near('How do I work out how big the market is')).toBe('market-size');
    expect(near('How many subscriptions do we need before we break even')).toBe('break-even');
    expect(near('Where do I park near the stadium?')).toBeNull();
    // A word or two in common, or much of two plays, is nobody's ask.
    expect(near('Tell me about customers')).toBeNull();
    expect(near('How do I price a used car?')).toBeNull();
    // A message that is no plain question is held to more.
    expect(near('We have about four months of cash left')).toBe('runway');
    expect(near('We have about four months of cash left', true)).toBeNull();
  });

  it('gives nothing when two plays are about as near', () => {
    const tie: Playbook = {
      ...FIXTURE_PLAYBOOK,
      intents: [
        { id: 'first', playId: 'price-it', phrases: ['grant budget report'] },
        { id: 'second', playId: 'run-a-test', phrases: ['report budget grant'] },
      ],
    };
    expect(nearestWords(tie, 'How does a grant budget report work?')).toBeNull();
    // One play's two phrasings are one play.
    const one: Playbook = { ...tie, intents: tie.intents.map((i) => ({ ...i, playId: 'price-it' })) };
    expect(nearestAsks(one, 'How does a grant budget report work?')).toHaveLength(1);
  });
});
