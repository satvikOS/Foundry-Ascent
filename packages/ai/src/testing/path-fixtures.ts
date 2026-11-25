import type { PromptGuidance } from '../prompts/guidance.js';

/** Synthetic path decisions for tests of the prompt, the reply contract and the mock: no real venture or student. */

export const TODAY = '2026-11-24'; // a Tuesday

/** The open step of most fixtures. */
export const STEP: NonNullable<PromptGuidance['step']> = {
  title: 'List 20 office managers who run admin by hand and message 5 of them',
  items: [
    {
      do: 'Write 20 names from your network and campus offices',
      how: 'One line each: name, role, how you know them',
      minutes: 40,
    },
    {
      do: 'Message five of them with the short note',
      how: 'Use the template, change the first line',
      minutes: 30,
    },
    { do: 'Book two 20-minute calls', how: 'Offer two times this week', minutes: 15 },
  ],
  doneWhen: 'You have 20 names written down and two calls booked',
  dueOn: '2026-11-26',
  template: {
    title: 'Short note',
    body: 'Hi [name], I am a student looking at how offices handle [task].\nCould I watch you do it once, 20 minutes?',
  },
};

/** "Service, software, or both?" from a first-time student founder. */
export const SERVICE_OR_PRODUCT: PromptGuidance = {
  kind: 'coaching',
  brief:
    'Priya, second-year mechanical engineering student, first venture, about 6 hours a week. Venture BenchTally: shared lab equipment tracking; 2 paid pilots at $40 per lab per month since October 12. Decided October 20 to sell to lab managers, not students.',
  stage: { title: 'Discovery: find who has the problem', number: 2, count: 7 },
  firstTime: true,
  ask: {
    title: 'Service, software, or both?',
    answer:
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code.',
    why: 'Building software for a workflow you have not watched is how teams ship what nobody uses; a paid service is the cheapest way to watch it.',
    traps: ['Custom work for each company with nothing repeated'],
    evidenceKeys: ['E1'],
  },
  step: STEP,
  then: ['Watch three of them do the task', 'Offer to do it for one of them for a fee'],
  checkIn: null,
  referral: null,
  newIdea: null,
};

/** No ask the playbook covers: only the open step. */
export const STEP_ONLY: PromptGuidance = { ...SERVICE_OR_PRODUCT, ask: null };

/** "I came up with part of this in a university lab. Who owns it?" */
export const IP_REFERRAL: PromptGuidance = {
  ...SERVICE_OR_PRODUCT,
  ask: {
    title: 'Who owns an idea that started in a university lab?',
    answer:
      'Assume the university may own part of it until its technology transfer office says otherwise, and do not share or sell it as yours yet. Ownership usually turns on who paid for the work, whose equipment you used and what you signed.',
    why: 'Investors check ownership first, and a late surprise can end a deal.',
    traps: [],
    evidenceKeys: [],
  },
  step: {
    title: 'Write a one-page invention history and book the technology transfer office',
    items: [
      { do: 'List dates, people, funding and equipment used', how: 'From your lab notebook', minutes: 45 },
      {
        do: 'Email the technology transfer office for a 20-minute meeting',
        how: 'Attach the page',
        minutes: 10,
      },
    ],
    doneWhen: 'The page is written and the meeting has a date',
    dueOn: '2026-11-30',
    template: null,
  },
  referral: {
    who: 'The university technology transfer office, and a lawyer before you sign anything',
    bring: 'The invention history page, the lab agreement and any grant terms',
  },
};

/** A report on the step they were on. */
export const REPORT: PromptGuidance = {
  ...STEP_ONLY,
  kind: 'report',
  checkIn: { title: 'Email the theatre society', dueOn: '2026-11-18', overdue: true },
};

/** An idea the venture's record does not hold. */
export const NEW_IDEA: PromptGuidance = {
  ...SERVICE_OR_PRODUCT,
  kind: 'new_idea',
  newIdea: { ventureName: 'BenchTally', fact: '2 paid pilots at $40 per lab per month' },
};

export const SOCIAL: PromptGuidance = { ...STEP_ONLY, kind: 'social' };
export const REHEARSAL: PromptGuidance = { ...STEP_ONLY, kind: 'rehearsal' };
export const RECALL: PromptGuidance = { ...STEP_ONLY, kind: 'recall' };
