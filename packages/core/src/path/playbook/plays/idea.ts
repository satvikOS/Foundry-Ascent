import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const IDEA_PLAYS: readonly Play[] = [
  {
    id: 'get-organized',
    title: 'Write your idea in five lines and book 3 talks',
    stage: 'idea',
    intents: ['get-organized'],
    criteria: ['idea-one-page'],
    answer:
      'Yes. Here is the whole path in four moves. Put the idea on one page. Talk to people who have the problem. Sell a small version by hand. Then build. You are on move one, so do not build, name or register anything yet. This week you write the page and book three conversations. That is enough to be organized.',
    why: 'A plan written before you talk to anyone is a list of guesses. One page with names next to it turns the guesses into things you can check.',
    steps: [
      step(
        'Write five lines: who, the problem, what they do today, your idea, why you',
        'One sentence each. If you cannot name a type of person, write down the last person you saw with the problem.',
        25,
      ),
      step(
        'List 10 people who had this problem in the last month',
        'Names, or places where you can find them. No more than 3 friends.',
        20,
      ),
      step(
        'Message 5 of them and book 3 talks',
        'Ask for 15 minutes to hear how they handle it now. Do not describe your idea in the message.',
        30,
      ),
      step(
        'Block two fixed hours a week for the venture',
        'Put them in your calendar like a class, so the work does not wait for free time.',
        5,
      ),
    ],
    doneWhen: 'Your five lines are written and 3 conversations are in your calendar.',
    days: 7,
    template: {
      title: 'The idea on one page',
      body: 'Who: [one type of person, with one real example]\nProblem: [what goes wrong, and when it last happened]\nToday they: [what they do about it now, and what that costs them]\nMy idea: [what I would do for them, in one sentence]\nWhy me: [what I know, have or can reach that others cannot]\nFirst 3 conversations: [name, day, time]',
    },
    traps: [
      'Buying a domain, a logo or a company before the first conversation.',
      'Writing a long plan when one page would show the same guesses.',
    ],
    referral: null,
    citations: [
      ain(AIN.discovery),
      cite('lean-startup', 'Ch. 4, Experiment'),
      cite('startup-owners-manual', 'Ch. 2, The Path to the Epiphany: The Customer Development Model'),
    ],
    next: ['idea-on-a-page', 'find-ten-people', 'interview-script'],
  },
  {
    id: 'start-from-zero',
    title: 'Write your first claim and ask 3 people about it',
    stage: 'idea',
    intents: ['start-from-zero'],
    criteria: ['idea-one-page'],
    answer:
      'You do not need a business degree to start. You need three answers. Who has the problem, what do they do about it today, and would they pay you to fix it. You find all three by talking to people, not by studying. If you study engineering or science, treat the idea like a hypothesis and the first month like an experiment. Start with one page, then three conversations this week.',
    why: 'The programme teaches that a founder knows very little at the start and learns the rest by getting out and listening. That skill is learned by doing it.',
    steps: [
      step(
        'Write the idea as a claim you could be wrong about',
        'Use this shape: I think this kind of person has this problem and pays this price in time or money today.',
        15,
      ),
      step(
        'Underline the part you are least sure of',
        'It is usually who the person is, or whether the problem bothers them enough to act.',
        5,
      ),
      step(
        'Ask 3 people with the problem about the last time it happened',
        'Listen for 10 minutes each. Write down their words, not your view of them.',
        60,
      ),
      step(
        'Learn one business word a day, only the ones you need',
        'This week: customer is who pays. Cost is what one sale uses up. Revenue is money that comes in.',
        15,
      ),
    ],
    doneWhen: 'Your claim is written, and you have notes from 3 people about the last time it happened.',
    days: 7,
    template: {
      title: 'Your first claim',
      body: 'I think [type of person] has trouble with [problem] when [moment].\nToday they [what they do now], which costs them [time, money or stress].\nI would be wrong if [what you would hear or see].\nThis week I ask: [name 1], [name 2], [name 3].',
    },
    traps: [
      'Waiting until you feel ready. The first three talks teach more than a month of videos.',
      'Reading about startups as a way to avoid talking to people.',
    ],
    referral: null,
    citations: [ain(AIN.mindset1), cite('openstax-entrepreneurship', '1.3 The Entrepreneurial Mindset')],
    next: ['idea-on-a-page', 'interview-script', 'time-with-classes'],
  },
  {
    id: 'what-next',
    title: 'Put one step in your calendar, with its day',
    stage: 'idea',
    intents: ['what-next'],
    criteria: [],
    answer:
      'Your next step is always the first open line of your stage, and you do only that one this week. The stages are idea, customers, proof, numbers, sales, growth and the move out of the Ain Center. You are in the first stage where something still has no evidence. One step, one date, one result. Anything else on your list waits until that line is closed.',
    why: 'Doing several stages at once feels busy and proves nothing. One open question at a time gives you an answer you can act on.',
    steps: [
      step(
        'Open your path and read the first line without evidence',
        'Evidence means a name, a number, a date or a signed thing. A feeling does not count.',
        5,
      ),
      step(
        'Put its first sub-step in your calendar this week',
        'Choose a day and an hour. A step without a time rarely happens in a week with classes.',
        5,
      ),
      step(
        'Move every other task to a later list',
        'Keep the list, so you lose nothing. Look at it again when the line is closed.',
        10,
      ),
    ],
    doneWhen: 'One step is in your calendar with a day, and you can say what result would close it.',
    days: 3,
    template: {
      title: 'My week',
      body: 'Stage: [name of the stage]\nOpen line: [what has no evidence yet]\nMy one step: [what I will do]\nWhen: [day and time]\nDone when: [what will exist]\nNot this week: [things I am parking]',
    },
    traps: ['Skipping to the fun stage, such as the app or the logo, while an earlier line has no evidence.'],
    referral: null,
    citations: [
      cite('startup-owners-manual', 'Ch. 2, The Path to the Epiphany: The Customer Development Model'),
      cite('lean-analytics', 'Ch. 5, Analytics Frameworks'),
    ],
    next: ['idea-on-a-page', 'biggest-reason-to-fail', 'find-ten-people'],
  },
  {
    id: 'real-business',
    title: 'Try to sell it to 20 strangers and count who pays',
    stage: 'idea',
    intents: ['real-business'],
    criteria: ['idea-biggest-risk'],
    answer:
      'Not yet. It is an idea until three things are true. Strangers want it enough to pay. One sale brings in more than it costs you to deliver it. And you can reach more people like them. Test the first two by hand, with no app. Sell 10 to people who are not friends this month, at a real price, and write down what each one cost you. If you cannot sell 10 by hand, software will not fix it.',
    why: 'A business gives value and gets paid for it in a way that works for both sides. A small hand-made sale shows both at once, and it is quick.',
    steps: [
      step(
        'Write the offer in one sentence, with a price',
        'Say what they get, when and for how much. Pick the price from what they spend on the problem now.',
        15,
      ),
      step(
        'Offer it in person to 20 people who are not friends',
        'Go where the problem happens. Ask for the money now, or for a paid order with a date.',
        120,
      ),
      step(
        'Deliver each sale by hand and time yourself',
        'Use what exists already: a phone, a form, a car. Write down every cost and every minute.',
        120,
      ),
      step(
        'Work out what is left from one sale',
        'Price, minus what you bought, minus fees, minus a fair rate for your time. Use your own numbers only.',
        20,
      ),
    ],
    doneWhen:
      'You have tried to sell to 20 strangers, and you know how many paid and what was left from one sale.',
    days: 14,
    template: {
      title: 'Is it a business yet',
      body: 'Offer: [what they get] for [price]\nAsked: [number of strangers]\nPaid: [number]\nWhy the others said no: [their words]\nLeft from one sale: [price] - [bought] - [fees] - [my time] = [left]\nHow I would reach 50 more: [place or list]',
    },
    traps: [
      'Counting people who say they would buy. Count only people who paid.',
      'Leaving your own hours out of the cost, so every sale looks good.',
    ],
    referral: null,
    citations: [
      ain(AIN.mindset2),
      ain(AIN.discovery),
      cite('openstax-entrepreneurship', '11.3 Conducting a Feasibility Analysis'),
    ],
    next: ['will-anyone-pay', 'unit-economics', 'biggest-reason-to-fail'],
  },
  {
    id: 'idea-on-a-page',
    title: 'Put the idea on one page',
    stage: 'idea',
    intents: ['idea-on-a-page'],
    criteria: ['idea-one-page'],
    answer:
      'Write five lines, not a plan. Who has the problem. What the problem is. What they do about it today. What you would do instead. Why you are the one to do it. Keep each line to one sentence a stranger can understand. Then mark every line as seen or guess. The first line marked guess is what you go and check this week.',
    why: 'One page makes the guesses visible, and it is fast to change. The same five lines become your pitch and your canvas later.',
    steps: [
      step(
        'Write the five lines in plain words',
        'No buzzwords. Read it to someone outside your major and ask them to say it back.',
        30,
      ),
      step(
        'Mark each line seen or guess',
        'Seen means you watched it or a real person told you about the last time it happened.',
        10,
      ),
      step(
        'Choose the one guess that would hurt most if wrong',
        'It is often the problem line. If the problem is small, the rest does not matter.',
        10,
      ),
      step(
        'Book one talk that could prove that guess wrong',
        'Message one person in the group today and ask for 15 minutes.',
        15,
      ),
    ],
    doneWhen:
      'Five lines are written, each is marked seen or guess, and one talk to check a guess is booked.',
    days: 4,
    template: {
      title: 'Five lines',
      body: '1. Who: [type of person] (seen / guess)\n2. Problem: [what goes wrong, how often] (seen / guess)\n3. Today: [what they do now and what it costs them] (seen / guess)\n4. Idea: [what I would do, in one sentence] (seen / guess)\n5. Why me: [what I know or can reach] (seen / guess)\nCheck first: line [number], with [name], on [day]',
    },
    traps: [
      'Writing the product first and then looking for people who might need it.',
      'Describing the customer as everyone, or all students.',
    ],
    referral: null,
    citations: [
      ain(AIN.mindset1),
      cite('business-model-generation', 'Canvas'),
      cite('openstax-entrepreneurship', '5.1 Entrepreneurial Opportunity'),
    ],
    next: ['customer-user-buyer', 'biggest-reason-to-fail', 'find-ten-people'],
  },
  {
    id: 'idea-or-problem',
    title: 'Write the problem without your product in it',
    stage: 'idea',
    intents: ['idea-or-problem'],
    criteria: ['idea-one-page'],
    answer:
      'Start from the problem. Ideas are easy to have, and people pay to have problems go away. A problem is real when a certain person hits it at a certain moment and already spends time or money on it. So rewrite your idea without the product in it. If nothing is left, you have a product looking for a problem, and you go and find the problem before you build.',
    why: 'The programme puts it simply: the work is solving real problems for people, and an idea on its own is cheap. Products change. The problem is what you keep.',
    steps: [
      step(
        'Write the problem without naming your product',
        'Shape: when this happens, this person cannot do this, so they do this instead.',
        15,
      ),
      step(
        'Find the cost of it today',
        'Ask 3 people what they did last time and what it took in money, minutes or stress.',
        60,
      ),
      step(
        'Rank it against their other problems',
        'Ask what else went wrong that week. If yours is not in their top three, try another group.',
        20,
      ),
    ],
    doneWhen: 'The problem is written without your product, with what it costs today from 3 real people.',
    days: 7,
    template: {
      title: 'Problem statement',
      body: 'When [moment], [type of person] tries to [what they want done].\nIt goes wrong because [cause].\nToday they [workaround], which costs [time, money, stress].\nThree people who told me so: [name, name, name].',
    },
    traps: ['Calling a missing feature a problem. Nobody has the problem of not owning your app.'],
    referral: null,
    citations: [
      ain(AIN.mindset1),
      cite('openstax-entrepreneurship', '6.1 Problem Solving to Find Entrepreneurial Solutions'),
      cite('competing-against-luck', 'Ch. 2, Progress, Not Products'),
    ],
    next: ['find-ten-people', 'jobs-to-be-done', 'idea-on-a-page'],
  },
  {
    id: 'pick-an-idea',
    title: 'Score your ideas and pick one',
    stage: 'idea',
    intents: ['pick-an-idea'],
    criteria: ['idea-one-page'],
    answer:
      'Pick the idea where you can talk to five people with the problem this week. That beats the cleverest idea, because access is what lets you learn. If two are tied, take the one where people already spend money on a workaround. Give that idea two weeks and leave the others on a list. You are not marrying it. You are choosing what to test first.',
    why: 'Ideas are hard to judge by thinking. The one you can test soonest gives you an answer while the others are still opinions.',
    steps: [
      step(
        'Score each idea from 0 to 2 on three questions',
        'Can I reach five people this week? Do they spend money or time on it now? Do I know this world?',
        20,
      ),
      step(
        'Pick the top score and write its five lines',
        'Who, problem, today, idea, why you. One sentence each.',
        20,
      ),
      step(
        'Book 5 talks for it in the next 7 days',
        'If you cannot book 5, the access score was wrong. Move to the next idea.',
        45,
      ),
    ],
    doneWhen:
      'One idea is chosen in writing, and 5 talks for it are booked or the next idea has been picked.',
    days: 5,
    template: {
      title: 'Idea score',
      body: 'Idea | I can reach 5 people (0-2) | They spend on it now (0-2) | I know this world (0-2) | Total\n[idea A] | [ ] | [ ] | [ ] | [ ]\n[idea B] | [ ] | [ ] | [ ] | [ ]\n[idea C] | [ ] | [ ] | [ ] | [ ]\nTwo weeks on: [chosen idea], until [date]',
    },
    traps: ['Working on three ideas at once, so each one gets an hour and none gets an answer.'],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '5.2 Researching Potential Business Opportunities'),
      cite('disciplined-entrepreneurship', 'Step 1, Market Segmentation'),
    ],
    next: ['idea-on-a-page', 'find-ten-people', 'biggest-reason-to-fail'],
  },
  {
    id: 'friends-love-it',
    title: 'Ask 20 strangers, not friends, to pay',
    stage: 'idea',
    intents: ['friends-love-it'],
    criteria: ['idea-biggest-risk', 'validation-commitment'],
    answer:
      'No, it is not enough. Friends say an idea is good because they like you. What counts is a stranger giving something up for it: money, a signature or an hour of their time. So set a small number and a date. Aim to sell 10 to people you do not know in the next two weeks, at a real price, with no app. If nobody pays, you have learned it early and for free.',
    why: 'Praise costs nothing, so it tells you nothing. What people do with their own money or time is the evidence.',
    steps: [
      step(
        'Write the offer and the price on one card',
        'What they get, when, and how they pay. A phone number or a simple form is enough.',
        20,
      ),
      step(
        'Ask 20 strangers who have the problem to buy now',
        'Stand where the problem happens. Say the price out loud and stop talking.',
        120,
      ),
      step(
        'Deliver to everyone who pays, by hand',
        'It may be slow and clumsy. That is fine for 10 people, and you will see what is hard.',
        120,
      ),
      step(
        'Write the count and the reasons people said no',
        'Paid out of asked. Next to each no, their own words.',
        15,
      ),
    ],
    doneWhen:
      'You asked at least 20 strangers for money and can say how many paid and why the others did not.',
    days: 14,
    template: {
      title: 'Stranger test',
      body: 'Offer: [what they get] for [price], ready by [time]\nWhere I ask: [place and day]\nAsked: [number]  Paid: [number]\nReasons for no: [their words]\nPass line, set today: [number] paid by [date]',
    },
    traps: [
      'Asking friends of friends. They are still being kind to you.',
      'Counting likes, sign-ups or a nice message as proof.',
    ],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 2, Avoiding Bad Data'),
      ain(AIN.discovery),
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
    ],
    next: ['will-anyone-pay', 'pre-sale', 'fake-compliments'],
  },
  {
    id: 'biggest-reason-to-fail',
    title: 'List what must be true and test the weakest part',
    stage: 'idea',
    intents: ['biggest-reason-to-fail'],
    criteria: ['idea-biggest-risk'],
    answer:
      'The most likely reason is that too few people want it enough to pay, because the way they cope today is good enough. Check that first, before technology, money or competitors. Write what must be true for this to work, and choose the one you have the least evidence for. Then run one small test this week that could prove you wrong. If it survives, move to the next one.',
    why: 'A venture stands on a few beliefs. Testing the one that would sink it first saves the most time, whichever way it goes.',
    steps: [
      step(
        'List 5 things that must be true',
        'Cover four areas: they want it, you can make it, it pays, and you are allowed to do it.',
        20,
      ),
      step(
        'Mark each one: evidence or hope, and fatal or fixable',
        'Evidence is something people did. Fatal means the idea ends if this is false.',
        10,
      ),
      step(
        'Take the fatal one with the least evidence and write its test',
        'What will you do, with how many people, and what result would make you change course?',
        20,
      ),
      step(
        'Run the test and write the result the same day',
        'Keep it small enough to finish in a week. Ask people to do something, not to give an opinion.',
        120,
      ),
    ],
    doneWhen:
      'Five beliefs are listed, one test for the weakest fatal one has run, and the result is written down.',
    days: 7,
    template: {
      title: 'What must be true',
      body: 'Belief | Evidence or hope | Fatal or fixable\n[people want it because...] | [ ] | [ ]\n[we can deliver it because...] | [ ] | [ ]\n[it pays because...] | [ ] | [ ]\n[we are allowed because...] | [ ] | [ ]\nTest first: [belief]\nTest: [what I will do, with how many people, by when]\nI change course if: [result]',
    },
    traps: [
      'Testing what is easy, such as whether you can build it, when wanting it is the open question.',
      'Deciding what the result means after you have seen it.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 2, Test: Hypothesize'),
      cite('lean-startup', 'Ch. 5, Leap'),
      cite('disciplined-entrepreneurship', 'Step 20 and Step 21 (key assumptions)'),
    ],
    next: ['experiment-design', 'find-ten-people', 'will-anyone-pay'],
  },
  {
    id: 'honest-read',
    title: 'Set how many strangers must pay and ask them',
    stage: 'idea',
    intents: ['honest-read'],
    criteria: ['idea-biggest-risk'],
    answer:
      'I will not call it great, because neither of us knows yet. Great is what strangers show with their money. Its strength is whatever you have seen people do about the problem so far. Its weak spot is what nobody has shown yet: that they want it enough to pay, and that one sale leaves money over. Prove it with 10 sales to strangers this month, by hand. Then you will not need my opinion.',
    why: 'Praise feels good and changes nothing. A small test with a number tells you what to do on Monday.',
    steps: [
      step(
        'Write the strongest point and the weakest point of the idea',
        'One sentence each, from what you have seen people do, not from what you hope.',
        10,
      ),
      step(
        'Choose a number of strangers who must buy, and a date',
        'Aim for 10. Write it down before you start, so the result cannot be argued with.',
        10,
      ),
      step(
        'Sell it by hand until the date',
        'No app. Say the price, take the money or the order, and deliver it yourself.',
        180,
      ),
      step(
        'Compare the result with your number',
        'Above it, continue. Below it, change the customer, the offer or the price, and try once more.',
        15,
      ),
    ],
    doneWhen:
      'You wrote a target number and a date first, and the real number of paying strangers is next to it.',
    days: 14,
    template: {
      title: 'Honest read',
      body: 'Strongest point, seen: [what people did]\nWeakest point, open: [what nobody has shown yet]\nProof I need: [number] strangers pay [price] by [date]\nResult: [number]\nSo I will: [continue / change what]',
    },
    traps: ['Asking enough people until someone says it is great, and stopping there.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 2, Avoiding Bad Data'),
      ain(AIN.networking1),
      cite('lean-startup', 'Ch. 3, Learn'),
    ],
    next: ['friends-love-it', 'biggest-reason-to-fail', 'will-anyone-pay'],
  },
  {
    id: 'customer-user-buyer',
    title: 'Name who uses it, who pays and who says yes',
    stage: 'idea',
    intents: ['customer-user-buyer'],
    criteria: ['idea-who-pays'],
    answer:
      'Name three people, even if two turn out to be the same. The user uses it. The customer pays for it. The buyer is the one who can say yes. With a cereal for children, the child eats it and the parent pays. Sell to the one who pays, and design for the one who uses. If a company or a department pays, find the person with the budget before you write a line of code.',
    why: 'Many student ideas please users who will never pay. Knowing who pays decides your price, your message and who you interview.',
    steps: [
      step(
        'Write the user, the customer and the buyer by name or job',
        'Use a real example of each. If you cannot name one, write unknown.',
        15,
      ),
      step(
        'Write what each one gets and what each one gives up',
        'Money, time, risk or effort. A user who gives up nothing can still say no.',
        15,
      ),
      step(
        'Talk to one person of each kind',
        'Ask the customer about the last thing they paid for to solve this, and who had to agree.',
        60,
      ),
    ],
    doneWhen: 'The three roles are filled with a real example each, and you have talked to one who pays.',
    days: 7,
    template: {
      title: 'Who is who',
      body: 'Role | Real example | Gets | Gives up\nUser | [name or job] | [ ] | [ ]\nCustomer (pays) | [name or job] | [ ] | [ ]\nBuyer (says yes) | [name or job] | [ ] | [ ]\nI sell to: [customer]. I design for: [user].',
    },
    traps: ['Interviewing only users, then finding out that nobody who pays cares.'],
    referral: null,
    citations: [
      ain(AIN.customerUser),
      cite('disciplined-entrepreneurship', 'Step 12 (decision-making unit)'),
    ],
    next: ['find-ten-people', 'b2b-selling', 'beachhead'],
  },
  {
    id: 'other-teams-privacy',
    title: 'Write one page on rivals from public facts',
    stage: 'idea',
    intents: ['other-teams-privacy'],
    criteria: [],
    answer:
      'I cannot tell you that. I do not see other founders here, and what they share stays with them, just as your work stays with you. I would not pass it on if I could. What you can do is better. Look at what is public, ask the Ain Center to introduce you if you both agree, and win on speed. The team that talks to 10 customers first learns what the other one is still guessing.',
    why: 'You need to be able to speak freely here, and so do they. A rival plan also tells you little. What customers do tells you a lot.',
    steps: [
      step(
        'Search what is public about similar products',
        'You need no names: search the problem in the words a customer would use, then the same words with "app", "service" or "alternative". Read the site, reviews and campus posts of what comes up. Write who they serve and what people complain about.',
        40,
      ),
      step(
        'Ask 5 customers what they use today',
        'Do not name the other team. Let people tell you what they tried and what went wrong.',
        75,
      ),
      step(
        'Choose one group or moment you will serve better',
        'A narrower group is easier to win than the same group with a longer feature list.',
        15,
      ),
      step(
        'If you want to meet them, ask the program lead for an introduction',
        'Both sides must agree. Decide first what you will not share.',
        10,
      ),
    ],
    doneWhen: 'You have notes from public sources and 5 customers, and one group you will serve first.',
    days: 7,
    template: {
      title: 'Ask for an introduction',
      body: 'Hello [program lead],\nI am working on [one line]. I heard another student may work on something close. I am not asking what they do. If they would like to meet, would you ask them and introduce us?\nThank you, [name]',
    },
    traps: [
      'Copying what you think another team is doing instead of asking customers.',
      'Sharing your own customer list or numbers in a first chat.',
    ],
    referral: null,
    citations: [ain(AIN.networking1), cite('openstax-entrepreneurship', '5.3 Competitive Analysis')],
    next: ['someone-has-my-idea', 'competitors', 'share-the-idea'],
  },
  {
    id: 'someone-has-my-idea',
    title: "Ask 5 of a rival's users what it does badly",
    stage: 'idea',
    intents: ['someone-has-my-idea'],
    criteria: ['discovery-alternatives'],
    answer:
      'Do not quit, and do not copy them. Someone else building it shows that the problem is real. It does not show that they serve your customer well. Find five of their users or near users, ask what still goes wrong, and choose one group they serve badly. If nobody complains and nobody would switch, that is your signal to change the idea. Give yourself two weeks to find out.',
    why: 'Large and early players chase the customers they already have. The group they ignore is often where a small team can win.',
    steps: [
      step(
        'Write what they do, for whom and at what price, from public pages',
        'Stay with facts you can link to. Mark the rest as unknown.',
        40,
      ),
      step(
        'Talk to 5 people who use them or looked at them',
        'Ask what made them choose or leave, and what they still do by hand.',
        75,
      ),
      step(
        'Name one group and one reason they would switch to you',
        'It must be a reason a customer said, not a feature you like.',
        20,
      ),
      step(
        'Offer your version to 5 people in that group',
        'Ask for a small commitment: money, a trial with a date, or an introduction.',
        60,
      ),
    ],
    doneWhen: 'You have 5 talks with their users, one group named, and 5 people were asked to switch.',
    days: 14,
    template: {
      title: 'Them and us',
      body: 'They serve: [group] with [offer] at [price]\nTheir users complain about: [quotes]\nGroup they serve badly: [group]\nReason to switch, in a customer\'s words: "[quote]"\nAsked to switch: [number]  Committed: [number]',
    },
    traps: ['Adding features to look different. Choose a different customer or moment instead.'],
    referral: null,
    citations: [
      cite('innovators-solution', 'Ch. 4, Who Are the Best Customers for Our Products?'),
      cite('innovators-dilemma', 'Ch. 6, Match the Size of the Organization to the Size of the Market'),
      ain(AIN.networking1),
    ],
    next: ['competitors', 'positioning', 'beachhead'],
  },
  {
    id: 'share-the-idea',
    title: 'List what you share and what you keep to yourself',
    stage: 'idea',
    intents: ['share-the-idea'],
    criteria: [],
    answer:
      'Share the problem freely and keep the secret part to yourself. Do not ask people to sign a secrecy agreement for a first talk. Most will say no, and you lose the feedback. People are busy with their own work. One exception matters. If there is an invention in it, such as a device, a drug or a new method, talk to UR Ventures before you show how it works to anyone.',
    why: 'The programme is blunt about this: hiding an idea slows you down far more than sharing it. But making an invention public can limit patent rights.',
    steps: [
      step(
        'Split your idea into the part to share and the part to keep',
        'Share the problem, the group and the result. Keep the method, the code and the data.',
        15,
      ),
      step(
        'Write a 30-second version with only the part to share',
        'Say who has the problem and what changes for them. Leave out how it works inside.',
        15,
      ),
      step(
        'Tell it to 5 people who have the problem',
        'End with a question about their last time, not with: do you like it?',
        60,
      ),
    ],
    doneWhen: 'The two lists are written, and 5 people with the problem have heard the safe version.',
    days: 5,
    template: {
      title: 'What I share',
      body: 'I share: [who], [problem], [result for them]\nI keep: [method, code, formula, data, partner names]\n30 seconds: "I work on [problem] for [who]. Today they [workaround]. I am trying to [result]. How did you handle it the last time?"',
    },
    traps: [
      'Telling one close friend and calling it feedback.',
      'Showing how an invention works at a poster, a class or online before getting advice.',
    ],
    referral: null,
    citations: [
      ain(AIN.networking1),
      cite('uspto-provisional'),
      cite('openstax-entrepreneurship', '7.4 Protecting Your Idea and Polishing the Pitch through Feedback'),
    ],
    next: ['find-ten-people', 'patent-now-or-wait', 'interview-script'],
  },
  {
    id: 'student-ip',
    title: 'Write the timeline of the lab work and book UR Ventures',
    stage: 'idea',
    intents: ['student-ip', 'lab-work-said'],
    criteria: [],
    answer:
      'I cannot tell you who owns it, and please do not guess. This is general information, not legal advice, and I am not a lawyer. The University of Rochester policy covers students too. It says the University owns an invention that made significant use of its resources or came out of sponsored research. So the facts decide: what you used, who paid and what you signed. Ask UR Ventures, the technology transfer office, this week and before you publish or pitch it.',
    why: 'Ownership changes who may sell it and who may invest in it. Sorting it out early is simple. Sorting it out after a deal is not.',
    steps: [
      step(
        'Write the timeline of who did what, where and when',
        'Include the lab, the equipment, the grant or class, and everyone who had a part in the idea.',
        40,
      ),
      step(
        'Collect what you signed',
        'Employment or assistantship papers, sponsored research terms, class or competition rules.',
        30,
      ),
      step(
        'Contact UR Ventures and ask for a meeting',
        'Say you may have an invention and want to know the next step. Do not attach how it works.',
        15,
      ),
      step(
        'Hold back posters, demos and posts about how it works',
        'Policy asks for disclosure to UR Ventures before any other disclosure. Pitch the problem meanwhile.',
        5,
      ),
    ],
    doneWhen: 'Your timeline and papers are in one folder, and a meeting with UR Ventures has a date.',
    days: 7,
    template: {
      title: 'Email to UR Ventures',
      body: 'Subject: Student question on who owns an invention\nHello,\nI am a [year, school] student. Part of my work on [general area, no details] happened in [lab] with [supervisor], between [dates]. I used [equipment, funds, data, in general terms]. I signed [list, or nothing that I know of].\nCould we meet to find out who owns it and what I should do before I share it?\nThank you, [name]',
    },
    traps: [
      'Assuming it is yours because it was your idea, or not yours because it was a lab.',
      'Promising the technology to a cofounder, customer or investor before ownership is clear.',
    ],
    referral: REFERRALS.urVentures(
      'A one-page timeline, the lab and its funding, everyone involved, papers you signed, and any talk or post already made about it.',
    ),
    citations: [cite('ur-ip-policy'), cite('uspto-basics')],
    next: ['patent-now-or-wait', 'share-the-idea', 'biotech-path'],
  },
  {
    id: 'sign-ip-form',
    title: 'Have the IP form read by UR Ventures or a lawyer',
    stage: 'idea',
    intents: ['sign-ip-form'],
    criteria: [],
    answer:
      'I will not tell you to sign it or not to, because I am not a lawyer and this is general information, not legal advice. What I can give you is the order. Ask the lab for a copy and a few days to read it. Ask UR Ventures, the technology transfer office, what it does to the idea you have now and to the ones you have later. Then ask a lawyer who works for you and not for the lab. They can answer yes or no. I cannot.',
    why: 'A form like this can decide who owns what you make now and later. Asking first costs you a few days. A wrong signature can cost you the idea.',
    steps: [
      step(
        'Ask for a copy of the form and the date it is due',
        'Say you want to read it first. Nobody can fairly refuse you that.',
        10,
      ),
      step(
        'Mark each line that says what is theirs, from when and for what',
        'Look for words like assign, own, future, improvements and all work.',
        30,
      ),
      step(
        'Send UR Ventures the form and your question',
        'Ask what it does to work you did before, and to work outside the lab.',
        15,
      ),
      step(
        'Ask the program lead for a lawyer who works for you',
        'The lab and the university have their own. You need one on your side for an hour.',
        15,
      ),
    ],
    doneWhen:
      'You have the form, your marked lines, and an answer from UR Ventures or a lawyer who works for you.',
    days: 5,
    template: {
      title: 'Ask for time to read it',
      body: 'Hello [name],\nThank you for the form. I want to read it with someone before I answer. Could you send me a copy and tell me the date you need it by?\nThank you, [your name]',
    },
    traps: [
      'Signing in the meeting because everyone else did.',
      'Refusing it outright, when a question to the office would have settled it.',
    ],
    referral: REFERRALS.urVentures(
      'The form itself, the lines you marked, what you made before it, and who paid for the work.',
    ),
    citations: [cite('ur-ip-policy'), cite('uspto-basics')],
    next: ['student-ip', 'patent-now-or-wait'],
  },
  {
    id: 'biotech-path',
    title: 'Write what it is for in one sentence and book UR Ventures',
    stage: 'idea',
    intents: ['biotech-path'],
    criteria: ['idea-biggest-risk'],
    answer:
      'Yours is the science path, and it has the same stages in a different order. First, find out who owns the work. Second, find out which rules apply. Third, talk to the people who would use it and pay for it: clinicians, hospitals, labs or drug companies. Do the first two with UR Ventures and a regulatory specialist. Do the third yourself, starting this week. Plan on grants before investors. This is orientation, not regulatory advice.',
    why: 'A device, a drug and a lab tool follow different rules, and the rules decide time and money. Knowing which one you are comes before any plan.',
    steps: [
      step(
        'Write in one sentence what it is for and who it touches',
        'Is it a tool for labs, a test, a device, a drug or software? This wording drives the rules, so keep it exact.',
        20,
      ),
      step(
        'Book UR Ventures about ownership and protection',
        'Do this before a paper, a poster or a pitch shows how it works.',
        15,
      ),
      step(
        'Talk to 5 people who would use it or pay for it',
        'Ask how it is done today, what would have to change and who decides.',
        150,
      ),
      step(
        'Ask about I-Corps and SBIR or STTR',
        'I-Corps trains science teams to move from the lab to the market. SBIR and STTR fund development without taking shares.',
        30,
      ),
    ],
    doneWhen:
      'The one-sentence use is written, UR Ventures has a date, and 5 users or payers have been interviewed.',
    days: 21,
    template: {
      title: 'Science venture, page one',
      body: 'It is for: [use], on [who or what]\nIt is a: [device / drug / test / lab tool / software]\nMade with: [lab, grant, partners]\nOwnership meeting: [date with UR Ventures]\nRules question for the specialist: [one question]\nUsers and payers to ask: [name, role] x 5\nMoney for the next proof: [grant to ask about]',
    },
    traps: [
      'Talking only to scientists. The person who pays may be a hospital or a company.',
      'Telling people what it treats or cures before a specialist has read the wording.',
    ],
    referral: REFERRALS.regulatory(
      'One sentence on the intended use, the data you have, who owns the work, and your question on which path applies.',
    ),
    citations: [cite('fda-devices'), cite('fda-drugs'), cite('nsf-icorps'), cite('sbir')],
    next: ['student-ip', 'regulated-data', 'grants-angels-vc'],
  },
  {
    id: 'no-tech-skills',
    title: 'Run it by hand for 8 people',
    stage: 'idea',
    intents: ['no-tech-skills'],
    criteria: ['idea-biggest-risk'],
    answer:
      'Start without one. You do not need a developer to find out if people want it. Run it by hand with a form, a spreadsheet, a phone and a payment link, and sell to 10 people. Then look for a technical partner with that proof in your hand. Good builders join evidence. They rarely join an idea. Do not pay someone to build an app before anyone has paid you.',
    why: 'Code is the slowest way to test whether people care. A hand-run version answers the question and makes the later build smaller.',
    steps: [
      step(
        'Write what the product does as steps a person could do',
        'For each step, name the tool you already have: form, sheet, message, phone.',
        30,
      ),
      step(
        'Run it by hand for 3 people this week',
        'Tell them it is an early version that you run yourself.',
        180,
      ),
      step(
        'Charge the next 5 people a real price',
        'If they pay for a clumsy version, you have something to show a builder.',
        120,
      ),
      step(
        'Show the proof to 3 possible builders',
        'Share the numbers, the steps and what breaks. Ask to try two weeks of work together first.',
        60,
      ),
    ],
    doneWhen:
      '8 people have used the hand-run version, at least some paid, and 3 builders have seen the result.',
    days: 21,
    template: {
      title: 'Run it by hand',
      body: 'Step a user sees | What I do behind it | Tool I have\n[asks for it] | [read and reply] | [form, message]\n[pays] | [check payment] | [payment link]\n[gets it] | [deliver] | [ ]\nPeople served: [number]  Paid: [number]  What broke: [ ]',
    },
    traps: ['Giving away a large share of the company for a first version of an app.'],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Select an Experiment'),
      ain(AIN.mindset2),
      ain(AIN.discovery),
    ],
    next: ['concierge-test', 'find-cofounder', 'smallest-test'],
  },
  {
    id: 'time-with-classes',
    title: 'Put two venture blocks a week in your calendar',
    stage: 'idea',
    intents: ['time-with-classes'],
    criteria: [],
    answer:
      'Give it two fixed blocks a week, and one promise per week that fits in them. Not free time, because there is none. Use one block for customers and one for making. In exam weeks, do one customer message a day and nothing else. If the venture needs more than your blocks for three weeks in a row, cut the task in half before you cut sleep or classes.',
    why: 'Small weekly proof beats a burst every month. A fixed slot also makes it clear what you can promise to others.',
    steps: [
      step(
        'Put two blocks of 90 minutes in your calendar until the end of term',
        'Same days each week. Tell your team and your roommates.',
        15,
      ),
      step(
        'Mark exam weeks and deadlines now',
        'In those weeks the venture gets 15 minutes a day, only for messages.',
        15,
      ),
      step(
        'Write one promise for this week',
        'It must fit in the two blocks and end in something you can show: a name, a number, a file.',
        10,
      ),
      step(
        'Review for 10 minutes every Sunday',
        'Kept, missed or changed, and why. Then write the next promise.',
        10,
      ),
    ],
    doneWhen:
      'Two weekly blocks and the exam weeks are in your calendar, and this week has one written promise.',
    days: 2,
    template: {
      title: 'Founder week',
      body: 'Block 1 (customers): [day, time]\nBlock 2 (making): [day, time]\nQuiet weeks: [exam dates]\nThis week I promise: [one thing]\nSunday review: kept / missed / changed, because [reason]',
    },
    traps: ['Counting hours worked. Count things proven.'],
    referral: null,
    citations: [
      cite('high-growth-handbook', 'Ch. 1, The role of the CEO'),
      cite('openstax-entrepreneurship', '10.3 The Challenging Truth about Business Ownership'),
    ],
    next: ['what-next', 'stuck', 'find-cofounder'],
  },
  {
    id: 'stuck',
    title: 'Do the 15-minute version of what you are avoiding',
    stage: 'idea',
    intents: ['stuck'],
    criteria: [],
    answer:
      'Shrink it until it is too small to avoid. Being stuck nearly always means the next step is too big or you are dreading one conversation. So take the thing you have put off and do a 15-minute version today. Send one message, or call one customer who was kind. Then tell me what happened. If it is more than the venture, and you feel low most days, talk to someone at the Counseling Center. That comes first.',
    why: 'The programme teaches that your view of the situation is the part you control. Action on one small thing changes that view faster than thinking does.',
    steps: [
      step(
        'Write the one thing you are avoiding',
        'Be exact. Not marketing, but: I have not answered the manager who wrote on Tuesday.',
        5,
      ),
      step(
        'Do a 15-minute version of it today',
        'One message, one call, one paragraph. Stop when the time is up.',
        15,
      ),
      step(
        'Tell one person what you will finish, and the day',
        'A teammate, a mentor or your EIR. A promise to a person is easier to keep.',
        10,
      ),
    ],
    doneWhen: 'The 15-minute version is done, and one person knows what you will finish and on which day.',
    days: 2,
    template: {
      title: 'Unstuck in four lines',
      body: 'I am avoiding: [exact thing]\nBecause: [what I fear will happen]\n15-minute version: [what I do today]\nI told: [name] that I will finish [thing] by Friday',
    },
    traps: [
      'Starting a new idea to escape a hard conversation in this one.',
      'Pushing on when what you need is rest or help.',
    ],
    referral: null,
    citations: [
      ain(AIN.mindset1),
      cite('ur-counseling'),
      cite('openstax-entrepreneurship', '10.2 Why Early Failure Can Lead to Success Later'),
    ],
    next: ['time-with-classes', 'what-next', 'mentor-prep'],
  },
  {
    id: 'job-or-startup',
    title: 'Write the date and the numbers that decide job or startup',
    stage: 'idea',
    intents: ['job-or-startup'],
    criteria: [],
    answer:
      'Keep school and any paid work, and test the venture beside them until strangers pay you. Do not drop anything for an idea with no customers. Set one line now: if a certain number of strangers pay by a certain date, you give it more time, and if not, you take the job with a clear head. Founders work in companies too. The same skill, listening to customers and solving their problem, counts in both places.',
    why: 'The choice feels huge because it is made without facts. A line with a number and a date turns it into a decision you can make calmly.',
    steps: [
      step(
        'Write the date when you must decide',
        'The job offer, the internship deadline or the end of term.',
        5,
      ),
      step(
        'Write what must be true by then for you to choose the venture',
        'Use paying strangers, money saved and who is on the team. Set the numbers yourself.',
        20,
      ),
      step(
        'Work out how many months you could live without pay',
        'Your savings divided by what you spend in a month. Use your own bank figures.',
        20,
      ),
      step(
        'Talk it through with one mentor who did each',
        'One who took a job first, one who started right away. Ask what they would do differently.',
        60,
      ),
    ],
    doneWhen:
      'A decision date and the numbers that decide it are written, and you have talked to two people.',
    days: 10,
    template: {
      title: 'My decision line',
      body: 'I decide on: [date]\nI choose the venture if: [number] strangers pay, [amount] saved, [team]\nIf not, I: [job, internship, study]\nMonths I can live without pay: [savings] / [monthly spend] = [months]\nPeople I asked: [name], [name]',
    },
    traps: ['Choosing by how excited you are this week.'],
    referral: null,
    citations: [
      ain(AIN.mindset2),
      cite('founders-dilemmas', 'Career Dilemmas'),
      cite('openstax-entrepreneurship', '2.3 Entrepreneurial Pathways'),
    ],
    next: ['will-anyone-pay', 'time-with-classes', 'after-graduation'],
  },
  {
    id: 'foundry-path',
    title: 'Put your next Foundry due date in your calendar',
    stage: 'idea',
    intents: ['foundry-path'],
    criteria: [],
    answer:
      'The Foundry has three modules, and each ends in one thing you hand in. Module 1 ends with your Business Model Canvas. Module 2 ends with your pitch. Module 3 ends with your business plan. Do them with your real venture, so each capstone is a by-product of work you need anyway. The programme changes as it goes, so check the current list and dates on Blackboard or the Mentorship Hub.',
    why: 'The capstones are easy when they report what you learned from customers. They are hard when they are written from imagination.',
    steps: [
      step(
        'Open Blackboard and write the next due item and its date',
        'The checklist there is the current one. Ask the program lead if two lists disagree.',
        10,
      ),
      step(
        'Match that item to what your venture needs this month',
        'For example, the canvas can hold what your first interviews showed.',
        15,
      ),
      step(
        'Book one mentor or EIR session before the due date',
        'Bring a draft, so the session is about your choices and not about the form.',
        15,
      ),
    ],
    doneWhen: 'The next due item and date are in your calendar, and one session before it is booked.',
    days: 5,
    template: {
      title: 'My Foundry plan',
      body: 'Module: [1, 2 or 3]\nNext item due: [item], on [date from Blackboard]\nWhat my venture needs this month: [line]\nHow the item helps: [line]\nSession booked: [who, when]',
    },
    traps: ['Doing the videos and quizzes and leaving the customer work for later.'],
    referral: null,
    citations: [cite('ain-curriculum', 'Roadmap: three modules, three capstones'), cite('ain-mentors')],
    next: ['ain-canvas-capstone', 'ain-pitch-capstone', 'ain-plan-capstone'],
  },
  {
    id: 'name-and-brand',
    title: 'Choose one working name and check that it is free',
    stage: 'idea',
    intents: ['name-and-brand'],
    criteria: [],
    answer:
      'Use a plain working name this week and spend no money on it. The name does not decide whether people buy, and you will know your customer better in a month. Pick something you can say on the phone and that tells what you do. Search the web, the app stores and the federal trademark search for someone in the same business. If you want to keep the name for real, ask a lawyer before you print it. Skip the logo until strangers pay.',
    why: 'A name can be changed while you have ten customers. A clash with a known mark is costly later, and only a lawyer can judge it.',
    steps: [
      step('Write 5 plain names and say each on the phone to someone', 'Keep the ones they could spell.', 20),
      step(
        'Search each one: web, app stores, social accounts, trademark search',
        'Note anyone in the same kind of business.',
        30,
      ),
      step(
        'Choose one as a working name and move on',
        'Buy a domain only if it is a small, easy cost for you.',
        10,
      ),
    ],
    doneWhen: 'One working name is chosen, its search notes are saved, and no money has gone into a logo.',
    days: 2,
    template: {
      title: 'Name check',
      body: 'Name | Spelled right on the phone | Web clash | App store clash | Trademark search clash\n[ ] | [ ] | [ ] | [ ] | [ ]\nWorking name: [ ], until [date]\nQuestion for a lawyer later: [ ]',
    },
    traps: ['A week on the logo instead of three conversations.'],
    referral: null,
    citations: [cite('uspto-basics'), cite('openstax-entrepreneurship', '8.4 Entrepreneurial Branding')],
    next: ['idea-on-a-page', 'find-ten-people', 'legal-structure'],
  },
  {
    id: 'social-venture',
    title: 'Help 10 people and name a price to 2 payers',
    stage: 'idea',
    intents: ['social-venture'],
    criteria: ['idea-who-pays'],
    answer:
      'Decide who pays before you decide what you are. If the people you help can pay, start as a simple business and test it like one. If someone else pays for them, such as a school, a city or a donor, then that payer is your customer, and you test the offer on them. Whether it becomes a nonprofit or a company is a question for a lawyer, and it can wait. First show one change in the lives of ten people, and one payer who wants more of it.',
    why: 'Good intentions do not pay for next year. A social venture has two promises to test: the change it makes and who keeps paying for it.',
    steps: [
      step(
        'Write the change you want, for whom, and how you would see it',
        'One thing you can count in 4 weeks.',
        20,
      ),
      step('Help 10 people by hand and measure the change', 'Before and after, in the same words.', 300),
      step(
        'Ask 5 possible payers what they fund now and why',
        'Schools, city offices, foundations, companies.',
        150,
      ),
      step('Offer the result to 2 of them with a price', 'Cost per person helped, from your own log.', 45),
    ],
    doneWhen: '10 people were helped with a before and after, and 2 payers have heard a price.',
    days: 28,
    template: {
      title: 'Two promises',
      body: 'Change: [what] for [whom], seen by [measure]\nPerson | Before | After\n[ ] | [ ] | [ ]\nCost per person helped: [my hours] + [money] / [people] = [ ]\nPayer | Funds now | Why | Heard price | Answer\n[ ] | [ ] | [ ] | [ ] | [ ]',
    },
    traps: ['Filing for a nonprofit before anyone has been helped.'],
    referral: null,
    citations: [
      ain(AIN.customerUser),
      cite('openstax-entrepreneurship', '3.2 Corporate Social Responsibility and Social Entrepreneurship'),
    ],
    next: ['customer-user-buyer', 'grants-angels-vc', 'legal-structure'],
  },
];
