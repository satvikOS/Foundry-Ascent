import { describe, expect, it } from 'vitest';

import { TOPICS } from '../gateway/mock-content.js';
import { checkDeidentified, type LessonDeidentifyContext } from './deidentify.js';
import { isEnglishWord } from './lexicon.js';

const CTX: LessonDeidentifyContext = {
  ventureNames: ['QuietQuad', 'BenchTally', 'Kelp Kinetics'],
  personNames: ['Maya Okafor-Lindqvist', 'Devin Ashcombe', 'Corin Halvorsen'],
  canaries: ['CANARY::quietquad::7KQ2M9XA'],
  denylist: ['Riverside Public Library', 'Northgate Labs', 'Acme Ventures Fund'],
  allowedTerms: ['Mom Test', 'Jobs to be Done'],
};

const GOOD = [
  'Ask about the last time, not the next time',
  'A founder was running early customer interviews and hearing strong enthusiasm for the idea.',
  'Interviewees agreed they would use the product but could not describe a recent occurrence of the problem.',
  'Rewrite the interview guide around the most recent occurrence, using the Mom Test style of questions.',
  'The founder separated people with a real, frequent problem from polite supporters.',
  'Rare but costly problems may not have a recent occurrence; ask about the last one instead.',
];

describe('checkDeidentified', () => {
  it('reads a descriptive denylist entry by its whole text and proper nouns, not its everyday words', () => {
    const ctx: LessonDeidentifyContext = {
      ...CTX,
      denylist: [
        'Library operations manager open to a pilot conversation',
        'Pilot interview notes',
        'Kaiser pilot notes',
      ],
    };
    // Everyday words of a relationship title or document name identify no one.
    expect(
      checkDeidentified(
        [
          'Book the pilot conversation early',
          'A founder kept interview notes after every pilot conversation with a library operations manager.',
        ],
        ctx,
        { titleIndex: 0 },
      ),
    ).toEqual({ ok: true, reasons: [] });
    for (const text of [
      'The buyer said kaiser would decide after the pilot.',
      'A library operations manager open to a pilot conversation helped.',
    ]) {
      expect(checkDeidentified([GOOD[0] ?? '', text], ctx, { titleIndex: 0 }).reasons, text).toContain(
        'denylisted',
      );
    }
    // An entry that reads as a name still counts word by word ("the riverside pilot").
    const named = checkDeidentified([GOOD[0] ?? '', 'The riverside pilot doubled bookings.'], CTX, {
      titleIndex: 0,
    });
    expect(named.reasons).toContain('denylisted');
  });

  it('accepts a generic, de-identified lesson', () => {
    expect(checkDeidentified(GOOD, CTX, { titleIndex: 0 })).toEqual({ ok: true, reasons: [] });
  });

  it('accepts a Title Case title and generic startup vocabulary', () => {
    const fields = [
      'Test The Riskiest Assumption First',
      'A B2B founder had an MVP, a few LOIs and unclear CAC; the IRB process and FDA rules were still open.',
      "I'd say the SaaS pilot needed a clear owner, and the EIR agreed in general terms.",
    ];
    expect(checkDeidentified(fields, CTX, { titleIndex: 0 })).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ['venture_name', 'The QuietQuad team ran a pilot.'],
    ['venture_name', 'A founder much like the one at Kelp Kinetics.'],
    ['venture_name', 'Kinetics-style hardware founders struggle with this.'],
    ['person_name', 'Maya learned that buyers hesitate.'],
    ['person_name', 'The founder, Okafor-Lindqvist, asked for help.'],
    ['person_name', 'As corin halvorsen says, talk to buyers.'],
    ['canary', 'Reference canary::quietquad::7kq2m9xa in the notes.'],
    ['denylisted', 'The pilot at riverside public library went well.'],
    ['denylisted', 'Funding came from Acme Ventures Fund.'],
    ['email', 'Write to someone@example.org for details.'],
    ['url', 'See www.example.org for the template.'],
    ['url', 'The tool at libraryseats.io helped.'],
    ['number', 'They interviewed 14 students.'],
    ['number', 'Conversion rose to 0.4 in a month.'],
    ['money', 'A deposit of $500 changed the conversation.'],
    ['money', 'They asked for fifty thousand in seed money.'],
    ['money', 'Usage grew by forty percent.'],
    ['date', 'The pilot started in March.'],
    ['date', 'It ended on Friday.'],
    ['date', 'Results came back in 2026.'],
    ['date', 'Launch was planned for early May.'],
    ['proper_noun', 'They partnered with a team at Stanford on this.'],
    ['proper_noun', 'The buyer at Kaiser asked for references.'],
    ['proper_noun', 'They used the UCLA lab for testing.'],
    ['proper_noun', 'Every student had an iPhone app installed.'],
    ['proper_noun', 'Stanford asked for a security review before any pilot.'],
    ['proper_noun', 'Boston buyers wanted a pilot first.'],
    ['proper_noun', 'Kaiser asked for references.'],
    ['number', 'A founder sold to forty clinics before raising.'],
    ['number', 'Twenty-five students signed up in the first week.'],
    ['number', 'They ran a dozen pilots.'],
    ['number', 'Seven of the buyers asked for a discount.'],
    ['place', 'A founder sold to clinics in the northeast.'],
    ['place', 'Buyers on the West Coast moved faster.'],
    ['place', 'Midwestern hospitals asked for references.'],
  ])('rejects %s: %s', (reason, text) => {
    const result = checkDeidentified([GOOD[0] ?? '', text], CTX, { titleIndex: 0 });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it.each([
    "Don't ask what people would pay; ask for a deposit.",
    'One or two interviews are enough to start; the last one matters most.',
    'Scope the first claim before building.',
    'Workarounds tell you more than competitors do.',
    'Stakeholders often disagree about who owns the budget.',
    'North Star metrics help a team agree on one number.',
    'Pricing came up late. The founder moved pricing to the first call.',
  ])('accepts everyday words at the start of a sentence: %s', (text) => {
    expect(checkDeidentified([GOOD[0] ?? '', text], CTX, { titleIndex: 0 })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it.each([
    'Parents',
    'Nurses',
    'Doctors',
    'Clinicians',
    'Physicians',
    'Homeowners',
    'Installers',
    'Batteries',
    'Sensors',
    'Panels',
    'Landlords',
    'Tenants',
    'Employees',
    'Executives',
    'Shoppers',
    'Retailers',
    'Margins',
    'Deposits',
    'Referrals',
    'Waitlists',
    'Workshops',
    'Hiring',
    'Shipping',
    'Caregivers',
    'Warranties',
    'Prioritising',
  ])('accepts an everyday noun or verb that opens a sentence: %s', (word) => {
    const text = `${word} matter more than founders expect.`;
    expect(checkDeidentified([GOOD[0] ?? '', text], CTX, { titleIndex: 0 })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it.each([
    [['The buyer at Kaiser asked for references before kaiser agreed to a pilot.']],
    [['They used the UCLA lab for testing; the ucla staff were helpful.']],
    [['Stanford asked for a security review.', 'The founder sent the review to stanford the next day.']],
    [['Mayo wanted a pilot before any purchase order.']],
    [['Providence asked for outcome data first.']],
  ])('never lets a lower-case mention or a word-like name launder a proper noun: %j', (fields) => {
    const result = checkDeidentified([GOOD[0] ?? '', ...fields], CTX, { titleIndex: 0 });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('proper_noun');
  });

  it('knows everyday English words but not names or organisations', () => {
    for (const word of ['nurse', 'battery', 'landlord', 'deposit', 'hire'])
      expect(isEnglishWord(word)).toBe(true);
    for (const word of ['stanford', 'boston', 'kaiser', 'mayo', 'providence', 'oxford']) {
      expect(isEnglishWord(word)).toBe(false);
    }
  });

  it.each(Object.entries(TOPICS))('accepts the mock model lesson for %s', (_topic, bank) => {
    const lesson = bank.lesson;
    const fields = [
      lesson.title,
      lesson.context,
      lesson.signal,
      lesson.intervention,
      lesson.outcome,
      lesson.limits,
    ];
    expect(checkDeidentified(fields, CTX, { titleIndex: 0 })).toEqual({ ok: true, reasons: [] });
  });

  it('checks proper nouns in a sentence-case title but not the capitals of a Title Case one', () => {
    expect(
      checkDeidentified(['Lessons from the pilot with Northwind'], CTX, { titleIndex: 0 }).reasons,
    ).toContain('proper_noun');
    expect(checkDeidentified(['Lessons From The First Pilot'], CTX, { titleIndex: 0 }).ok).toBe(true);
    // Acronyms that are not generic still count, even in a Title Case title.
    expect(checkDeidentified(['Lessons From The MIT Pilot'], CTX, { titleIndex: 0 }).reasons).toContain(
      'proper_noun',
    );
  });

  it('reports codes only, sorted and without duplicates', () => {
    const result = checkDeidentified(['Maya paid $5 to Maya on 2026-10-10 at QuietQuad'], CTX);
    expect(result.reasons).toEqual(['date', 'money', 'number', 'person_name', 'proper_noun', 'venture_name']);
    for (const reason of result.reasons) expect(reason).toMatch(/^[a-z_]+$/);
  });

  it('ignores single common words inside multi-word names', () => {
    const ctx: LessonDeidentifyContext = {
      ventureNames: ['Green Field Labs'],
      personNames: [],
      canaries: [],
    };
    // "green" and "field" are common words; only the whole name and its distinctive parts are guarded.
    expect(checkDeidentified(['The founder chose a green field approach.'], ctx).ok).toBe(true);
    expect(checkDeidentified(['The team at green field labs tested it.'], ctx).reasons).toContain(
      'venture_name',
    );
  });
});
