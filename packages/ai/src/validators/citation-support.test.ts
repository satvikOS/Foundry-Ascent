import { describe, expect, it } from 'vitest';

import { guidanceText } from '../prompts/guidance.js';
import { SERVICE_OR_PRODUCT, TODAY } from '../testing/path-fixtures.js';
import {
  buildSupportIndex,
  checkCitationSupport,
  supportUnit,
  type SupportFinding,
} from './citation-support.js';

/** Synthetic sources, as a turn would show them. */
const EVIDENCE = [
  {
    key: 'E1',
    title: 'Problem interviews (programme unit 2)',
    excerpt:
      'Interview people about the last time the problem happened. Ask what they did, what it cost and who else was involved. Do fifteen interviews before you build. Avoid pitching and avoid hypothetical questions.',
  },
  {
    key: 'E2',
    title: 'BenchTally pilots',
    excerpt:
      'Two labs pay $40 per lab per month since October 12, 2026. 1,400 items are tracked in spreadsheets today. Dr. Okafor runs the Hartwell lab and approved the first pilot. She said "we lose a day every audit".',
  },
  {
    key: 'E3',
    title: 'Small Business Innovation Research (SBIR), U.S. government',
    excerpt:
      'The SBIR program funds small businesses in phases. Phase I awards support feasibility work and the company keeps its equity. Applications go through the agency that funds the topic.',
  },
  {
    key: 'E4',
    title: 'Inventions and the technology transfer office',
    excerpt:
      'Inventions made with university resources must be disclosed to the technology transfer office before they are published. Under the Bayh-Dole Act, universities may keep title to inventions made with federal funding.',
  },
  {
    key: 'E5',
    title: 'Pricing a first pilot',
    excerpt:
      'Charge something from the first pilot. A price close to what the workaround costs today is easier to defend. Record who approved the payment and from which budget. As Rob Fitzpatrick writes in The Mom Test, compliments are not commitments.',
  },
];
const FOUNDER =
  'I charge 40 dollars a month to two labs and sold 3 workshop seats at $25 each. I have 6 hours a week and a pitch on December 4 at the Simon Pitch Night. My cousin Dana works at Carta. About 12 of 30 people I asked said yes.';
const index = buildSupportIndex({
  evidence: EVIDENCE,
  founderText: FOUNDER,
  guidanceText: guidanceText(SERVICE_OR_PRODUCT, TODAY),
  alsoKnown:
    'Thomas. BenchTally. Ain Center. Assigned EIR. Program lead. University technology transfer office. Campus venture legal clinic.',
});

const unit = (text: string) => supportUnit(text, index);

describe('golden: a supported citation stays', () => {
  it.each([
    'Ask about the last time the problem happened, not what they would do [E1].',
    'Do fifteen interviews before you build anything [E1].',
    'Run 15 problem interviews first [E1].',
    'Skip hypothetical questions and never pitch while you interview [E1].',
    'Find out what it cost them and who else was involved [E1].',
    'Two labs already pay you $40 a month [E2].',
    'Your labs track 1,400 items in spreadsheets today [E2].',
    'Dr. Okafor approved the first pilot at the Hartwell lab [E2].',
    'The pilots have been paid since October 12 [E2].',
    'The lab told you "we lose a day every audit" [E2].',
    'At $40 for two labs that is $80 a month [E2].',
    'The SBIR program funds feasibility work in Phase I, and you keep your equity [E3].',
    'SBIR applications go through the agency that funds your topic [E3].',
    'Disclose the invention to the technology transfer office before you publish it [E4].',
    'Under the Bayh-Dole Act, universities may keep title to inventions made with federal funding [E4].',
    'Charge something from the very first pilot [E5].',
    'Price it close to what the workaround costs them today [E5].',
    'Write down who approved the payment and which budget it came from [E5].',
    'Rob Fitzpatrick writes that compliments are not commitments [E5].',
    'Interview them about the last time it happened, then charge for the first pilot [E1, E5].',
    'Ask what an LOI or MVP cost them the last time the problem happened [E1].',
    '1. Ask what they did the last time the problem happened [E1].',
    '- Record which budget approved the payment [E5].',
  ])('%s', (sentence) => {
    expect(unit(sentence)).toEqual({ text: sentence, findings: [], keysDropped: 0 });
  });
});

describe('golden: an unsupported citation loses its marker, and the advice stands', () => {
  it.each([
    ['Post on Instagram twice a day [E1].', 'Post on Instagram twice a day.'],
    ['Investors care about your team above all [E2].', 'Investors care about your team above all.'],
    ['Hire a designer before you raise money [E5].', 'Hire a designer before you raise money.'],
    ['Do fifty interviews before you build [E1].', 'Do fifty interviews before you build.'],
    [
      'Your labs track 2,400 items in spreadsheets today [E2].',
      'Your labs track 2,400 items in spreadsheets today.',
    ],
    ['The pilots have been paid since October 21 [E2].', 'The pilots have been paid since October 21.'],
    ['The Merriweather lab approved the first pilot [E2].', 'The Merriweather lab approved the first pilot.'],
    [
      'The lab told you "we waste a week on paperwork" about every audit [E2].',
      'The lab told you "we waste a week on paperwork" about every audit.',
    ],
    ['Equity splits should vest over time [E3].', 'Equity splits should vest over time.'],
    ['File early so that your brand is protected [E4].', 'File early so that your brand is protected.'],
    ['Charge something from the first pilot [E9].', 'Charge something from the first pilot.'],
    [
      'Ask about the last time the problem happened [E1, E3].',
      'Ask about the last time the problem happened [E1].',
    ],
    ['Charge something from the first pilot [E3, E5].', 'Charge something from the first pilot [E5].'],
  ])('%s', (sentence, expected) => {
    const out = unit(sentence);
    expect(out.text).toBe(expected);
    expect(out.keysDropped).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.startsWith('citation_'))).toBe(true);
  });
});

