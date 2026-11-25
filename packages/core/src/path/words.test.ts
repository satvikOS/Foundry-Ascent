import { describe, expect, it } from 'vitest';

import { findPhrase, lexicalIntent, phraseIntent } from './match.js';
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

  it('falls back to the nearest phrase above the threshold, at least two words shared', () => {
    expect(lexicalIntent(FIXTURE_PLAYBOOK, 'Can you walk me through economics of a unit?')?.intent.id).toBe(
      'unit',
    );
    expect(lexicalIntent(FIXTURE_PLAYBOOK, 'Where do I park near the stadium?')).toBeNull();
    expect(lexicalIntent(FIXTURE_PLAYBOOK, 'Tell me about customers')).toBeNull();
  });

  it('breaks a lexical tie by the order of the table, every time', () => {
    const tie: Playbook = {
      ...FIXTURE_PLAYBOOK,
      intents: [
        { id: 'first', playId: 'price-it', phrases: ['grant budget report'] },
        { id: 'second', playId: 'price-it', phrases: ['report budget grant'] },
      ],
    };
    for (let i = 0; i < 50; i += 1)
      expect(lexicalIntent(tie, 'How does a grant budget report work?')?.intent.id).toBe('first');
  });
});
