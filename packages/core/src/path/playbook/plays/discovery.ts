import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const DISCOVERY_PLAYS: readonly Play[] = [
  {
    id: 'find-ten-people',
    title: 'Find your customer and 10 of them this month',
    stage: 'discovery',
    intents: ['find-ten-people'],
    criteria: ['discovery-ten-conversations', 'discovery-first-group'],
    answer:
      'Your first customer is the person who had the problem in the last month and tried to fix it. Not everyone, and not all students. Describe that one person, then go where they were when it happened. Aim for 10 talks this month. List 30 names, because many will not answer. Ask each person for two more names, and the second half of the list fills itself.',
    why: 'People who already tried to fix it are easy to spot and worth listening to. They can also tell you what they paid.',
    steps: [
      step(
        'Describe one person: who, where, when it last happened, what they tried',
        'If you can picture where they stand when it happens, it is narrow enough.',
        15,
      ),
      step(
        'List 30 people or places',
        'Clubs, classes, jobs, online groups, the place where the problem happens. At most 3 friends.',
        45,
      ),
      step(
        'Send 10 short messages and go to 2 places in person',
        'Ask for 15 minutes about how they handle it. Say you are learning, and that nothing is for sale.',
        90,
      ),
      step(
        'Hold the talks, and ask each person who else you should talk to',
        'Write two names before you leave. Message them the same day.',
        240,
      ),
    ],
    doneWhen:
      '10 people who had the problem in the last month have talked with you, at most 3 of them friends.',
    days: 28,
    template: {
      title: 'Message to ask for 15 minutes',
      body: 'Hi [name], I am a student at [school] looking into how people deal with [problem]. I saw that you [reason I chose them]. Could I ask you about the last time it happened? It takes 15 minutes, and I am not selling anything. Would [day] or [day] work?\n[your name]',
    },
    traps: [
      'Describing your idea in the message. People then judge the idea instead of telling you their story.',
      'Posting one survey to a big group and calling it talks.',
    ],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 6, Finding Conversations'),
      cite('disciplined-entrepreneurship', 'Step 9 (your next 10 customers)'),
      ain(AIN.networking2),
    ],
    next: ['interview-script', 'cold-outreach', 'beachhead'],
  },
  {
    id: 'interview-script',
    title: 'Run a problem interview',
    stage: 'discovery',
    intents: ['interview-script'],
    criteria: ['discovery-ten-conversations'],
    answer:
      'Ask about the last time, not about your idea. Five questions are enough. Tell me about the last time this happened. What did you do? What was hard about it? What did it cost you in time or money? What else have you tried? Then be quiet and write down their words. Do not mention your product until the end, if at all. Aim for 10 of these talks, 20 minutes each.',
    why: 'People are good at telling you what they did and poor at telling you what they would do. The last time is a fact.',
    steps: [
      step(
        'Write your five questions on one card',
        'Start from the template. Change only the problem in the first question.',
        15,
      ),
      step(
        'Practise once with a friend who plays a customer',
        'Practise staying silent for five seconds after an answer. The best part often comes next.',
        20,
      ),
      step(
        'Hold 3 talks this week',
        'Take notes by hand or ask before recording. Write exact words for anything strong.',
        90,
      ),
      step(
        'Write the notes within an hour of each talk',
        'Three lines: what happened, what they did, what surprised you.',
        30,
      ),
    ],
    doneWhen:
      'You have notes from the talks you planned, each about a real last time, with at least one exact quote.',
    days: 10,
    template: {
      title: 'Problem interview card',
      body: 'Start: "I am learning how people deal with [problem]. I am not selling anything. May I take notes?"\n1. Tell me about the last time [problem] happened.\n2. What did you do about it, step by step?\n3. What was the hardest part?\n4. What did it cost you: time, money, anything else?\n5. What else have you tried, and why did you stop?\nClose: "Who else should I talk to? May I come back when I have something to show?"',
    },
    traps: [
      'Saying: would you use an app that does this? Nearly everyone answers yes to be kind.',
      'Filling the silence with your idea.',
    ],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 1, The Mom Test'),
      cite('mom-test', 'Ch. 3, Asking Important Questions'),
      cite(
        'startup-owners-manual',
        'Ch. 5, Customer Discovery, Phase Two: "Get Out of the Building" to Test the Problem',
      ),
    ],
    next: ['interview-mistakes', 'interview-debrief', 'synthesize-interviews'],
  },
  {
    id: 'interview-mistakes',
    title: 'Fix the questions you ask in interviews',
    stage: 'discovery',
    intents: ['interview-mistakes'],
    criteria: ['discovery-ten-conversations'],
    answer:
      'Drop three kinds of question. Drop the ones about the future, such as: would you buy this? Drop the ones that ask for an opinion, such as: is it a good idea? Drop the ones that give the answer, such as: is it annoying when the line is long? Replace each with a question about the past. When did you last buy something for this? What happened next? If a question can be answered to please you, do not ask it.',
    why: 'Polite answers feel like progress and lead you to build the wrong thing. A question about the past leaves nothing to be polite about.',
    steps: [
      step(
        'Mark every question on your list: past, future or opinion',
        'Cross out the future and opinion ones.',
        10,
      ),
      step(
        'Rewrite each crossed-out question as a past one',
        'Would you pay for it becomes: what did you pay for it last time?',
        15,
      ),
      step(
        'Use the new list in your next 2 talks',
        'Notice where you slip and start to sell. Write the moment down.',
        40,
      ),
    ],
    doneWhen: 'Every question on your card is about something that already happened, and 2 talks used it.',
    days: 5,
    template: {
      title: 'Swap the question',
      body: 'Instead of | Ask\nWould you use this? | What do you use now, and when did you last use it?\nHow much would you pay? | What did you spend on this last time?\nIs this a problem for you? | What was the worst part of last week?\nDo you like my idea? | Who else did you ask for help with this?\nWould you recommend it? | Who have you told about it?\nMine: [my question] | [the same thing, asked about the last time]',
    },
    traps: ['Asking two questions at once. People answer the easier one.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 2, Avoiding Bad Data'),
      cite('mom-test', 'Ch. 4, Keeping It Casual'),
      ain(AIN.discovery),
    ],
    next: ['interview-script', 'fake-compliments', 'interview-debrief'],
  },
  {
    id: 'interview-debrief',
    title: 'Debrief after an interview',
    stage: 'discovery',
    intents: ['interview-debrief'],
    criteria: ['discovery-pattern'],
    answer:
      'Write three lines within an hour, while you still hear the person. What happened to them, in their words. What they did about it. What you got wrong. Then give it one mark: did they do something about this problem, or only complain? Only the ones who did something count as evidence. Change your next question list if two people in a row surprised you with the same thing.',
    why: 'Memory smooths a talk into what you hoped to hear. Three lines on the same day keep the facts.',
    steps: [
      step('Write the three lines and one exact quote', 'Do it before you talk to your team about it.', 10),
      step(
        'Mark the person: acted, complained or does not have it',
        'Acted means they spent money, time or asked for help.',
        5,
      ),
      step(
        'Send a thank you the same day',
        'Two sentences, and the names they offered if they forgot to send them.',
        10,
      ),
      step(
        'Change one question if two people surprised you',
        'Change one thing at a time, so you can still compare talks.',
        10,
      ),
    ],
    doneWhen: 'Each talk has three lines, one quote and one mark, and a thank you has been sent.',
    days: 2,
    template: {
      title: 'Interview debrief',
      body: 'Name and role: [ ]  Date: [ ]\nWhat happened the last time: [their words]\nWhat they did about it: [ ]\nQuote: "[ ]"\nMark: acted / complained / does not have it\nI was wrong about: [ ]\nNames they gave me: [ ], [ ]',
    },
    traps: ['Writing what you think they meant instead of what they said.'],
    referral: null,
    citations: [cite('mom-test', 'Ch. 8, Running the Process'), ain(AIN.networking2)],
    next: ['synthesize-interviews', 'interview-script', 'beachhead'],
  },
  {
    id: 'synthesize-interviews',
    title: 'Find the pattern across interviews',
    stage: 'discovery',
    intents: ['synthesize-interviews'],
    criteria: ['discovery-pattern', 'discovery-first-group'],
    answer:
      'Put all the talks in one table, one row per person, and count what people did, not what they said. If at least half of one group acted on the same problem, you have a pattern, and you build the offer for that group. If each person has a different problem, the group is too wide, so split it and do five more talks in the part that acted. If nobody acted, change the problem. Do not go on to build.',
    why: 'Ten separate stories are easy to bend to your plan. A table with one line per person shows what is really there.',
    steps: [
      step(
        'Make the table and fill one row per person',
        'Who, the last time, what they did, what it cost, the mark and one quote.',
        45,
      ),
      step(
        'Count the rows marked acted, by type of person',
        'Aim for a group where at least half acted.',
        10,
      ),
      step(
        'Write the pattern in one sentence with the count',
        'Say how many of how many, which kind of person, what they did and when.',
        10,
      ),
      step(
        'Decide: go on, narrow or change the problem',
        'Write the decision and the date. Tell your team or your EIR.',
        15,
      ),
    ],
    doneWhen:
      'One table holds every talk, the pattern is one sentence with a count, and the decision is written.',
    days: 5,
    template: {
      title: 'Interview table',
      body: 'Person | Type | Last time | What they did | What it cost | Acted? | Quote\n[ ] | [ ] | [ ] | [ ] | [ ] | [yes/no] | [ ]\nPattern: [count] of [count] [type] [did what] when [moment]\nDecision on [date]: go on / narrow to [group] / change the problem',
    },
    traps: [
      'Giving the loudest person more weight than the count.',
      'Adding friends back in when the number looks low.',
    ],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 8, Running the Process'),
      cite('testing-business-ideas', 'Section 2, Test: Learn'),
      cite('business-model-generation', 'Design: Customer Insights'),
    ],
    next: ['beachhead', 'value-proposition', 'persona'],
  },
  {
    id: 'fake-compliments',
    title: 'Tell real interest from kind words',
    stage: 'discovery',
    intents: ['fake-compliments'],
    criteria: ['validation-commitment'],
    answer:
      'Treat every kind word as zero until it costs the person something. I would definitely buy it is worth nothing. Here is my card, my Saturday or my boss is worth a lot. So the moment someone says they love it, ask for a small step right there. Pay for the first one, book a time to try it, or introduce you to the person who decides. If they will not take any step, put them down as a no.',
    why: 'People mean well and mispredict themselves. A step that costs them something separates interest from manners.',
    steps: [
      step(
        'Write three small steps you can ask for',
        'One with money, one with time, one with reputation, such as an introduction.',
        10,
      ),
      step('Go back to everyone who said they loved it', 'Ask for one of the three steps, with a date.', 60),
      step(
        'Recount your interest by what they did',
        'Money, time, introduction or nothing. Only the first three count.',
        10,
      ),
    ],
    doneWhen: 'Everyone who said yes was asked for a step, and the count of real steps is written down.',
    days: 5,
    template: {
      title: 'From kind word to step',
      body: '"Thank you. I am starting with [number] people on [date]. It is [price]. Can I put you down as one of them today?"\nIf not now: "What would have to be different?"\nIf not you: "Who should I ask instead, and would you introduce us?"\nCount: money [ ]  time [ ]  introduction [ ]  nothing [ ]',
    },
    traps: ['Hearing let me know when it launches as a yes. It is a polite no.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      ain(AIN.discovery),
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
    ],
    next: ['pre-sale', 'will-anyone-pay', 'interview-mistakes'],
  },
  {
    id: 'survey-or-talk',
    title: 'Hold talks before you send a survey',
    stage: 'discovery',
    intents: ['survey-or-talk'],
    criteria: ['discovery-ten-conversations'],
    answer:
      'Talk first, survey later. Ten talks tell you what the right questions are. A survey before that only counts answers to the wrong ones. Use a survey once you have heard the same thing from most of your talks and want to know how common it is. Then keep it under six questions, ask about the last time, and end by asking who would talk to you for 15 minutes.',
    why: 'A form cannot ask what happened next. The surprise that changes your plan usually comes in the second answer.',
    steps: [
      step(
        'Cancel or pause the survey and book 5 talks instead',
        'Ask the first people you would have sent it to.',
        30,
      ),
      step(
        'Write down the three answers you keep hearing',
        'These become the choices in a later survey.',
        15,
      ),
      step(
        'If you still need a count, send a short survey to one group',
        'Six questions at most, about the past. Say who you are and what you do with the answers.',
        45,
      ),
    ],
    doneWhen: 'At least 5 talks are done, and any survey you send has six questions or fewer about the past.',
    days: 10,
    template: {
      title: 'Six-question survey',
      body: '1. When did [problem] last happen to you? [today / this week / this month / longer / never]\n2. What did you do about it? [choices from your talks / other]\n3. What did you spend on it? [time] [money]\n4. What was the worst part? [choices from your talks / other]\n5. What have you stopped using, and why? [open]\n6. May I call you for 15 minutes? [contact]',
    },
    traps: ['Asking people to rate an idea from one to five.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 1, The Mom Test'),
      cite(
        'openstax-entrepreneurship',
        '8.2 Market Research, Market Opportunity Recognition, and Target Market',
      ),
      cite('sba-plan', 'Market research and competitive analysis'),
    ],
    next: ['interview-script', 'find-ten-people', 'synthesize-interviews'],
  },
  {
    id: 'beachhead',
    title: 'Choose the first group to serve',
    stage: 'discovery',
    intents: ['beachhead'],
    criteria: ['discovery-first-group'],
    answer:
      'Choose one small group and win it before you touch the next. Use three rules. They have the problem often. You can reach 20 of them without spending money. They talk to each other, so one happy customer brings the next. If two groups are tied, take the one you can meet in person this week. Saying no to the other groups is not losing them. It is putting them in order.',
    why: 'A small team can be the best choice for a narrow group and is never the best choice for everyone. Word of mouth works inside a group, not across strangers.',
    steps: [
      step(
        'List 3 to 5 groups from your interviews',
        'Make each one narrow enough that you know where they spend an evening.',
        20,
      ),
      step(
        'Score each group from 0 to 2 on the three rules',
        'How often they have it, how easily you reach 20, how much they talk to each other.',
        15,
      ),
      step(
        'Pick the top one and write where to find 20 of them',
        'Names, places or a list you can get this week.',
        30,
      ),
      step(
        'Write why each other group waits, in one line',
        'This stops you from sliding back to everyone.',
        10,
      ),
    ],
    doneWhen:
      'One group is named, 20 of them can be found this week, and each other group has a reason to wait.',
    days: 5,
    template: {
      title: 'First group score',
      body: 'Group | Has it often (0-2) | I can reach 20 (0-2) | They talk to each other (0-2) | Total\n[ ] | [ ] | [ ] | [ ] | [ ]\n[ ] | [ ] | [ ] | [ ] | [ ]\nFirst: [group]. Where to find 20: [places or list]\nWait: [group], because [reason]',
    },
    traps: [
      'Choosing the biggest group because the number looks good on a slide.',
      'Calling two groups one because you like both.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 2, Select a Beachhead Market'),
      cite('crossing-the-chasm', 'Ch. 4, Target the Point of Attack'),
    ],
    next: ['persona', 'value-proposition', 'market-size'],
  },
  {
    id: 'persona',
    title: 'Write one useful persona',
    stage: 'discovery',
    intents: ['persona'],
    criteria: ['discovery-first-group'],
    answer:
      'Use a real person, not an invented one. Pick the interviewee who is most like your first group, change the name, and write one page about them. Include the moment the problem happens, what they do now, what they spend, who they listen to, and what would make them say no. Leave out the age and hobbies unless they change a decision. Check the page with two more people before you use it.',
    why: 'A made-up persona agrees with everything you plan. One based on a real person argues back and keeps the team honest.',
    steps: [
      step(
        'Choose the interviewee closest to your first group',
        'The one who acted on the problem most recently.',
        10,
      ),
      step('Fill the one-page template from your notes', 'Put their exact words in at least two places.', 30),
      step('Read it to 2 others in the group and correct it', 'Ask which lines are not true for them.', 30),
    ],
    doneWhen: 'One page about one real person, with 2 quotes, checked by 2 others in the group.',
    days: 5,
    template: {
      title: 'Persona from a real person',
      body: 'Name (changed): [ ]  Role: [ ]\nThe moment it happens: [where, when, with whom]\nWhat they do now: [ ]  What it costs: [ ]\nWhat they are trying to get done: [ ]\nWho they listen to: [ ]\nWhat would make them say no: [ ]\nQuote 1: "[ ]"  Quote 2: "[ ]"',
    },
    traps: ['Three personas for a first product. One is enough.'],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 5 (persona for the beachhead market)'),
      cite('business-model-generation', 'Design: Customer Insights'),
    ],
    next: ['jobs-to-be-done', 'value-proposition', 'positioning'],
  },
  {
    id: 'jobs-to-be-done',
    title: 'Find the job your customer hires for',
    stage: 'discovery',
    intents: ['jobs-to-be-done'],
    criteria: ['discovery-pattern'],
    answer:
      'Ask what people were trying to get done when they bought the last thing, and what they stopped using when they did. That is the job. It is a piece of progress in a certain moment, and your product is hired to do it. Rebuild the story of three recent purchases step by step: the first thought, the push, the choice and the first use. Then write the job in one line and test your offer against it.',
    why: 'People buy to make progress, not to own features. Two people of the same age in the same class can hire for very different jobs.',
    steps: [
      step(
        'Find 3 people who bought or switched in the last 2 months',
        'Any product that solves your problem counts, also a homemade one.',
        30,
      ),
      step(
        'Ask each to retell the purchase from the first thought',
        'What was going on that day? What nearly stopped them? What did they stop using?',
        90,
      ),
      step(
        'Write the job in one line for each, and find the shared one',
        'When this happens, I want to do this, so I can have this.',
        20,
      ),
      step(
        'Check your offer against the job',
        'Cross out anything that does not help with that progress.',
        20,
      ),
    ],
    doneWhen:
      'Three purchase stories are written, with one shared job line and the parts of your offer that serve it.',
    days: 10,
    template: {
      title: 'Job line',
      body: 'Purchase story of [name], on [date]\nFirst thought: [ ]\nWhat pushed them: [ ]  What pulled them: [ ]\nWhat worried them: [ ]  What habit held them back: [ ]\nThey stopped using: [ ]\nJob: When [moment], I want to [progress], so I can [result].',
    },
    traps: ['Writing a feature as a job. Nobody has the job of using a dashboard.'],
    referral: null,
    citations: [
      cite('competing-against-luck', 'Ch. 4, Job Hunting'),
      cite('competing-against-luck', "Ch. 5, How to Hear What Your Customers Don't Say"),
      cite('innovators-solution', 'Ch. 3, What Products Will Customers Want to Buy?'),
    ],
    next: ['value-proposition', 'positioning', 'competitors'],
  },
  {
    id: 'competitors',
    title: 'Map competitors and alternatives',
    stage: 'discovery',
    intents: ['competitors'],
    criteria: ['discovery-alternatives'],
    answer:
      'Your strongest competitor is what people do today, and that is often nothing, a spreadsheet or asking a friend. List three things your interviewees really used, then two companies. For each, write what it costs the customer in money, time and hassle, and why they put up with it. You win only where you clearly beat the thing they use now. If someone tells you there is no competition, they have not asked the customer yet.',
    why: 'A customer compares you with their current habit. If you do not know the habit, you cannot say why they should change it.',
    steps: [
      step(
        'Write 3 things your interviewees used the last time',
        'Include doing nothing and homemade fixes.',
        15,
      ),
      step(
        'Find 2 companies with public pages that serve the same need',
        'Read their prices and their worst reviews. Keep the links.',
        45,
      ),
      step(
        'Fill the table and circle one line where you clearly win',
        'Use words a customer said. Mark anything you have not checked.',
        30,
      ),
      step('Ask 3 people what would make them switch', 'And what would make them go back. Write both.', 45),
    ],
    doneWhen:
      'Five alternatives are in the table with their cost to the customer, and one clear win is circled.',
    days: 7,
    template: {
      title: 'Alternatives table',
      body: 'Alternative | Used by (from interviews) | Costs them (money, time, hassle) | Good at | Bad at\n[doing nothing] | [ ] | [ ] | [ ] | [ ]\n[homemade fix] | [ ] | [ ] | [ ] | [ ]\n[company A, link] | [ ] | [ ] | [ ] | [ ]\n[company B, link] | [ ] | [ ] | [ ] | [ ]\nWe clearly win on: [one line], said by [names]',
    },
    traps: [
      'A grid of features where you tick every box.',
      'Saying there are no competitors because nobody has your exact product.',
    ],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '5.3 Competitive Analysis'),
      cite('disciplined-entrepreneurship', 'Step 11 (competitive position)'),
      cite('sba-plan', 'Market research and competitive analysis'),
    ],
    next: ['positioning', 'pricing', 'beachhead'],
  },
  {
    id: 'market-size',
    title: 'Size the market from the bottom up',
    stage: 'discovery',
    intents: ['market-size'],
    criteria: ['discovery-first-group'],
    answer:
      'Count customers, not a slice of a huge number. Take the first group you can name, count how many there are, and multiply by what one of them would pay you in a year. Then cut that to the ones you can reach with the team you have. Three numbers, each with its source beside it. A share of a giant market is a wish. A count you can check is an argument.',
    why: 'Investors and judges test how you got the number. A count with a source survives questions, and it also tells you who to call.',
    steps: [
      step(
        'Count the people or companies in your first group',
        'Use a list, a directory, a public data page or the registrar. Write where the number came from.',
        45,
      ),
      step(
        'Write what one of them would pay you in a year',
        'Use the price you tested, or what they spend now. Mark it as a guess if it is one.',
        15,
      ),
      step(
        'Multiply, then cut to the ones you can reach in a year',
        'How many talks a week can you hold, and how many of those buy? Use your own results.',
        20,
      ),
      step('Show low, middle and high', 'Change only the number you are least sure of.', 15),
    ],
    doneWhen: 'Three numbers exist, each with its source or the word guess next to it.',
    days: 5,
    template: {
      title: 'Bottom-up market size',
      body: 'Group: [first group]\nHow many: [count], from [source]\nPays per year: [price] x [times per year] = [amount], from [test or guess]\nWhole first group: [count] x [amount] = [total]\nCan reach in a year: [talks per week] x [weeks] x [share that buys, from my results] = [customers]\nFirst-year picture: [customers] x [amount] = [total]\nLow / middle / high: [ ] / [ ] / [ ]',
    },
    traps: [
      'Starting from a report about the whole industry and taking a small share of it.',
      'Counting money that flows through you as money you keep.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 4 (total addressable market for the beachhead)'),
      cite('sba-plan', 'Market research and competitive analysis'),
      cite(
        'openstax-entrepreneurship',
        '8.2 Market Research, Market Opportunity Recognition, and Target Market',
      ),
    ],
    next: ['pricing', 'pitch-deck', 'beachhead'],
  },
  {
    id: 'no-replies',
    title: 'Get answers when nobody replies',
    stage: 'discovery',
    intents: ['no-replies'],
    criteria: ['discovery-ten-conversations'],
    answer:
      'Change the message before you change the list. Cut it to four lines: why them, what you are learning, a 15-minute ask, two times. Then follow up once after three days, because a first message is easy to miss. If 20 good messages bring fewer than 3 answers, stop writing and go where they are in person. A no or a silence is not about you. You need one yes to get the next two names.',
    why: 'The programme teaches that everyone finds cold messages hard. It also says that people like to help students who ask for something small and clear.',
    steps: [
      step(
        'Rewrite the message in four lines',
        'First line is about them. Read it on a phone. If you have to scroll, cut it.',
        20,
      ),
      step(
        'Send 10 new ones and follow up with the old ones once',
        'One short line: did this reach you? Then let it go.',
        40,
      ),
      step('Ask 3 people you know for one introduction each', 'Send them two lines they can forward.', 20),
      step(
        'Go in person to one place where they gather',
        'Ask 5 people there for five minutes, right then.',
        90,
      ),
    ],
    doneWhen: '10 new messages, 3 introduction asks and one visit are done, and at least 3 talks are booked.',
    days: 7,
    template: {
      title: 'Four lines and a follow-up',
      body: 'Hi [name], I read that you [specific thing].\nI am a student learning how [type of person] handles [problem].\nCould I ask you about the last time, for 15 minutes?\n[Day, time] or [day, time] would work. [your name]\n\nThree days later: "Hi [name], did this reach you? A short no is fine too."\n\nTo forward: "[Friend] knows someone learning about [problem]. 15 minutes, nothing to sell. Open to it?"',
    },
    traps: ['A long message about you, your course and your product.'],
    referral: null,
    citations: [ain(AIN.networking1), ain(AIN.networking2), cite('mom-test', 'Ch. 6, Finding Conversations')],
    next: ['cold-outreach', 'networking', 'find-ten-people'],
  },
  {
    id: 'networking',
    title: 'Network as a student founder',
    stage: 'discovery',
    intents: ['networking'],
    criteria: [],
    answer:
      'Treat it as meeting people and learning their story, with one clear ask at the end. Prepare three things: who you are in one sentence, two questions about them, and the one thing you need. Go to one event a week, talk to three people and write to each within a day. Being a student helps you here. People remember being one. You do not need to be outgoing. You need to be prepared and to follow up.',
    why: 'The programme describes networking as building relationships over time. The follow-up is where most people stop and where you can stand out.',
    steps: [
      step(
        'Write your one sentence and your one ask for this month',
        'The ask could be an introduction, 15 minutes or feedback on one page.',
        15,
      ),
      step(
        'Pick one event and look up 3 people who will be there',
        'Find one thing you share: a class, a city, a club, a question.',
        20,
      ),
      step(
        'Talk to 3 people and let them talk first',
        'Ask what they work on and what is hard about it. Then say your sentence.',
        90,
      ),
      step(
        'Write to each within a day and log them',
        'Thank you, one thing you learned, one next step. Check in again in three months.',
        20,
      ),
    ],
    doneWhen: '3 new people are in your tracker, each thanked within a day, with one next step.',
    days: 7,
    template: {
      title: 'Connection note and tracker',
      body: 'Note: "Hi [name], I am [name], studying [subject] at [school]. I noticed [shared thing]. I am learning about [topic]. Would you have 15 minutes to tell me how you [their experience]?"\nThank you: "Thank you for your time. I will [what I learned and will do]. May I write again when it is done?"\nTracker: name | where met | what they care about | next step | next check-in date',
    },
    traps: ['Asking for a favor in the first line.', 'Collecting cards and never writing.'],
    referral: null,
    citations: [
      ain(AIN.networking1),
      ain(AIN.networking2),
      cite('openstax-entrepreneurship', '12.1 Building and Connecting to Networks'),
    ],
    next: ['find-mentor', 'cold-outreach', 'no-replies'],
  },
  {
    id: 'find-mentor',
    title: 'Find a mentor',
    stage: 'discovery',
    intents: ['find-mentor'],
    criteria: [],
    answer:
      'Start with the Ain Center, because it is set up for this. Ask for a Foundry Mentor, who is an alum who built something, and book an Entrepreneur in Residence for one hard decision. Do not ask anyone to be your mentor in the first message. Ask one good question, use the answer, and report back. After three rounds of that, you have a mentor. Aim for two people: one who knows your customers and one who has built a company.',
    why: 'Busy people help founders who act on advice. Reporting back is rare, and it earns the next meeting.',
    steps: [
      step(
        'Write the one decision you need help with',
        'A mentor match works when you can say what you are stuck on.',
        10,
      ),
      step(
        'Ask the program lead for a mentor or EIR who fits that decision',
        'Give two lines on the venture and the decision.',
        15,
      ),
      step(
        'Write to 2 alumni in your field with one question',
        'Find them through the alumni network or a professor.',
        40,
      ),
      step(
        'Report back within two weeks on what you did',
        'What they said, what you did, what happened.',
        15,
      ),
    ],
    doneWhen: 'One mentor or EIR session is booked, and 2 alumni have received one clear question.',
    days: 10,
    template: {
      title: 'Ask for a match',
      body: 'Hello [program lead],\nI am working on [one line]. I have [evidence so far]. I need help deciding [one decision] by [date]. Is there a Foundry Mentor or an EIR who has made that decision? I can send a one-page summary before we meet.\n[name]',
    },
    traps: ['Collecting five mentors and averaging their advice.'],
    referral: null,
    citations: [cite('ain-mentors'), cite('ain-eir'), ain(AIN.networking2)],
    next: ['mentor-prep', 'networking', 'find-cofounder'],
  },
  {
    id: 'mentor-prep',
    title: 'Prepare a mentor or EIR session',
    stage: 'discovery',
    intents: ['mentor-prep'],
    criteria: [],
    answer:
      'Send one page the day before, and bring one decision. The page says what you are trying to find out, what you did since last time, the numbers, and the choice you face with the option you prefer. Spend five minutes on the story and the rest on the choice. Leave with one thing you will do and a date. Never use the session for an update that could have been an email.',
    why: 'A mentor can judge a choice far better than a story. Saying your preferred option first makes the disagreement useful.',
    steps: [
      step(
        'Write the one page',
        'Goal, what you did, numbers, the choice, your preferred option, what worries you.',
        30,
      ),
      step(
        'Send it the day before with one question in the first line',
        'So the person can think about it, or bring someone who knows.',
        10,
      ),
      step('In the session, write down one action and a date', 'Say it back before you leave.', 45),
      step('Send a two-line report when it is done', 'What you did and what happened.', 10),
    ],
    doneWhen: 'The page was sent a day before, and you left with one action, a date and a report line.',
    days: 4,
    template: {
      title: 'One page for the session',
      body: 'My question: [one sentence]\nVenture: [one line]  Stage: [ ]\nSince last time I: [did], [did], [did not, because]\nNumbers: [talks], [sales], [left per sale], [hours]\nThe choice: [A] or [B]\nI lean to [A] because [reason]\nWhat worries me: [ ]\nWhat I will do after we talk: [filled in the session]',
    },
    traps: ['Asking what should I do with nothing tried yet.'],
    referral: null,
    citations: [
      cite('ain-eir'),
      ain(AIN.networking2),
      cite('openstax-entrepreneurship', '15.3 Seeking Help or Support'),
    ],
    next: ['find-mentor', 'what-next', 'networking'],
  },
  {
    id: 'find-cofounder',
    title: 'Find the right cofounder',
    stage: 'discovery',
    intents: ['find-cofounder'],
    criteria: [],
    answer:
      'Work together before you decide. Pick someone whose skills fill your gap and whose working style you have seen, give it a four-week project with a clear result, and only then talk about titles and shares. Look in classes, labs, clubs and past team projects first, then in events. Choose the person who does what they said over the person with the better resume. No fit after four weeks means you part as friends, and nothing has to be unwound.',
    why: 'A strong team improves a weak idea, and a weak team ruins a strong one. Small real work shows fit. A coffee does not.',
    steps: [
      step(
        'Write the two things you cannot do that the venture needs this term',
        'Be exact: sell to clinics, build the sensor, run the kitchen.',
        15,
      ),
      step(
        'List 10 people who have done one of them and ask 4 for a talk',
        'Classmates, lab mates, club leads, people your professors name.',
        60,
      ),
      step(
        'Agree a four-week trial with one result',
        'Write the result, the hours each gives and that nobody owns anything extra yet.',
        45,
      ),
      step(
        'Talk about the hard parts in week two',
        'Money needs, hours, graduation plans, how you argue and what you would stop for.',
        60,
      ),
    ],
    doneWhen: 'One person is on a written four-week trial, with a result, hours and a decision date.',
    days: 28,
    template: {
      title: 'Four-week trial',
      body: 'Between: [name] and [name]  From [date] to [date]\nResult we want: [one thing that will exist]\nHours each week: [ ] and [ ]\nWho decides what: [ ]\nWhat we make in the trial: [who may use it if we part; ask a lawyer before anything valuable]\nWe decide on: [date]. Questions to answer: do we keep promises, do we argue well, do we want the same thing?',
    },
    traps: [
      'Sharing the company with a friend on day one because it feels awkward to wait.',
      'Two founders with the same skill and nobody who sells.',
    ],
    referral: null,
    citations: [
      ain(AIN.mindset2),
      cite('founders-dilemmas', 'Relationship Dilemmas'),
      cite('openstax-entrepreneurship', '12.2 Building the Entrepreneurial Dream Team'),
    ],
    next: ['equity-split', 'cofounder-agreement', 'networking'],
  },
  {
    id: 'team-conflict',
    title: 'Handle a conflict in the team',
    stage: 'discovery',
    intents: ['team-conflict'],
    criteria: [],
    answer:
      'Have the talk this week, in person, about one thing that happened. Not about character. Say what you saw, what it did to the work and what you would like instead. Then ask for their side and write the agreement in three lines with a date to look at it again. If it is about money, shares or someone leaving, stop and bring your EIR. If anyone is being harassed, threatened or made unsafe, do not handle it alone. Contact the University now.',
    why: 'Most team conflict is about roles or promises that were never written. It grows in silence and shrinks when it is named early.',
    steps: [
      step(
        'Write the one event, its effect on the work and what you ask for',
        'One sentence each. Leave out always and never.',
        15,
      ),
      step(
        'Meet for 45 minutes and let the other person go first',
        'Repeat what you heard before you answer.',
        45,
      ),
      step('Write three lines: what each does, by when, when you check', 'Send it to both the same day.', 15),
      step(
        'If it is not better by the check date, ask your EIR to sit in',
        'Bring the three lines and what happened since.',
        30,
      ),
    ],
    doneWhen: 'The talk has happened, and three written lines with a check date are with both people.',
    days: 5,
    template: {
      title: 'The talk',
      body: '"On [date], [what happened]. The effect was [on the work]. I would like [request]. How do you see it?"\nAgreed: [name] does [ ] by [date]. [name] does [ ] by [date]. We check on [date].',
    },
    traps: ['Settling it in a group chat.', 'Getting the rest of the team on your side first.'],
    referral: REFERRALS.eir(
      'What happened with dates, what was agreed and what you want. For harassment or safety, go to the University (CARE Network) first.',
    ),
    citations: [
      ain(AIN.mindset2),
      cite('founders-dilemmas', 'Role Dilemmas'),
      cite('art-of-strategy', 'Cooperation and Coordination'),
    ],
    next: ['cofounder-agreement', 'mentor-prep', 'find-cofounder'],
  },
];