describe('golden: advice and grounded statements are never touched', () => {
  it.each([
    'Start with the lab managers: they pay, the students only use it.',
    'Both, in this order: a paid service by hand for three companies, then software.',
    'You have 6 hours a week, so book two calls and stop there.',
    'At $25 a seat, 3 seats made you $75.',
    'You asked 30 people and 12 said yes, which is 40%.',
    'Two labs at $40 is $80 a month, or $960 a year.',
    'Your cousin Dana at Carta can look at the cap table with you.',
    'Your pitch at the Simon Pitch Night is December 4.',
    'Next: list 20 office managers who run admin by hand and message 5 of them by Thursday.',
    'Done when you have 20 names written down and two calls booked.',
    'See the university technology transfer office before you share it.',
    'The campus venture legal clinic can read the contract with you.',
    'Your program lead can open a separate workspace.',
    'Write to them: "Hi Dr. Lee, could I watch you do the stock count once?"',
    'Use a form or a spreadsheet; the tool does not matter yet.',
    'A customer segment is a group of people with the same problem.',
    'If three of them ask for the same thing, build that.',
    'Talk to five of them this week and write down what they did, not what they think.',
    'My read: the weakest point is that nobody has paid for the second version.',
    'Friends who love it are not evidence; a deposit is.',
    'The University may own part of it until you know.',
    'Ask Professor, dean or lab manager: whoever signs the order.',
    'Business Model Canvas boxes are guesses until someone pays.',
    'In two weeks you will know which of the two to drop.',
    'Call the office on Monday and again on Wednesday.',
    'You may be early, and that is fine.',
    'The Mom Test is worth an evening: compliments are not commitments.',
    'Rob Fitzpatrick calls compliments a trap.',
    'The Bayh-Dole Act is why the university may keep title.',
    'SBIR keeps your equity with you.',
    'Section 2 of your deck should show the pilot.',
    'Raise a Series A only once two labs renew.',
    'Customer Discovery teaches you what they did, not what they think.',
    'Have it ready by Thanksgiving Break.',
    'You can never be 100% sure, so test the price.',
    'Your Pitch Workshop slot is yours to use.',
    'Next Program: none until the first deposit.',
    'An MVP or LOI proves less than a paid invoice.',
  ])('%s', (sentence) => {
    expect(unit(sentence)).toEqual({ text: sentence, findings: [], keysDropped: 0 });
  });
});

describe('golden: a claim nobody gave is neutralised, or the sentence goes', () => {
  it.each<readonly [string, string, SupportFinding]>([
    ['The market is worth $12 billion.', '', 'figure_unsupported'],
    ['About 70% of startups fail at this stage.', '', 'figure_unsupported'],
    ['9 out of 10 founders skip this.', '', 'figure_unsupported'],
    ['Interview-led teams are 3x more likely to raise.', '', 'figure_unsupported'],
    [
      'Offer them a $10 gift card for the call.',
      'Offer them a gift card for the call.',
      'figure_unsupported',
    ],
    [
      'Sell it to small clinics, which spend about $3,000 a year on this.',
      'Sell it to small clinics.',
      'figure_unsupported',
    ],
    ['Apply to the Tiger Launch Accelerator this spring.', '', 'program_unsupported'],
    [
      'Look for grants, such as the Thiel Fellowship or Techstars.',
      'Look for grants.',
      'program_unsupported',
    ],
    [
      'Talk to your professor this week, and apply to Y Combinator.',
      'Talk to your professor this week.',
      'program_unsupported',
    ],
    [
      'Join a student program (Dorm Room Fund is one) when you have revenue.',
      'Join a student program when you have revenue.',
      'program_unsupported',
    ],
    ['I-Corps will pay for your interviews.', '', 'program_unsupported'],
    [
      'As Steve Blank says, get out of the building this week.',
      'Get out of the building this week.',
      'person_unsupported',
    ],
    [
      'According to Dr. Henrik Vance, pilots stall without a champion.',
      'Pilots stall without a champion.',
      'person_unsupported',
    ],
    ['Paul Graham wrote that you should do things that do not scale.', '', 'person_unsupported'],
    ['Read it in the book "Zero Friction Selling" tonight.', '', 'work_unsupported'],
    ['Crossing the Chasm explains this well.', '', 'work_unsupported'],
    ['Section 409A sets the price of your options.', '', 'law_unsupported'],
    ['You will need to comply with HIPAA before the pilot.', '', 'law_unsupported'],
    ['The JOBS Act lets you raise from the crowd.', '', 'law_unsupported'],
    [
      'Keep records of the test, because 21 CFR 820 asks for them.',
      'Keep records of the test.',
      'law_unsupported',
    ],
    ['Airbnb sold cereal boxes to survive.', '', 'story_unsupported'],
    ['Start by hand, like Zappos did with its first shoes.', 'Start by hand.', 'story_unsupported'],
    ['The deadline for the grant is March 3.', '', 'deadline_unsupported'],
    ['Applications close on January 15, 2027.', '', 'deadline_unsupported'],
    ['File an 83(b) within the month.', '', 'law_unsupported'],
  ])('%s', (sentence, expected, finding) => {
    const out = unit(sentence);
    expect(out.text).toBe(expected);
    expect(out.findings).toContain(finding);
  });
});

