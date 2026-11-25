import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const TRANSITION_PLAYS: readonly Play[] = [
  {
    id: 'leaving-ain',
    title: 'Check if you are ready to leave the Ain Center',
    stage: 'transition',
    intents: ['leaving-ain'],
    criteria: ['transition-ready'],
    answer:
      'You are ready when six lines have evidence. Strangers pay. They come back. One sale leaves money. One channel works. The team has written roles. You know who owns what. With four or more, look for the next place now. With fewer, stay this term and close the gap, because help is near. Your biggest gap picks the place. Space and peers means an incubator. Speed means an accelerator. Science means a grant. Otherwise, just sell. Make the final call with your EIR and the program lead.',
    why: 'Leaving early costs you support while you still need it. Leaving late costs you a term. Six lines make it a check and not a mood.',
    steps: [
      step('Fill the six lines with a number, a name or a date', 'Blank means no.', 30),
      step(
        'Ask one customer and one mentor what would worry them if you left',
        'Write it without defending yourself.',
        40,
      ),
      step('Match the biggest gap to the next home', 'Space, speed, science, sales or a job first.', 20),
      step(
        'Book the exit talk with your EIR and the program lead',
        'Bring the six lines and your first choice.',
        45,
      ),
    ],
    doneWhen: 'Six lines are filled, and the exit talk with your EIR and the program lead has happened.',
    days: 10,
    template: {
      title: 'Six lines',
      body: '1 Strangers pay: [count] in the last 4 weeks\n2 They come back: [count] of [count] after 4 weeks\n3 One sale leaves: [amount], measured on [date]\n4 One channel works: [channel], [hours] per customer\n5 Roles are written: [link], agreed by [names]\n6 We know who owns what: [University work? papers?]\nProof on: [number] of 6\nBiggest gap: [ ]  Next home that closes it: [ ]\nTalk on: [date] with [EIR] and [program lead]',
    },
    traps: ['Leaving because a deadline appeared, not because you are ready.'],
    referral: REFERRALS.programLead(
      'The six lines with evidence, what worries a customer and a mentor, and your first choice for the next home.',
    ),
    citations: [
      cite('ain-eir'),
      cite('openstax-entrepreneurship', '15.1 Launching Your Venture'),
      cite('ain-curriculum', 'Roadmap: from student to mentor'),
    ],
    next: ['next-home', 'after-graduation', 'student-to-mentor'],
  },
  {
    id: 'next-home',
    title: 'Choose an incubator, accelerator or neither',
    stage: 'transition',
    intents: ['next-home'],
    criteria: ['transition-next-home'],
    answer:
      'Choose by your biggest gap, and compare three real options, one of which is neither. An incubator gives space and time, so it suits work that needs a lab or a desk. An accelerator gives a short push and a deadline, often for shares, so it suits a venture that already sells. Neither suits one that needs only customers. Ask each for two past founders and call them before you apply. If one takes shares, have a lawyer and your EIR read the terms first.',
    why: 'Names impress, and fit helps. The past founders will tell you in ten minutes what the website does not.',
    steps: [
      step('Write your biggest gap and what would close it in 3 months', 'One line each.', 15),
      step(
        'Fill the table for 3 options, with neither as one',
        'What it gives, what it takes, where, when, who is in it.',
        60,
      ),
      step(
        'Call 2 past founders of each',
        'What did you get that you could not get elsewhere? What did it cost you?',
        90,
      ),
      step(
        'Choose one and send the application or the introduction request',
        'Before the deadline, with your six lines attached.',
        120,
      ),
    ],
    doneWhen:
      'Three options are compared, 2 past founders have been called, and one application or ask is sent.',
    days: 21,
    template: {
      title: 'Next home',
      body: 'Gap: [ ]  Closed if: [ ] in 3 months\nOption | Gives | Takes (shares, money, time) | Where | Deadline | Founders I called say\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ]\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nNeither: customers first | [ ] | [ ] | [ ] | [ ] | [ ]\nChosen: [ ], because [ ]. Sent on [date]',
    },
    traps: ['Applying to ten and preparing for none.', 'Signing standard terms unread.'],
    referral: REFERRALS.eir(
      'Your six lines, the three options and any terms that ask for shares, fees or rights.',
    ),
    citations: [
      cite('openstax-entrepreneurship', '15.3 Seeking Help or Support'),
      cite('ain-curriculum', 'Module 3: Innovation Incubators and VC Opportunities'),
    ],
    next: ['leaving-ain', 'term-sheet', 'after-graduation'],
  },
  {
    id: 'after-graduation',
    title: 'Keep the venture going after graduation',
    stage: 'transition',
    intents: ['after-graduation'],
    criteria: ['transition-handover'],
    answer:
      'Write a one-page handover now, even if you stay. Who does what after the last exam, what the venture owns, what it owes, which accounts use a school email, and the next 90 days. Then choose one of three: full time, part time with a job, or hand it over. Full time needs customers and months of living costs. Part time needs fixed hours and one number to keep up. Handing over needs a named person by a date. A visa can decide this for you, so ask early.',
    why: 'Ventures often stop at graduation because nobody wrote who keeps what. One page prevents that and shows you what is missing.',
    steps: [
      step('Fill the one-page handover with the team', 'Open each account and write who can log in.', 60),
      step(
        'Work out your months: savings plus venture cash, divided by living costs',
        'Use your own bank figures.',
        20,
      ),
      step(
        'Choose full time, part time or hand over, with a date',
        'Tell customers what changes for them.',
        30,
      ),
      step(
        'Move what depends on the University',
        'Emails, licenses, lab access, course projects. Ask about visas and ownership first.',
        90,
      ),
    ],
    doneWhen:
      'The one-page handover is filled, one of the three is chosen with a date, and customers are told.',
    days: 14,
    template: {
      title: 'Handover page',
      body: 'After [date]: [name] does [ ], [hours]; [name] does [ ], [hours]\nOwned: [name, domain, code, designs, stock, data]. Held by: [ ]\nOwed: [money, orders, promises]. To: [ ] by [ ]\nAccounts on school email: [list], moved by [date]\nUniversity things: [lab, software, class work, IP question to UR Ventures]\nMonths I can go: ([savings] + [venture cash]) / [living costs] = [ ]\nChosen: full time / part time / hand over to [name]\nNext 90 days: 1 [ ] 2 [ ] 3 [ ]',
    },
    traps: ["Finding out in June that the domain was a teammate's."],
    referral: null,
    citations: [
      cite('founders-dilemmas', 'Career Dilemmas'),
      cite('openstax-entrepreneurship', '15.2 Making Difficult Business Decisions in Response to Challenges'),
      ain(AIN.mindset2),
    ],
    next: ['runway', 'job-or-startup', 'international-student'],
  },
  {
    id: 'quit-or-continue',
    title: 'Decide to stop, pause or continue',
    stage: 'transition',
    intents: ['quit-or-continue'],
    criteria: ['validation-decision'],
    answer:
      'Stop if two tests in a row missed lines you set yourself, and you cannot name a change you believe in. Pause if life needs the time, and write the date you look again. Continue if strangers still pay and you can say what the next test is. Deciding to stop on evidence is good work, not failure. Before you decide, sleep one night and tell one mentor. If you feel hopeless about more than the venture, talk to the Counseling Center today. The venture can wait.',
    why: 'Founders stop too early on a bad day and too late after a bad year. Lines you set earlier take the mood out of it.',
    steps: [
      step(
        'List your last tests with line and result',
        'If there were no lines, set one now and run one last test.',
        20,
      ),
      step('Write what you would do differently, or that you do not know', 'One honest sentence.', 10),
      step('Talk to one mentor and one person who loves you', 'One about the venture, one about you.', 60),
      step(
        'Decide and close cleanly: refunds, promises, accounts, thanks',
        'Write what you learned in half a page.',
        90,
      ),
    ],
    doneWhen: 'The decision is written with the evidence, and every open promise has an owner or an end.',
    days: 7,
    template: {
      title: 'Stop, pause, continue',
      body: 'Last tests: belief | line | result\n[ ] | [ ] | [ ]\nA change I believe in: [ ] / none\nDecision on [date]: stop / pause until [date] / continue with test [ ]\nTo close: refunds [ ], orders [ ], accounts [ ], team [ ], thanks [ ]\nWhat I learned: about customers [ ], about me [ ], what I would test first next time [ ]',
    },
    traps: ['Letting it fade without telling customers or teammates.'],
    referral: null,
    citations: [
      cite('lean-startup', 'Ch. 8, Pivot (or Persevere)'),
      cite('openstax-entrepreneurship', '10.2 Why Early Failure Can Lead to Success Later'),
      cite('ur-counseling'),
    ],
    next: ['pivot-or-persevere', 'stuck', 'student-to-mentor'],
  },
  {
    id: 'student-to-mentor',
    title: 'Mentor the next student founders',
    stage: 'transition',
    intents: ['student-to-mentor'],
    criteria: ['transition-handover'],
    answer:
      'Yes, and start small. Offer one hour a month to one student team, on the part you learned the hard way. Tell the program lead which part that is. Share what you did and what happened, not what they must do, and ask for a report back. Joining the Foundry Alumni Network also keeps your door open here. You will meet people you may hire, sell to or learn from.',
    why: 'The programme ends with the step from student to mentor. Teaching one part well also shows you what you know.',
    steps: [
      step(
        'Write the one thing you can teach from experience',
        'For example first sales, finding a lab partner or stopping well.',
        15,
      ),
      step(
        'Tell the program lead and ask about the alumni network',
        'Two lines on you, and when you are free.',
        10,
      ),
      step('Meet one team for an hour', 'Ask for their one page and one decision the day before.', 60),
    ],
    doneWhen: 'The program lead has your offer, and one first session with a team is in the calendar.',
    days: 14,
    template: {
      title: 'Offer to mentor',
      body: 'Hello [program lead], I finished the Foundry in [term] with [venture]. I learned [one thing] the hard way: [one line]. I can give one hour a month to one team on that. May I join the Foundry Alumni Network, and is there a team it would help?\n[name]',
    },
    traps: ['Telling teams to do what worked for you, without asking what they know.'],
    referral: null,
    citations: [
      cite('ain-curriculum', 'Roadmap: from student to mentor'),
      cite('ain-mentors'),
      cite('openstax-entrepreneurship', '15.4 Now What? Serving as a Mentor, Consultant, or Champion'),
    ],
    next: ['leaving-ain', 'networking', 'after-graduation'],
  },
];
