/** How many of whom did what: the number that did it and no other, or none. Synthetic wording. */
import { describe, expect, it } from 'vitest';

import { correctionOf, partsIn, talliesIn, tallyOf } from './counts.js';

/** "paid:2/4" for each count of a message. */
const said = (message: string): string[] =>
  talliesIn(message).map(
    (t) =>
      `${t.act}:${String(t.count)}${t.whole === null ? '' : `/${String(t.whole)}`}${t.more ? '+' : ''}${t.friends ? ' friends' : ''}${t.things === null ? '' : ` ${t.things}`}`,
  );

describe('the number that did it', () => {
  it.each<[string, string[]]>([
    // N of the M, however the rest is named.
    ['Two of the other four paid me 20 dollars each.', ['paid:2/4']],
    ['Three of the remaining nine bought a jar.', ['paid:3/9']],
    ['Only 3 of the 40 bought one.', ['paid:3/40']],
    ['Just five of those twelve signed.', ['signed:5/12']],
    ['7 of 10 people paid a deposit of 5 dollars.', ['paid:7/10']],
    ['3 out of 18 have paid 60 dollars for a month.', ['paid:3/18']],
    ['Four customers out of thirty ordered.', ['paid:4/30']],
    ['Out of 40 people, 3 bought.', ['paid:3/40']],
    ['Six of the first twenty-five pre-ordered.', ['paid:6/25']],
    ['One of my eleven testers paid.', ['paid:1/11']],
    // None, half, both, all.
    ['None of the 12 bought.', ['paid:0/12']],
    ['Nobody paid.', ['paid:0']],
    ['Not a single person bought it.', ['paid:0']],
    ['Zero of the nine signed.', ['signed:0/9']],
    ['Half of the 20 paid.', ['paid:10/20']],
    ['I emailed 10 shops and half of them signed.', ['signed:5/10']],
    ['I offered it to 8 cafes and everyone paid.', ['paid:8/8']],
    ['Both paid.', ['paid:2']],
    ['All but two of the 10 paid.', ['paid:8/10']],
    // The whole is in the sentence before, or the clause.
    ['I asked 40 people and only 3 bought.', ['paid:3/40']],
    ['I offered it to 30 parents at 4 dollars a month. 2 paid.', ['paid:2/30']],
    ['20 jars offered at 6 dollars, 11 sold in one day.', ['paid:11/20']],
    ['I phoned fifteen bakers. Four of them ordered.', ['paid:4/15']],
    // Their own doing, and whose number it is.
    ['I sold 40 cookies to 3 students.', ['paid:3']],
    ['I sold sixteen meal boxes last month.', ['paid:16 meal boxes']],
    ['We have two paid pilots.', ['paid:2']],
    ['We got three pre-orders yesterday.', ['paid:3']],
    ['I have 4 paying customers.', ['paid:4']],
    ['We signed two clinics.', ['signed:2']],
    ['A dozen people signed the letter of intent.', ['signed:12']],
    // Yes, paid and signed up are three things.
    ['Two schools said yes at the new fee.', ['yes:2']],
    ['Two signed and three said yes.', ['signed:2', 'yes:3']],
    ['Thirty people joined the waitlist.', ['joined:30']],
    ['200 people saw it and 9 left an email address.', ['joined:9/200']],
    ['Two shops signed up.', ['joined:2']],
    // Talks.
    ['I did eight interviews.', ['talked:8']],
    ['I talked to six people in my hall and four said the windows are small.', ['talked:6']],
    ['I talked to all ten teaching assistants.', ['talked:10']],
    ['I interviewed two more nurses on Monday.', ['talked:2+']],
    ['I spoke with one lab manager.', ['talked:1']],
    ['We had 3 calls with labs and one of them signed.', ['talked:3', 'signed:1']],
    ['I emailed 40 people and talked to 3.', ['talked:3']],
    ['Three of my friends paid.', ['paid:3 friends']],
    ['two ppl paid', ['paid:2']],
  ])('%s', (message, wanted) => {
    expect(said(message)).toEqual(wanted);
  });

  it.each([
    'I talked to about ten people.',
    'I talked to more than 10 students.',
    'Around five paid.',
    '5 or 6 people paid.',
    'One in five paid.',
    '10 percent paid.',
    '30% bought it.',
    'I sell 3 a day.',
    'A few of them paid.',
    'Most of the 20 paid.',
    'Five would pay.',
    'Four will pay next week.',
    'Three caterers said they pay to have leftovers hauled away.',
    'Three said they paid 40 dollars for a tutor.',
    'Two people paid someone else for it.',
    'I emailed 11 shops and half of them signed.',
    'Everyone paid.',
    'I did not talk to 10 people.',
    'I will talk to ten people.',
    'I signed an NDA with 2 companies.',
    'I have 14 listings from my own building and no money to spend.',
    'I got 3 ideas.',
    'Did two of them pay?',
    'The other 38 did not buy.',
  ])('%s: not counted', (message) => {
    expect(talliesIn(message)).toEqual([]);
  });

  it('a spoken yes is no payment, friends are no strangers, and boxes are no buyers', () => {
    const money = (message: string) => tallyOf(talliesIn(message), ['paid', 'signed'])?.count ?? null;
    expect(money('Two schools said yes at the new fee.')).toBeNull();
    expect(money('Three of my friends paid.')).toBeNull();
    expect(money('I sold sixteen meal boxes last month.')).toBeNull();
    expect(money('Three paid and two signed.')).toBe(3);
  });
});

describe('a number taken back', () => {
  it.each<[string, number, number | null, string | null]>([
    ['Actually it was three, not four.', 3, 4, null],
    ['I said eight but it was six.', 6, 8, null],
    ['Correction: 3 people paid, not 5.', 3, 5, 'paid'],
    ['Scratch that, 2 paid.', 2, null, 'paid'],
    ['I did six interviews, not eight.', 6, 8, 'talked'],
    ['Sorry, it was 6 interviews.', 6, null, 'talked'],
    ['I told you nine, but it was really seven.', 7, 9, null],
    ['I counted wrong: four signed instead of five.', 4, 5, 'signed'],
  ])('%s', (message, is, was, act) => {
    expect(correctionOf(message)).toMatchObject({ is, was, act });
  });

  it.each([
    'Actually I think I like it.',
    'I did eight interviews.',
    'Not yet, sorry.',
    'I have 3, not sure.',
  ])('%s takes none back', (message) => {
    expect(correctionOf(message)).toBeNull();
  });
});

it('the parts of a whole a text tells', () => {
  expect(
    partsIn('In the old town six of 20 bars ordered; on the pier eleven out of the 60 did.').map(
      ({ part, whole }) => [part, whole],
    ),
  ).toEqual([
    [6, 20],
    [11, 60],
  ]);
});