describe('what may be stated follows what was given', () => {
  it('a program, person, law or date given in the evidence or by the founder stands', () => {
    const more = buildSupportIndex({
      evidence: [
        {
          key: 'E1',
          title: 'Tiger Launch Accelerator',
          excerpt: 'Applications close on January 15. Steve Blank speaks. HIPAA applies to patient data.',
        },
      ],
      founderText: 'I got into Techstars. Our market is $12 billion by the report I have.',
    });
    for (const sentence of [
      'Apply to the Tiger Launch Accelerator before applications close on January 15 [E1].',
      'Steve Blank says to get out of the building.',
      'HIPAA applies to patient data [E1].',
      'Techstars will ask about this too.',
      'The $12 billion is not your market: the two labs are.',
    ]) {
      expect(supportUnit(sentence, more).text).toBe(sentence);
    }
  });

  it('a reasoned range is the answer when they asked for a number', () => {
    const asked = buildSupportIndex({
      evidence: [],
      founderText: 'How much should I charge?',
      askedNumber: true,
    });
    expect(supportUnit('Charge $30 to $50 a month for the first pilot.', asked).text).toBe(
      'Charge $30 to $50 a month for the first pilot.',
    );
  });

  it('the path’s own words count as the sources its answer cites', () => {
    const sentence = 'Do it by hand as a paid service for three companies first [E7].';
    const evidence = [{ key: 'E7', title: 'Method', excerpt: 'Concierge delivery precedes tooling.' }];
    const without = buildSupportIndex({ evidence, founderText: '' });
    expect(supportUnit(sentence, without).text).toBe(
      'Do it by hand as a paid service for three companies first.',
    );
    const ask = SERVICE_OR_PRODUCT.ask;
    const withPath = buildSupportIndex({
      evidence,
      founderText: '',
      pathSources: { keys: ['E7'], text: `${ask?.answer ?? ''} ${ask?.why ?? ''}` },
    });
    expect(supportUnit(sentence, withPath).text).toBe(sentence);
  });

  it('a safety line and what the server wrote are never removed', () => {
    const line = 'In the US you can call or text 988, the Suicide & Crisis Lifeline.';
    expect(unit(line).text).toBe(line);
    expect(supportUnit('Apply to the Tiger Launch Accelerator.', index, { protect: true }).text).toBe(
      'Apply to the Tiger Launch Accelerator.',
    );
  });
});

describe('a whole reply', () => {
  it('keeps paragraphs and lists, renumbers a list that lost an item, and counts what it did', () => {
    const out = checkCitationSupport(
      [
        'Charge for the first pilot [E5]. The market is worth $12 billion.',
        '',
        '1. Ask about the last time the problem happened [E1].',
        '2. Apply to the Tiger Launch Accelerator.',
        '3. Record who approved the payment [E3].',
        '',
        'Next: list 20 office managers by Thursday.',
      ].join('\n'),
      index,
    );
    expect(out.text).toBe(
      [
        'Charge for the first pilot [E5].',
        '',
        '1. Ask about the last time the problem happened [E1].',
        '2. Record who approved the payment.',
        '',
        'Next: list 20 office managers by Thursday.',
      ].join('\n'),
    );
    expect(out).toMatchObject({ citationsDropped: 1, sentencesRemoved: 2, sentencesNeutralised: 0 });
    expect(out.findings).toEqual(
      expect.arrayContaining(['figure_unsupported', 'program_unsupported', 'citation_unsupported']),
    );
  });

  it('changes nothing in a grounded reply', () => {
    const reply =
      'Both, in order: a paid service by hand first, then software. You already have two labs at $40 a month [E2], so you know someone pays.\n\n1. Ask what they did the last time the problem happened [E1].\n2. Charge something from the first pilot [E5].\n\nNext: list 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names and two calls booked.';
    expect(checkCitationSupport(reply, index)).toEqual({
      text: reply,
      findings: [],
      citationsDropped: 0,
      sentencesRemoved: 0,
      sentencesNeutralised: 0,
    });
  });

  it('is linear on a long reply', () => {
    const long = 'Ask what they did the last time the problem happened [E1]. '.repeat(300);
    const started = performance.now();
    checkCitationSupport(long, index);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
