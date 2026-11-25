import { describe, expect, it } from 'vitest';

import { asksIfGood, lastResult, newsOf, passLine, readResult } from './news.js';

const of = (message: string, before: string[] = []) => newsOf({ message, before });

describe('what news means', () => {
  it('who pays is the customer to test; who does not is not', () => {
    expect(of('Nobody on campus paid, but three salons said they pay for this already.')?.means).toBe(
      'Campus did not pay and three salons say they pay: salons are the customer to test. What people pay for today counts more than what they like.',
    );
    expect(of('Nobody paid yet, but four gyms said they pay for cleaning already.')).toMatchObject({
      kind: 'split',
      spoken: 'The first group did not pay and four gyms say they pay, so gyms are the customer to test.',
    });
  });

  it.each([
    ['13 of 25 sold on Saturday.', 13, 25, '52%'],
    ['I sold 13 of 25 boxes at 5 dollars each.', 13, 25, '52%'],
    ['We offered the kit to 25 gyms and 13 of them said yes.', 13, 25, '52%'],
    ['I asked eight cooks to pre-order, and only two signed.', 2, 8, '25%'],
  ])('%s: the rate, and what would make it good', (message, part, whole, rate) => {
    const news = of(message);
    expect(news?.kind).toBe('sold');
    expect(news?.ratio).toEqual({ part, whole });
    expect(news?.means).toContain(`${String(part)} of ${String(whole)} is ${rate}.`);
    expect(news?.means).toContain('No pass line (the number that means it worked) was set first');
    expect(news?.means).toContain('It is good if strangers repeat it and one sale leaves money over.');
  });

  it('is read against the pass line they set, wherever they said it', () => {
    expect(of('13 of 25 sold on Saturday.', ['My pass line is 12 of 25.'])?.means).toBe(
      '13 of 25 is 52%. The number to beat was 12 of 25, so it passed: the next question is whether one sale leaves money over.',
    );
    expect(of('13 of 25 sold on Saturday.', ['ok', 'The target is 18 of 25', 'sure'])?.means).toContain(
      'it did not pass: change one thing, the customer, the offer or the price, and run it once more.',
    );
    expect(passLine(['The pass line: 8 of 20'])).toEqual({ part: 8, whole: 20 });
    expect(passLine(['My pass line is 8 of 20', 'the new target is 12 of 20'])).toEqual({
      part: 12,
      whole: 20,
    });
    expect(passLine(['we talked to 8 of 20'])).toBeNull();
  });

  it('a sign-up is not money, and is never said to have paid', () => {
    for (const message of ['Only 2 of 30 shops signed up', 'Thirty people joined the waitlist.']) {
      expect(of(message)?.kind, message).toBe('interest');
      expect(of(message)?.means, message).toContain('raised a hand, and none of that is money yet');
    }
    expect(of('Only 2 of 30 shops signed up')?.means).toMatch(/^2 of 30 raised/);
  });

  it('what people said: a pattern from half on, with what it does not show', () => {
    expect(of('9 out of 10 people I talked to said they hate the queue')?.means).toBe(
      '9 of 10 (90%) said they hate the queue: more than half is a pattern, so it leads now. It shows the problem, not yet that they would pay to have it gone.',
    );
    expect(of('I did eight interviews. Two of them said the queue is the problem.')?.means).toBe(
      '2 of 8 (25%) said the queue is the problem: less than half is not a pattern yet. Find what those 2 have in common before you build for them.',
    );
  });

  it('a customer who left, an offer, and sales that hang on few', () => {
    expect(of('One of our customers left last week because it was too slow.')?.kind).toBe('left');
    expect(of('A hotel offered to host a tasting for us.')?.kind).toBe('offer');
    expect(of('14 of 20 orders came from the same two shops.')?.means).toContain(
      '14 of 20 (70%) came through two shops',
    );
  });

  it.each([
    'What should I charge?',
    'We had a nice lunch.',
    'Should I sell to 13 of 25 shops?',
    'If 13 of 25 buy I will be happy',
    'I will offer it to 25 gyms',
    '13 of 25 would pay',
    'Three of 40 people I emailed answered.',
  ])('%s is no result', (message) => {
    expect(of(message)?.kind).not.toBe('sold');
  });

  it('on a call it is short', () => {
    for (const message of ['13 of 25 sold on Saturday.', 'One of our customers left last week.'])
      expect(of(message)?.spoken.split(' ').length, message).toBeLessThanOrEqual(30);
  });
});

describe('"Is that good?"', () => {
  it.each(['Is that good?', 'is this any good', 'is 13 of 25 good?', 'How good is that?', 'Did it pass?'])(
    '%s is about the result',
    (message) => {
      expect(asksIfGood(message)).toBe(true);
    },
  );
  it.each(['Is it a good idea?', 'What is a good price?', 'Good morning'])('%s is not', (message) => {
    expect(asksIfGood(message)).toBe(false);
  });

  it('the last result they told, newest first', () => {
    expect(lastResult(['I sold 3 of 10 mugs', 'I sold 13 of 25 mugs', 'ok thanks'])).toEqual({
      part: 13,
      whole: 25,
    });
    expect(lastResult(['We offered it to 25 gyms and 13 said yes'])).toEqual({ part: 13, whole: 25 });
    expect(lastResult(['I talked to 13 of 25 people'])).toBeNull();
  });

  it('is answered with the rate, the pass line and what would make it good', () => {
    const { text } = readResult({ part: 13, whole: 25 }, []);
    expect(text).toMatch(/^13 of 25 is 52%\. No pass line/);
    expect(text).toContain('write that number for the next 25 people before you ask them');
    expect(text).toContain('It is good if');
  });
});
